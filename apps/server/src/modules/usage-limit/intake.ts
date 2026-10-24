import { createHash } from 'node:crypto';
import type { ManualUsageLimitRequest, Provider } from '@noidle/resume-contracts';
import type { Clock } from '../../shared/clock.ts';
import { newId } from '../../shared/ids.ts';
import { redact } from '../../shared/redact.ts';
import type { SessionsRepo, SessionRow } from '../../persistence/repos/sessions.ts';
import type { EventsRepo, UsageEventRow } from '../../persistence/repos/events.ts';
import { parseLimitMessage, type ParsedLimit } from '../limit/detector.ts';
import { isSupportedTimezone, zonedTimeToUtc } from '../limit/timezone.ts';
import type { SettingsService } from '../settings/settingsService.ts';
import type { TaskService } from '../tasks/taskService.ts';
import type { EventBus } from '../../shared/bus.ts';
import { toUsageEventDto } from '../../shared/mappers.ts';

export interface IntakeOutcome {
  recorded: boolean;
  taskCreated: boolean;
  reason?: string;
  event?: UsageEventRow;
  /** 本次事件创建（或已存在的活动）任务。 */
  task?: import('../../persistence/repos/tasks.ts').ResumeTaskRow;
}

export interface IntakeDeps {
  sessions: SessionsRepo;
  events: EventsRepo;
  settings: SettingsService;
  tasks: TaskService;
  bus: EventBus;
  clock: Clock;
}

/**
 * 限额事件收纳（设计书 §6）：转写帧与人工登记共用同一条入路。
 *  - 未登记会话的事件一概不落库（数据最小化，§11.2）。
 *  - 已登记未启用：记事件、不建任务（§5.2 启用语义）。
 *  - event_hash 稳定去重：429 重试风暴产生的同窗口多帧只记一次。
 */
export class UsageLimitIntake {
  constructor(private deps: IntakeDeps) {}

  /** 转写监听回调入口：帧为 JSONL 解析后的对象。 */
  handleTranscriptFrame(
    sessionId: string,
    projectPath: string,
    frame: unknown,
  ): IntakeOutcome {
    const parsed = extractApiError(frame);
    if (!parsed) return { recorded: false, taskCreated: false };
    const limit = parseLimitMessage(parsed.errorText);
    if (!limit) return { recorded: false, taskCreated: false };
    return this.record({
      sessionId,
      projectPath,
      limit,
      source: 'transcript',
      detectedAt: parsed.timestamp ?? this.deps.clock.now().toISOString(),
    });
  }

  /** 人工登记（设计书 §9.3）。 */
  handleManual(input: ManualUsageLimitRequest): IntakeOutcome {
    const provider: Provider = input.provider ?? 'zhipu-glm';
    const rawText =
      input.rawMessage ??
      `Request rejected (${input.httpStatus ?? 429}) · [${input.providerCode ?? '1308'}][人工登记]`;
    const limit = parseLimitMessage(rawText);
    let resetAtRaw: string | null = limit?.resetAtRaw ?? null;
    if (input.resetAt) {
      resetAtRaw = input.resetAt; // 人工给的时刻优先
    }
    const effective: ParsedLimit = {
      httpStatus: input.httpStatus ?? limit?.httpStatus ?? null,
      providerCode: input.providerCode ?? limit?.providerCode ?? null,
      resetAtRaw,
      rawMessage: rawText,
      confidence: 'high',
    };
    if (!effective.httpStatus && !effective.providerCode) {
      return { recorded: false, taskCreated: false, reason: 'VALIDATION_ERROR' };
    }
    return this.record({
      sessionId: input.sessionId,
      projectPath: input.projectPath,
      limit: effective,
      source: 'manual',
      detectedAt: this.deps.clock.now().toISOString(),
      provider,
    });
  }

  private record(opts: {
    sessionId: string;
    projectPath: string;
    limit: ParsedLimit;
    source: 'transcript' | 'manual';
    detectedAt: string;
    provider?: Provider;
  }): IntakeOutcome {
    const provider = opts.provider ?? 'zhipu-glm';
    const session = this.deps.sessions.byBusinessKey(
      provider,
      opts.sessionId,
      opts.projectPath,
    );
    if (!session) {
      return { recorded: false, taskCreated: false, reason: '未登记会话，事件丢弃' };
    }

    const now = this.deps.clock.now();
    const tz = this.deps.settings.get().timezone;
    let resetAtIso: string | null = null;
    if (opts.limit.resetAtRaw) {
      try {
        resetAtIso = isSupportedTimezone(tz)
          ? zonedTimeToUtc(opts.limit.resetAtRaw, tz).toISOString()
          : new Date(opts.limit.resetAtRaw.replace(' ', 'T') + 'Z').toISOString();
      } catch {
        resetAtIso = null; // 解析失败 → 任务 paused 等人工（§6.2）
      }
    }

    // 稳定哈希：同限额外的重试帧 reset_at 相同 → 哈希相同
    const hashBasis = [
      provider,
      opts.sessionId,
      opts.projectPath,
      opts.limit.providerCode ?? '',
      opts.limit.httpStatus ?? '',
      resetAtIso ?? minuteBucket(opts.detectedAt),
    ].join('|');
    const eventHash = createHash('sha256').update(hashBasis).digest('hex');

    if (this.deps.events.byHash(eventHash)) {
      return { recorded: false, taskCreated: false, reason: 'duplicate' };
    }

    const row: UsageEventRow = {
      id: newId(),
      provider,
      session_id: opts.sessionId,
      project_path: opts.projectPath,
      http_status: opts.limit.httpStatus,
      provider_code: opts.limit.providerCode,
      reset_at: resetAtIso,
      reset_at_raw: opts.limit.resetAtRaw,
      reset_tz: opts.limit.resetAtRaw ? tz : null,
      detected_at: opts.detectedAt,
      source: opts.source,
      confidence: opts.limit.confidence,
      raw_message: redact(opts.limit.rawMessage),
      event_hash: eventHash,
      created_at: now.toISOString(),
    };
    if (
      !this.deps.events.insert({
        id: row.id,
        provider: row.provider,
        session_id: row.session_id,
        project_path: row.project_path,
        httpStatus: row.http_status,
        providerCode: row.provider_code,
        resetAt: row.reset_at,
        resetAtRaw: row.reset_at_raw,
        resetTz: row.reset_tz,
        detectedAt: row.detected_at,
        source: row.source,
        confidence: row.confidence,
        rawMessage: row.raw_message,
        eventHash: row.event_hash,
      })
    ) {
      return { recorded: false, taskCreated: false, reason: 'duplicate' };
    }
    this.deps.bus.emit('event.detected', toUsageEventDto(row));

    if (session.enabled !== 1) {
      return {
        recorded: true,
        taskCreated: false,
        reason: 'SESSION_NOT_ENABLED',
        event: row,
      };
    }
    const outcome = this.deps.tasks.createForEvent(session, row);
    return {
      recorded: true,
      taskCreated: outcome.created,
      event: row,
      task: outcome.task,
      reason: outcome.created ? undefined : 'TASK_ALREADY_ACTIVE',
    };
  }
}

/** 从转写帧提取 api_error 文本；非 api_error 帧返回 null。 */
export function extractApiError(
  frame: unknown,
): { errorText: string; timestamp?: string } | null {
  if (!frame || typeof frame !== 'object') return null;
  const f = frame as Record<string, unknown>;
  if (f['type'] !== 'system' || f['subtype'] !== 'api_error') return null;

  let errorText: string | null = null;
  const err = f['error'];
  if (typeof err === 'string') errorText = err;
  else if (err && typeof err === 'object') {
    const msg = (err as Record<string, unknown>)['message'];
    if (typeof msg === 'string') errorText = msg;
  }
  if (!errorText && typeof f['content'] === 'string') errorText = f['content'];
  if (!errorText) return null;

  const ts = typeof f['timestamp'] === 'string' ? f['timestamp'] : undefined;
  return { errorText, timestamp: ts };
}

function minuteBucket(iso: string): string {
  return iso.slice(0, 16); // 精确到分：无重置时刻时按检测分钟去重
}
