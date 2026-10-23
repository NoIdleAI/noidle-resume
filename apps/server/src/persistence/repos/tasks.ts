import type { Db } from '../db.ts';

export interface ResumeTaskRow {
  id: string;
  session_row_id: string;
  session_id: string;
  project_path: string;
  usage_event_id: string | null;
  status: string;
  base_leaf_uuid: string | null;
  prompt_sent: string | null;
  verified_leaf_uuid: string | null;
  scheduled_at: string;
  attempt_count: number;
  last_attempt_at: string | null;
  cancel_requested: number;
  started_at: string | null;
  finished_at: string | null;
  last_error_code: string | null;
  evidence: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskWithSessionRow extends ResumeTaskRow {
  display_name: string;
  enabled: number;
}

export interface NewResumeTaskRow {
  id: string;
  sessionRowId: string;
  sessionId: string;
  projectPath: string;
  usageEventId: string | null;
  status: string;
  scheduledAt: string;
  createdAt: string;
}

/**
 * 任务状态机的持久层。所有转换都是带前置状态条件的 CAS 更新，
 * 返回是否生效——并发/重复触发下只有一次能成功（设计书 §7.3）。
 */
export class TasksRepo {
  private stmtInsert;
  private stmtById;
  private stmtList;
  private stmtActiveBySessionRow;
  private stmtDue;
  private stmtByStatus;

  private stmtClaimWaiting;
  private stmtToRecovering;
  private stmtMarkResumed;
  private stmtFinishFromRecovering;
  private stmtFinishFromChecking;
  private stmtBackToWaiting;
  private stmtRequestCancel;
  private stmtCancelPending;
  private stmtRetry;
  private stmtPauseFromWaiting;
  private stmtCheckingToWaiting;

  constructor(private db: Db) {
    this.stmtInsert = db.prepare(
      `INSERT INTO resume_tasks
         (id, session_row_id, session_id, project_path, usage_event_id, status,
          scheduled_at, created_at, updated_at)
       VALUES
         (@id, @sessionRowId, @sessionId, @projectPath, @usageEventId, @status,
          @scheduledAt, @createdAt, @createdAt)`,
    );
    this.stmtById = db.prepare('SELECT * FROM resume_tasks WHERE id = ?');
    this.stmtList = db.prepare(
      `SELECT t.*, s.display_name, s.enabled
       FROM resume_tasks t JOIN sessions s ON s.id = t.session_row_id
       ORDER BY t.created_at DESC LIMIT @limit OFFSET @offset`,
    );
    this.stmtActiveBySessionRow = db.prepare(
      `SELECT * FROM resume_tasks
       WHERE session_row_id = ? AND status IN ('waiting','checking','recovering')`,
    );
    this.stmtDue = db.prepare(
      `SELECT t.*, s.display_name, s.enabled
       FROM resume_tasks t JOIN sessions s ON s.id = t.session_row_id
       WHERE t.status = 'waiting' AND t.cancel_requested = 0
         AND s.enabled = 1 AND t.scheduled_at <= @now
       ORDER BY t.scheduled_at ASC
       LIMIT @limit`,
    );
    this.stmtByStatus = db.prepare('SELECT * FROM resume_tasks WHERE status = ?');

    this.stmtClaimWaiting = db.prepare(
      `UPDATE resume_tasks SET status = 'checking', updated_at = ?
       WHERE id = ? AND status = 'waiting' AND cancel_requested = 0`,
    );
    this.stmtToRecovering = db.prepare(
      `UPDATE resume_tasks SET status = 'recovering', base_leaf_uuid = @baseLeafUuid,
         prompt_sent = @promptSent, started_at = @at, updated_at = @at
       WHERE id = @id AND status = 'checking' AND cancel_requested = 0`,
    );
    this.stmtMarkResumed = db.prepare(
      `UPDATE resume_tasks SET status = 'resumed', verified_leaf_uuid = @verifiedLeafUuid,
         evidence = @evidence, finished_at = @at, updated_at = @at
       WHERE id = @id AND status = 'recovering'`,
    );
    this.stmtFinishFromRecovering = db.prepare(
      `UPDATE resume_tasks SET status = @status, last_error_code = @code,
         attempt_count = @attemptCount, scheduled_at = @scheduledAt,
         finished_at = CASE WHEN @status IN ('paused','failed') THEN @at ELSE finished_at END,
         updated_at = @at
       WHERE id = @id AND status = 'recovering'`,
    );
    this.stmtFinishFromChecking = db.prepare(
      `UPDATE resume_tasks SET status = @status, last_error_code = @code,
         finished_at = @at, updated_at = @at
       WHERE id = @id AND status = 'checking'`,
    );
    this.stmtBackToWaiting = db.prepare(
      `UPDATE resume_tasks SET status = 'waiting', scheduled_at = @scheduledAt,
         attempt_count = @attemptCount, last_attempt_at = @at,
         last_error_code = @code, updated_at = @at
       WHERE id = @id AND status = 'recovering'`,
    );
    this.stmtRequestCancel = db.prepare(
      `UPDATE resume_tasks SET cancel_requested = 1, updated_at = @at
       WHERE id = @id AND status IN ('waiting','checking','recovering')`,
    );
    this.stmtCancelPending = db.prepare(
      `UPDATE resume_tasks SET status = 'cancelled', finished_at = @at,
         last_error_code = 'TASK_CANCELLED', updated_at = @at
       WHERE id = @id AND status IN ('waiting','checking')`,
    );
    this.stmtRetry = db.prepare(
      `UPDATE resume_tasks SET status = 'waiting', cancel_requested = 0,
         scheduled_at = @scheduledAt, last_error_code = NULL, updated_at = @at
       WHERE id = @id AND status IN ('paused','failed')`,
    );
    this.stmtPauseFromWaiting = db.prepare(
      `UPDATE resume_tasks SET status = 'paused', last_error_code = @code,
         finished_at = @at, updated_at = @at
       WHERE id = @id AND status = 'waiting'`,
    );
    this.stmtCheckingToWaiting = db.prepare(
      `UPDATE resume_tasks SET status = 'waiting', updated_at = @at
       WHERE id = @id AND status = 'checking'`,
    );
  }

  insert(row: NewResumeTaskRow): boolean {
    try {
      this.stmtInsert.run({
        id: row.id,
        sessionRowId: row.sessionRowId,
        sessionId: row.sessionId,
        projectPath: row.projectPath,
        usageEventId: row.usageEventId,
        status: row.status,
        scheduledAt: row.scheduledAt,
        createdAt: row.createdAt,
      });
      return true;
    } catch (err) {
      // idx_tasks_active 部分唯一索引：同会话已有一个活动任务（§7.3）
      if (
        err instanceof Error &&
        (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
      ) {
        return false;
      }
      throw err;
    }
  }

  byId(id: string): ResumeTaskRow | undefined {
    return this.stmtById.get(id) as ResumeTaskRow | undefined;
  }

  list(limit: number, offset: number): TaskWithSessionRow[] {
    return this.stmtList.all({ limit, offset }) as TaskWithSessionRow[];
  }

  activeBySessionRowId(sessionRowId: string): ResumeTaskRow | undefined {
    return this.stmtActiveBySessionRow.get(sessionRowId) as
      | ResumeTaskRow
      | undefined;
  }

  due(nowIso: string, limit: number): TaskWithSessionRow[] {
    return this.stmtDue.all({ now: nowIso, limit }) as TaskWithSessionRow[];
  }

  byStatus(status: string): ResumeTaskRow[] {
    return this.stmtByStatus.all(status) as ResumeTaskRow[];
  }

  /** waiting → checking。 */
  claimWaiting(id: string, at: string): boolean {
    return this.stmtClaimWaiting.run(at, id).changes === 1;
  }

  /** checking → recovering，同时钉住恢复起点叶与提示词（§2.4 核验凭据）。 */
  toRecovering(
    id: string,
    baseLeafUuid: string,
    promptSent: string,
    at: string,
  ): boolean {
    return (
      this.stmtToRecovering.run({
        id,
        baseLeafUuid,
        promptSent,
        at,
      }).changes === 1
    );
  }

  /** recovering → resumed：只认本工具分支叶（§7.2）。 */
  markResumed(
    id: string,
    verifiedLeafUuid: string,
    evidence: string,
    at: string,
  ): boolean {
    return (
      this.stmtMarkResumed.run({ id, verifiedLeafUuid, evidence, at }).changes === 1
    );
  }

  /** recovering → waiting/paused/failed（attempt_count 由调用方算好）。 */
  finishFromRecovering(
    id: string,
    status: 'waiting' | 'paused' | 'failed',
    code: string | null,
    attemptCount: number,
    scheduledAt: string,
    at: string,
  ): boolean {
    return (
      this.stmtFinishFromRecovering.run({
        id,
        status,
        code,
        attemptCount,
        scheduledAt,
        at,
      }).changes === 1
    );
  }

  /** waiting → waiting（退避重排，用于 still-limited 重试）。 */
  backToWaiting(
    id: string,
    attemptCount: number,
    scheduledAt: string,
    code: string | null,
    at: string,
  ): boolean {
    return (
      this.stmtBackToWaiting.run({ id, attemptCount, scheduledAt, code, at })
        .changes === 1
    );
  }

  /** checking → paused/failed（核验阶段失败）。 */
  finishFromChecking(
    id: string,
    status: 'paused' | 'failed' | 'cancelled',
    code: string,
    at: string,
  ): boolean {
    return (
      this.stmtFinishFromChecking.run({ id, status, code, at }).changes === 1
    );
  }

  /** waiting → paused（用户暂停单个/暂停全部）。 */
  pauseFromWaiting(id: string, code: string, at: string): boolean {
    return this.stmtPauseFromWaiting.run({ id, code, at }).changes === 1;
  }

  requestCancel(id: string, at: string): boolean {
    return this.stmtRequestCancel.run({ id, at }).changes === 1;
  }

  /** waiting/checking → cancelled；recovering 不可同步取消（§5.2）。 */
  cancelPending(id: string, at: string): boolean {
    return this.stmtCancelPending.run({ id, at }).changes === 1;
  }

  /** paused/failed → waiting（手动重试，重新走全链核验，§5.2）。 */
  retry(id: string, scheduledAt: string, at: string): boolean {
    return this.stmtRetry.run({ id, scheduledAt, at }).changes === 1;
  }

  /** checking → waiting（重启对账：核验阶段无副作用，回队重排）。 */
  checkingToWaiting(id: string, at: string): boolean {
    return this.stmtCheckingToWaiting.run({ id, at }).changes === 1;
  }
}
