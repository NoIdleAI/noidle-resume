import type { Clock } from '../../shared/clock.ts';
import type { TasksRepo, TaskWithSessionRow } from '../../persistence/repos/tasks.ts';
import type { SessionsRepo } from '../../persistence/repos/sessions.ts';
import type { ResumeRunner } from '../resume/runner.ts';
import type { SettingsService } from '../settings/settingsService.ts';
import type { EventBus } from '../../shared/bus.ts';
import type { AuditService } from '../audit/auditService.ts';
import { transcriptPath } from '../../adapters/vscode-claude/transcriptLocator.ts';
import { latestLeafUuid, readTranscriptEntries } from '../resume/transcript.ts';
import { backoffDelay } from './backoff.ts';
import { parseLimitMessage } from '../limit/detector.ts';
import { isSupportedTimezone, zonedTimeToUtc } from '../limit/timezone.ts';
import { toTaskDto } from '../../shared/mappers.ts';
import fs from 'node:fs';

export interface SchedulerDeps {
  tasks: TasksRepo;
  sessions: SessionsRepo;
  /** 完结自动移除登记用（走服务层：审计 + 监听同步 + 事件广播）。 */
  sessionsService: {
    remove(id: string): void;
  };
  settings: SettingsService;
  runner: ResumeRunner;
  clock: Clock;
  bus: EventBus;
  audit: AuditService;
  projectsRoot: string;
}

export interface ReconcileSummary {
  checkingBackToWaiting: number;
  recoveringResumed: number;
  recoveringRequeued: number;
  recoveringFailed: number;
}

/**
 * 串行调度器（设计书 §5.1 规则 6 / §7）。
 * 到期 → checking（核验）→ recovering（headless 续跑）→ resumed / failed，
 * 全程 CAS 状态推进。「暂停」已退役（2026-10-24）：结果不明是否重发由
 * settings.autoResend 决定——开=按退避自动重发直到 maxAttempts；关=一次未知即 failed。
 * 轮次是否落盘以转写核验为事实源，进程结局只作归类参考。
 */
export class ResumeScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = 0;

  constructor(private deps: SchedulerDeps) {}

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.deps.audit.log('scheduler.tick_error', null, String(err), 'system'));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const { concurrency } = this.deps.settings.get();
    while (this.running < concurrency) {
      const nowIso = this.deps.clock.now().toISOString();
      const due = this.deps.tasks.due(nowIso, 1)[0];
      if (!due) break;
      this.running++;
      void this.runAttempt(due)
        .catch((err) =>
          this.deps.audit.log('scheduler.attempt_error', due.id, String(err), 'system'),
        )
        .finally(() => {
          this.running--;
        });
    }
  }

  /** 单次恢复尝试：状态机全链。调用方保证任务处于 waiting。 */
  async runAttempt(task: TaskWithSessionRow): Promise<void> {
    const { tasks, sessions, runner, settings, clock } = this.deps;
    const at = () => clock.now().toISOString();

    // waiting → checking
    if (!tasks.claimWaiting(task.id, at())) return;
    this.notify(task.id);

    // ① 白名单在执行前重核（§5.2 启停行为）；会话已被自动移除（session_row_id 为空）→ 取消
    const session = task.session_row_id ? sessions.byId(task.session_row_id) : undefined;
    if (!session || session.enabled !== 1) {
      tasks.finishFromChecking(task.id, 'cancelled', 'TASK_CANCELLED', at());
      this.notify(task.id);
      return;
    }

    // ② 转写可读且有叶（§13：会话定位由转写承担）
    const file = transcriptPath(
      this.deps.projectsRoot,
      task.session_id,
      task.project_path,
    );
    let baseLeaf: string | null = null;
    try {
      baseLeaf = latestLeafUuid(readTranscriptEntries(file));
    } catch {
      baseLeaf = null;
    }
    if (!baseLeaf) {
      tasks.finishFromChecking(task.id, 'failed', 'SESSION_TRANSCRIPT_MISSING', at());
      this.notify(task.id);
      this.autoRemoveSession(task);
      return;
    }

    // ③ 冷会话守卫（§5.1 规则 11）：热持有 → 计一次尝试，退避后自动重试直到上限
    const cold = await runner.assertCold(task.session_id);
    if (!cold.cold) {
      const cfg = settings.get();
      const attempt = task.attempt_count + 1;
      this.deps.audit.log(
        'task.hot_held',
        task.id,
        `pids=${cold.pids?.join(',') ?? ''} err=${cold.error ?? ''} attempt=${attempt}`,
        'system',
      );
      if (attempt >= cfg.maxAttempts) {
        tasks.finishFromChecking(task.id, 'failed', 'SESSION_HOT_HELD', at());
        this.notify(task.id);
        this.autoRemoveSession(task);
      } else {
        const delay = backoffDelay(attempt, cfg.backoffBaseMs, cfg.backoffCapMs);
        const nextAt = new Date(this.deps.clock.now().getTime() + delay).toISOString();
        tasks.hotHoldBackToWaiting(task.id, attempt, nextAt, at());
      }
      this.notify(task.id);
      return;
    }

    // ④ checking → recovering：钉住起点叶与提示词（核验凭据）
    const promptSent = settings.get().resumePromptTemplate.replace('{taskId}', task.id);
    if (!tasks.toRecovering(task.id, baseLeaf, promptSent, at())) return;
    this.notify(task.id);

    const attempt = task.attempt_count + 1;
    const result = await runner.resume(task.session_id, promptSent, task.project_path);
    const cfg = settings.get();

    // ⑤ 转写为事实源：不管进程怎么退场（含超时被杀），轮次落盘即成功
    const verify = await runner.verifyResumeLeaf(
      task.session_id,
      task.project_path,
      baseLeaf,
      promptSent,
    );
    if (verify.status === 'verified' && verify.leafUuid && result.kind !== 'still-limited') {
      const evidence = JSON.stringify({
        baseLeafUuid: baseLeaf,
        ourTurnUuid: verify.ourTurnUuid,
        verifiedLeafUuid: verify.leafUuid,
        resultKind: result.kind,
        resultMessage: result.message ?? null,
      });
      tasks.markResumed(task.id, verify.leafUuid, evidence, at());
      this.deps.audit.log('task.resumed', task.id, `leaf=${verify.leafUuid}`, 'system');
      this.notify(task.id);
      this.autoRemoveSession(task);
      return;
    }

    // 未恢复：归类失败原因，按自动重发策略决定重试或终止。
    // 落盘但仍受限（§6.3）：真实 CLI 会把 429 错误轮次写进转写，「落盘」≠「额度恢复」，
    // 绝不判 resumed —— 能从报错原文解析出重置时刻就直接排到那时，否则退避重试。
    const code =
      result.kind === 'still-limited'
        ? 'STILL_LIMITED'
        : result.kind === 'timeout'
          ? 'RESUME_ATTEMPT_TIMEOUT'
          : result.kind === 'ok'
            ? 'RESUME_RESULT_UNKNOWN'
            : 'RESUME_ATTEMPT_FAILED';
    this.deps.audit.log(
      'task.verify_unknown',
      task.id,
      `${verify.status}: ${verify.reason ?? ''} kind=${result.kind}`,
      'system',
    );

    const exhausted = attempt >= cfg.maxAttempts;
    // 仍受限=额度没恢复，重试是设计内行为（§6.3），不受 autoResend 管；
    // 其余未知/失败只在 autoResend 开启时自动重发。
    const mayRetry =
      !exhausted && (result.kind === 'still-limited' || cfg.autoResend === true);
    if (mayRetry) {
      const delay = backoffDelay(attempt, cfg.backoffBaseMs, cfg.backoffCapMs);
      const backoffAt = new Date(this.deps.clock.now().getTime() + delay).toISOString();
      const nextAt =
        result.kind === 'still-limited'
          ? this.stillLimitedNextAt(result.message, cfg.timezone, backoffAt)
          : backoffAt;
      tasks.finishFromRecovering(task.id, 'waiting', code, attempt, nextAt, at());
      this.deps.audit.log(
        'task.auto_resend',
        task.id,
        `${code} attempts=${attempt}/${cfg.maxAttempts} next=${nextAt}`,
        'system',
      );
    } else {
      tasks.finishFromRecovering(task.id, 'failed', code, attempt, at(), at());
      this.deps.audit.log(
        'task.failed',
        task.id,
        `${code} attempts=${attempt}/${cfg.maxAttempts}`,
        'system',
      );
      this.notify(task.id);
      this.autoRemoveSession(task);
    }
    this.notify(task.id);
  }

  /**
   * 仍受限时的下次尝试时刻：报错原文里带重置时刻（如「限额将在 10:57:09 重置」）
   * 就排到该时刻（+2s 缓冲），避免在额度恢复前空转重试；解析不出或时刻已过则退回退避值。
   */
  private stillLimitedNextAt(message: string | null | undefined, tz: string, fallback: string): string {
    const raw = message ? parseLimitMessage(message)?.resetAtRaw : null;
    if (raw) {
      try {
        const iso = isSupportedTimezone(tz)
          ? zonedTimeToUtc(raw, tz).toISOString()
          : new Date(raw.replace(' ', 'T') + 'Z').toISOString();
        const at = Date.parse(iso) + 2000;
        if (Number.isFinite(at) && at > this.deps.clock.now().getTime()) return new Date(at).toISOString();
      } catch {
        /* 原文不可解析 → 退回退避 */
      }
    }
    return fallback;
  }

  /**
   * 完结即移除登记（2026-10-24 用户拍板）：自动化列表里的会话必须有任务在跑，
   * 恢复完结（成功/失败）后自动清出列表。任务归档保留（迁移 003），历史记录不丢。
   */
  private autoRemoveSession(task: { session_row_id: string | null; id: string }): void {
    const rowId = task.session_row_id;
    if (!rowId) return;
    try {
      this.deps.sessionsService.remove(rowId);
    } catch {
      /* 已被并发移除 */
    }
  }

  /**
   * 重启对账（§7.3 崩溃对账，单位=叶）：
   *  - checking：无副作用 → 回 waiting 重排队。
   *  - recovering：先查本工具分支叶（转写为事实源）；已落盘并核验 → resumed；
   *    否则按 autoResend：开 → 回 waiting 退避重发，关 → failed（一次未知即终止）。
   */
  async reconcileOnBoot(): Promise<ReconcileSummary> {
    const { tasks, clock, settings } = this.deps;
    const summary: ReconcileSummary = {
      checkingBackToWaiting: 0,
      recoveringResumed: 0,
      recoveringRequeued: 0,
      recoveringFailed: 0,
    };
    const cfg = settings.get();

    for (const t of tasks.byStatus('checking')) {
      if (tasks.checkingToWaiting(t.id, clock.now().toISOString())) {
        summary.checkingBackToWaiting++;
        this.notify(t.id);
      }
    }

    for (const t of tasks.byStatus('recovering')) {
      const at = clock.now().toISOString();
      if (!t.base_leaf_uuid || !t.prompt_sent) {
        tasks.finishFromRecovering(t.id, 'failed', 'RESUME_RESULT_UNKNOWN', t.attempt_count, at, at);
        summary.recoveringFailed++;
        this.notify(t.id);
        continue;
      }
      const verify = await this.deps.runner.verifyResumeLeaf(
        t.session_id,
        t.project_path,
        t.base_leaf_uuid,
        t.prompt_sent,
      );
      // 与 runAttempt 同一判定：落盘的若是 429 仍受限轮次，绝不判 resumed（§6.3）
      const stillLimited =
        verify.status === 'verified' &&
        !!verify.leafText &&
        parseLimitMessage(verify.leafText) !== null;
      if (verify.status === 'verified' && verify.leafUuid && !stillLimited) {
        const evidence = JSON.stringify({
          baseLeafUuid: t.base_leaf_uuid,
          ourTurnUuid: verify.ourTurnUuid,
          verifiedLeafUuid: verify.leafUuid,
          reconciledAtBoot: true,
        });
        if (tasks.markResumed(t.id, verify.leafUuid, evidence, at)) {
          summary.recoveringResumed++;
          this.autoRemoveSession(t);
        }
      } else if (stillLimited || cfg.autoResend === true) {
        const delay = backoffDelay(t.attempt_count + 1, cfg.backoffBaseMs, cfg.backoffCapMs);
        const backoffAt = new Date(clock.now().getTime() + delay).toISOString();
        const nextAt = stillLimited
          ? this.stillLimitedNextAt(verify.leafText, cfg.timezone, backoffAt)
          : backoffAt;
        tasks.finishFromRecovering(
          t.id,
          'waiting',
          stillLimited ? 'STILL_LIMITED' : 'RESUME_RESULT_UNKNOWN',
          t.attempt_count,
          nextAt,
          at,
        );
        this.deps.audit.log(
          'task.auto_resend',
          t.id,
          `reconcile requeue next=${nextAt}`,
          'system',
        );
        summary.recoveringRequeued++;
      } else {
        tasks.finishFromRecovering(t.id, 'failed', 'RESUME_RESULT_UNKNOWN', t.attempt_count, at, at);
        summary.recoveringFailed++;
        this.autoRemoveSession(t);
      }
      this.notify(t.id);
    }
    return summary;
  }

  private notify(taskId: string): void {
    const row = this.deps.tasks.byId(taskId);
    if (row) this.deps.bus.emit('task.changed', toTaskDto(row));
  }
}

/** 转写文件存在性快速检查（route 与调度共用）。 */
export function transcriptExists(projectsRoot: string, sessionId: string, projectPath: string): boolean {
  return fs.existsSync(transcriptPath(projectsRoot, sessionId, projectPath));
}
