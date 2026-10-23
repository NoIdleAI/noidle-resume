import type { Clock } from '../../shared/clock.ts';
import { newId } from '../../shared/ids.ts';
import type { TasksRepo, ResumeTaskRow } from '../../persistence/repos/tasks.ts';
import type { UsageEventRow } from '../../persistence/repos/events.ts';
import type { SessionRow } from '../../persistence/repos/sessions.ts';
import type { EventBus } from '../../shared/bus.ts';
import { toTaskDto } from '../../shared/mappers.ts';
import { BizError } from '../../shared/errors.ts';

export interface CreateTaskOutcome {
  task: ResumeTaskRow;
  created: boolean;
}

/**
 * 任务状态机的门面（设计书 §7）：创建、取消、重试、暂停全部。
 * 所有转换经 TasksRepo 的 CAS 语句，重复触发只有一次生效。
 */
export class TaskService {
  constructor(
    private deps: {
      tasks: TasksRepo;
      clock: Clock;
      bus: EventBus;
      onChanged?: (task: ResumeTaskRow) => void;
    },
  ) {}

  /** 由限额事件建任务（§7.3：同一会话同一时间最多一个活动任务）。 */
  createForEvent(session: SessionRow, event: UsageEventRow): CreateTaskOutcome {
    const now = this.deps.clock.now().toISOString();
    // 重置时刻未解析 → 直接 paused 等人工确认（§6.2）
    const status = event.reset_at ? 'waiting' : 'paused';
    const row: ResumeTaskRow = {
      id: newId(),
      session_row_id: session.id,
      session_id: session.session_id,
      project_path: session.project_path,
      usage_event_id: event.id,
      status,
      base_leaf_uuid: null,
      prompt_sent: null,
      verified_leaf_uuid: null,
      scheduled_at: event.reset_at ?? now,
      attempt_count: 0,
      last_attempt_at: null,
      cancel_requested: 0,
      started_at: null,
      finished_at: status === 'paused' ? now : null,
      last_error_code: status === 'paused' ? 'RESET_TIME_UNPARSED' : null,
      evidence: null,
      created_at: now,
      updated_at: now,
    };
    const inserted = this.deps.tasks.insert({
      id: row.id,
      sessionRowId: row.session_row_id,
      sessionId: row.session_id,
      projectPath: row.project_path,
      usageEventId: row.usage_event_id,
      status: row.status,
      scheduledAt: row.scheduled_at,
      createdAt: now,
    });
    if (!inserted) {
      const active = this.deps.tasks.activeBySessionRowId(session.id);
      if (!active) throw new BizError('INTERNAL_ERROR', '任务创建失败且无活动任务', 500);
      return { task: active, created: false };
    }
    this.notify(row);
    return { task: row, created: true };
  }

  byId(id: string): ResumeTaskRow {
    const row = this.deps.tasks.byId(id);
    if (!row) throw new BizError('NOT_FOUND', '任务不存在', 404);
    return row;
  }

  list(limit: number, offset: number) {
    return this.deps.tasks.list(limit, offset);
  }

  /** 用户取消：waiting/checking 可立即取消；recovering 只置取消标记（§5.2）。 */
  cancel(taskId: string): ResumeTaskRow {
    const now = this.deps.clock.now().toISOString();
    const task = this.byId(taskId);
    this.deps.tasks.requestCancel(taskId, now);
    this.deps.tasks.cancelPending(taskId, now);
    const after = this.byId(taskId);
    this.notify(after);
    return after.status === task.status ? after : after;
  }

  /** 手动重试：重新走全链核验（§5.2），attempts 保留防无限循环。 */
  retry(taskId: string): ResumeTaskRow {
    const now = this.deps.clock.now().toISOString();
    const task = this.byId(taskId);
    if (task.status !== 'paused' && task.status !== 'failed') {
      throw new BizError('TASK_NOT_RETRYABLE', `状态 ${task.status} 不可重试`, 409);
    }
    if (!this.deps.tasks.retry(taskId, now, now)) {
      throw new BizError('TASK_NOT_RETRYABLE', '重试失败：状态已变化', 409);
    }
    const after = this.byId(taskId);
    this.notify(after);
    return after;
  }

  /** 暂停全部尚未开始的恢复任务（§5.2）。 */
  pauseAll(): number {
    const now = this.deps.clock.now().toISOString();
    let n = 0;
    for (const t of this.deps.tasks.byStatus('waiting')) {
      if (this.deps.tasks.pauseFromWaiting(t.id, 'PAUSED_BY_USER', now)) n++;
      else continue;
      this.notify(this.byId(t.id));
    }
    return n;
  }

  private notify(task: ResumeTaskRow): void {
    this.deps.bus.emit('task.changed', toTaskDto(task));
    this.deps.onChanged?.(task);
  }
}
