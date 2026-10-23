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
import { toTaskDto } from '../../shared/mappers.ts';
import fs from 'node:fs';

export interface SchedulerDeps {
  tasks: TasksRepo;
  sessions: SessionsRepo;
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
  recoveringPaused: number;
}

/**
 * 串行调度器（设计书 §5.1 规则 6 / §7）。
 * 到期 → checking（核验）→ recovering（headless 续跑）→ resumed，
 * 全程 CAS 状态推进；提交结果不明一律 paused，绝不盲目重发（§7.3）。
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

    // ① 白名单在执行前重核（§5.2 启停行为）
    const session = sessions.byId(task.session_row_id);
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
      tasks.finishFromChecking(task.id, 'paused', 'SESSION_TRANSCRIPT_MISSING', at());
      this.notify(task.id);
      return;
    }

    // ③ 冷会话守卫（§5.1 规则 11）：热持有 → 拒跑转待确认
    const cold = await runner.assertCold(task.session_id);
    if (!cold.cold) {
      const done = tasks.finishFromChecking(task.id, 'paused', 'SESSION_HOT_HELD', at());
      if (done) {
        this.deps.audit.log(
          'task.hot_held',
          task.id,
          `pids=${cold.pids?.join(',') ?? ''} err=${cold.error ?? ''}`,
          'system',
        );
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

    if (result.kind === 'ok') {
      // ⑤ 核验：只认本工具分支叶落盘（§7.2 recovering → resumed）
      const verify = await runner.verifyResumeLeaf(
        task.session_id,
        task.project_path,
        baseLeaf,
        promptSent,
      );
      if (verify.status === 'verified' && verify.leafUuid) {
        const evidence = JSON.stringify({
          baseLeafUuid: baseLeaf,
          ourTurnUuid: verify.ourTurnUuid,
          verifiedLeafUuid: verify.leafUuid,
          resultMessage: result.message ?? null,
        });
        tasks.markResumed(task.id, verify.leafUuid, evidence, at());
        this.deps.audit.log('task.resumed', task.id, `leaf=${verify.leafUuid}`, 'system');
      } else {
        // 提交结果不明 → paused，不自动重发（§7.3）
        tasks.finishFromRecovering(
          task.id,
          'paused',
          'RESUME_RESULT_UNKNOWN',
          attempt,
          at(),
          at(),
        );
        this.deps.audit.log(
          'task.verify_unknown',
          task.id,
          `${verify.status}: ${verify.reason ?? ''}`,
          'system',
        );
      }
      this.notify(task.id);
      return;
    }

    const retryable =
      result.kind === 'still-limited'
        ? 'STILL_LIMITED'
        : result.kind === 'timeout'
          ? 'RESUME_ATTEMPT_TIMEOUT'
          : 'RESUME_ATTEMPT_FAILED';
    const exhausted = attempt >= cfg.maxAttempts;
    if (exhausted) {
      // 仍受限 → paused 等人工；引擎错误 → failed（§6.3 / §7.1）
      const status = result.kind === 'still-limited' ? 'paused' : 'failed';
      tasks.finishFromRecovering(task.id, status, retryable, attempt, at(), at());
      this.deps.audit.log(
        status === 'paused' ? 'task.paused' : 'task.failed',
        task.id,
        `${retryable} attempts=${attempt}`,
        'system',
      );
    } else {
      const delay = backoffDelay(attempt, cfg.backoffBaseMs, cfg.backoffCapMs);
      const nextAt = new Date(this.deps.clock.now().getTime() + delay).toISOString();
      tasks.finishFromRecovering(task.id, 'waiting', retryable, attempt, nextAt, at());
      this.notify(task.id);
    }
  }

  /**
   * 重启对账（§7.3 崩溃对账，单位=叶）：
   *  - checking：无副作用 → 回 waiting 重排队。
   *  - recovering：不能确定提交是否完成 → 先查本工具分支叶；
   *    已落盘并核验 → resumed；否则 → paused（绝不重发）。
   */
  async reconcileOnBoot(): Promise<ReconcileSummary> {
    const { tasks, clock } = this.deps;
    const summary: ReconcileSummary = {
      checkingBackToWaiting: 0,
      recoveringResumed: 0,
      recoveringPaused: 0,
    };

    for (const t of tasks.byStatus('checking')) {
      if (tasks.checkingToWaiting(t.id, clock.now().toISOString())) {
        summary.checkingBackToWaiting++;
        this.notify(t.id);
      }
    }

    for (const t of tasks.byStatus('recovering')) {
      const at = clock.now().toISOString();
      if (!t.base_leaf_uuid || !t.prompt_sent) {
        tasks.finishFromRecovering(t.id, 'paused', 'RESUME_RESULT_UNKNOWN', t.attempt_count, at, at);
        summary.recoveringPaused++;
        this.notify(t.id);
        continue;
      }
      const verify = await this.deps.runner.verifyResumeLeaf(
        t.session_id,
        t.project_path,
        t.base_leaf_uuid,
        t.prompt_sent,
      );
      if (verify.status === 'verified' && verify.leafUuid) {
        const evidence = JSON.stringify({
          baseLeafUuid: t.base_leaf_uuid,
          ourTurnUuid: verify.ourTurnUuid,
          verifiedLeafUuid: verify.leafUuid,
          reconciledAtBoot: true,
        });
        if (tasks.markResumed(t.id, verify.leafUuid, evidence, at)) {
          summary.recoveringResumed++;
        }
      } else {
        tasks.finishFromRecovering(t.id, 'paused', 'RESUME_RESULT_UNKNOWN', t.attempt_count, at, at);
        summary.recoveringPaused++;
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
