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
 * 任务状态机的门面（设计书 §7）：创建。「暂停/手动重试/取消」用户动词已退役
 * （2026-10-24）：是否自动重发由 settings.autoResend 决定，停止守护=会话页移除
 * （仓储层 cancelPending 连带取消），重新入队走会话页补录。
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
    // 重置时刻未解析 → 直接 failed 如实报告（重开=会话页补录正确时刻）
    const status = event.reset_at ? 'waiting' : 'failed';
    const row: ResumeTaskRow = {
      id: newId(),
      session_row_id: session.id,
      session_id: session.session_id,
      project_path: session.project_path,
      display_name: session.display_name,
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
      finished_at: status === 'failed' ? now : null,
      last_error_code: status === 'failed' ? 'RESET_TIME_UNPARSED' : null,
      evidence: null,
      created_at: now,
      updated_at: now,
    };
    const inserted = this.deps.tasks.insert({
      id: row.id,
      sessionRowId: session.id,
      sessionId: row.session_id,
      projectPath: row.project_path,
      displayName: session.display_name,
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
    // notify 走 byId（带会话 display_name 的 join 行）：裸行不出门，
    // 否则 WS 推送的 DTO 会用 sessionId 冒充展示名并盖掉列表刷新
    const joined = this.deps.tasks.byId(row.id);
    if (joined) this.notify(joined);
    return { task: joined ?? row, created: true };
  }

  byId(id: string): ResumeTaskRow {
    const row = this.deps.tasks.byId(id);
    if (!row) throw new BizError('NOT_FOUND', '任务不存在', 404);
    return row;
  }

  list(limit: number, offset: number) {
    return this.deps.tasks.list(limit, offset);
  }

  /** 清空历史归档（终态任务）。进行中的任务不受影响；前端调用后自行刷新。 */
  clearHistory(): number {
    return this.deps.tasks.clearHistory();
  }

  private notify(task: ResumeTaskRow): void {
    this.deps.bus.emit('task.changed', toTaskDto(task));
    this.deps.onChanged?.(task);
  }
}
