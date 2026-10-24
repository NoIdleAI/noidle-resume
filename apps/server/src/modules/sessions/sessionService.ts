import fs from 'node:fs';
import path from 'node:path';
import type { AddSessionRequest, PatchSessionRequest, Provider } from '@noidle/resume-contracts';
import type { Clock } from '../../shared/clock.ts';
import { newId } from '../../shared/ids.ts';
import { BizError, notFound, validationError } from '../../shared/errors.ts';
import type { SessionsRepo, SessionRow } from '../../persistence/repos/sessions.ts';
import type { TasksRepo } from '../../persistence/repos/tasks.ts';
import type { ProjectsWatcher } from '../watcher/projectsWatcher.ts';
import { transcriptPath, verifySessionIdentity } from '../../adapters/vscode-claude/transcriptLocator.ts';
import { readTranscriptEntries } from '../resume/transcript.ts';
import { parseLimitMessage, type ParsedLimit } from '../limit/detector.ts';
import { isSupportedTimezone, zonedTimeToUtc } from '../limit/timezone.ts';
import type { SettingsService } from '../settings/settingsService.ts';
import type { UsageLimitIntake } from '../usage-limit/intake.ts';
import type { EventBus } from '../../shared/bus.ts';
import type { AuditService } from '../audit/auditService.ts';
import { toSessionDto, toTaskDto } from '../../shared/mappers.ts';

export interface SessionWithActiveTask {
  session: SessionRow;
  activeTask: ReturnType<typeof toTaskDto> | null;
}

/**
 * 白名单会话服务（设计书 §5 / §10.2）。
 * 新会话默认 enabled=false；启用时重做身份核验（§5.1 规则 8）。
 */
export class SessionService {
  constructor(
    private deps: {
      sessions: SessionsRepo;
      tasks: TasksRepo;
      clock: Clock;
      bus: EventBus;
      audit: AuditService;
      settings: SettingsService;
      intake: UsageLimitIntake;
      projectsRoot: string;
      watcher: ProjectsWatcher;
      /** 测试环境关掉「加入须在限额中」校验，避免夹具转写没有限额帧。 */
      enforceLimitCheck: boolean;
    },
  ) {}

  add(input: AddSessionRequest): SessionRow {
    const provider: Provider = input.provider ?? 'zhipu-glm';
    const sessionId = input.sessionId?.trim();
    const projectPath = path.resolve(input.projectPath ?? '');
    if (!sessionId) throw validationError('sessionId 必填');
    if (!projectPath || projectPath === '/') throw validationError('projectPath 必填');

    let stat: fs.Stats;
    try {
      stat = fs.statSync(projectPath);
    } catch {
      throw validationError(`工作区路径不存在: ${projectPath}`);
    }
    if (!stat.isDirectory()) throw validationError(`不是目录: ${projectPath}`);

    // 身份核验：转写帧内 cwd 必须与登记工作区一致（§9.3）
    const identity = verifySessionIdentity(this.deps.projectsRoot, sessionId, projectPath);
    if (!identity.ok) {
      throw new BizError('SESSION_IDENTITY_UNVERIFIED', identity.reason ?? '身份核验失败', 422);
    }
    // 加入校验 + 加入即建任务（2026-10-24 用户拍板：列表里的会话必须有自动重置任务在跑）
    const limitHit = this.findLimitFrame(sessionId, projectPath);
    if (this.deps.enforceLimitCheck && !limitHit) {
      throw new BizError('SESSION_NOT_LIMITED', '该会话未处于限额状态，无需加入自动化列表', 422);
    }
    if (this.deps.sessions.byBusinessKey(provider, sessionId, projectPath)) {
      throw new BizError('SESSION_ALREADY_EXISTS', '该会话已登记', 409);
    }

    const now = this.deps.clock.now().toISOString();
    const displayName =
      input.displayName?.trim() ||
      `${path.basename(projectPath)}#${sessionId.slice(0, 8)}`;
    const row: SessionRow = {
      id: newId(),
      provider,
      session_id: sessionId,
      project_path: projectPath,
      display_name: displayName,
      // 2026-10-24 用户拍板：「白名单+默认不启用+启用开关」概念退役——
      // 加入列表即开始守护；只有显式 enabled:false 才静默（API 兼容保留）
      enabled: input.enabled === false ? 0 : 1,
      created_at: now,
      updated_at: now,
    };
    this.deps.sessions.insert({
      id: row.id,
      provider: row.provider,
      session_id: row.session_id,
      project_path: row.project_path,
      display_name: row.display_name,
      enabled: row.enabled,
      createdAt: now,
    });
    this.deps.audit.log('session.added', row.id, `${projectPath} enabled=${row.enabled}`);
    this.afterChange(row);

    // 加入即建任务：用转写里最近一条限额帧的解析结果直接入队（重置时刻取原文时刻）。
    // 监听通常已抢先建过任务（TASK_ALREADY_ACTIVE）→ 幂等，不重复。
    if (limitHit) {
      const outcome = this.deps.intake.handleManual({
        sessionId,
        projectPath,
        httpStatus: limitHit.parsed.httpStatus ?? 429,
        providerCode: limitHit.parsed.providerCode ?? '1308',
        resetAt: limitHit.parsed.resetAtRaw ?? undefined,
        rawMessage: limitHit.rawText.slice(0, 600),
        provider,
      });
      this.deps.audit.log(
        'session.join_task',
        row.id,
        outcome.taskCreated ? `task=${outcome.task?.id ?? ''}` : (outcome.reason ?? '已有活动任务'),
      );
    }
    return row;
  }

  patch(id: string, partial: PatchSessionRequest): SessionRow {
    const row = this.byId(id);
    const now = this.deps.clock.now().toISOString();

    if (partial.enabled === true && row.enabled !== 1) {
      const identity = verifySessionIdentity(
        this.deps.projectsRoot,
        row.session_id,
        row.project_path,
      );
      if (!identity.ok) {
        throw new BizError('SESSION_IDENTITY_UNVERIFIED', identity.reason ?? '身份核验失败', 422);
      }
    }

    this.deps.sessions.patch(
      id,
      {
        displayName: partial.displayName,
        enabled: partial.enabled === undefined ? undefined : partial.enabled ? 1 : 0,
      },
      now,
    );
    const after = this.byId(id);

    if (partial.enabled === false) {
      // 禁用 → 撤销授权并取消待执行任务（§5.2）
      const active = this.deps.tasks.activeBySessionRowId(id);
      if (active && ['waiting', 'checking'].includes(active.status)) {
        this.deps.tasks.cancelPending(active.id, now);
        this.deps.bus.emit('task.changed', toTaskDto(this.deps.tasks.byId(active.id)!));
      }
      this.deps.audit.log('session.disabled', id);
    } else if (partial.enabled === true) {
      this.deps.audit.log('session.enabled', id);
    } else if (partial.displayName) {
      this.deps.audit.log('session.renamed', id, partial.displayName);
    }
    this.afterChange(after);
    return after;
  }

  remove(id: string): void {
    const row = this.byId(id);
    const now = this.deps.clock.now().toISOString();
    // 任务随会话级联删除（迁移 FK ON DELETE CASCADE）；脱敏审计保留
    this.deps.sessions.remove(id);
    this.deps.audit.log('session.removed', id, row.project_path);
    this.afterChange(row);
  }

  list(): SessionRow[] {
    return this.deps.sessions.list();
  }

  listWithActiveTask(): SessionWithActiveTask[] {
    return this.list().map((session) => {
      const active = this.deps.tasks.activeBySessionRowId(session.id);
      return {
        session,
        activeTask: active ? toTaskDto(active) : null,
      };
    });
  }

  private byId(id: string): SessionRow {
    const row = this.deps.sessions.byId(id);
    if (!row) throw notFound('会话不存在');
    return row;
  }

  /**
   * 扫转写尾部找最近一条 5 小时限额报错帧：重置时刻未到（或 5h 窗口内的无时刻帧）
   * = 仍在限额，返回解析结果供「加入即建任务」；否则返回 null（未在限额，拒绝加入）。
   */
  private findLimitFrame(
    sessionId: string,
    projectPath: string,
  ): { parsed: ParsedLimit; rawText: string } | null {
    const file = transcriptPath(this.deps.projectsRoot, sessionId, projectPath);
    let entries: ReturnType<typeof readTranscriptEntries>;
    try {
      entries = readTranscriptEntries(file);
    } catch {
      return null;
    }
    const tz = this.deps.settings.get().timezone;
    const nowMs = this.deps.clock.now().getTime();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!entry) continue;
      // 只认 API 真实返回的限额帧：system/api_error 或 CLI 标记的 API 错误轮次；
      // 用户在会话里手打/粘贴的限额字样不算证据（isApiErrorMessage 在原始 JSON 行上，
      // readTranscriptEntries 把整行挂在 entry.raw）
      const raw = entry.raw as { isApiErrorMessage?: unknown } | undefined;
      const isApiErrorFrame =
        entry.type === 'system' || raw?.isApiErrorMessage === true;
      if (!isApiErrorFrame) continue;
      const text = frameText(entry);
      if (!text) continue;
      const parsed = parseLimitMessage(text);
      if (!parsed) continue;
      if (parsed.resetAtRaw) {
        try {
          const resetMs = isSupportedTimezone(tz)
            ? zonedTimeToUtc(parsed.resetAtRaw, tz).getTime()
            : Date.parse(parsed.resetAtRaw.replace(' ', 'T') + 'Z');
          if (Number.isFinite(resetMs)) {
            // 帧里明确写了重置时刻：时刻未到=仍在限额；已过=不在限额（不用 5h 兜底）
            if (resetMs > nowMs) return { parsed, rawText: text };
            break;
          }
        } catch {
          /* 时刻解析不了按帧时间兜底 */
        }
      }
      // 无可解析时刻的限额帧：5h 窗口内视为仍在限额
      const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      if (Number.isFinite(at) && nowMs - at < 5 * 3600_000) return { parsed, rawText: text };
      break;
    }
    return null;
  }

  private afterChange(row: SessionRow): void {
    this.deps.watcher.sync(
      this.list().map((s) => ({ sessionId: s.session_id, projectPath: s.project_path })),
    );
    this.deps.bus.emit('session.changed', toSessionDto(row));
  }
}

/** 抽取转写帧的文本内容：assistant/user 的 message.content，以及 system/api_error 的 error.message。 */
function frameText(entry: {
  message?: { content?: string | Array<{ type?: string; text?: string }> };
  error?: { message?: unknown };
}): string | null {
  const em = entry?.error?.message;
  if (typeof em === 'string' && em) return em;
  const c = entry?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const t = c
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
    return t || null;
  }
  return null;
}
