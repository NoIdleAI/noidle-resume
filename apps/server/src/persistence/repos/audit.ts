import type { Db } from '../db.ts';

export interface AuditLogRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
}

export class AuditRepo {
  private stmtInsert;
  private stmtList;

  constructor(private db: Db) {
    this.stmtInsert = db.prepare(
      `INSERT INTO audit_logs (id, at, actor, action, target, detail)
       VALUES (@id, @at, @actor, @action, @target, @detail)`,
    );
    this.stmtList = db.prepare(
      'SELECT * FROM audit_logs ORDER BY at DESC LIMIT @limit OFFSET @offset',
    );
  }

  insert(row: {
    id: string;
    at: string;
    actor?: string;
    action: string;
    target?: string | null;
    detail?: string | null;
  }): void {
    this.stmtInsert.run({
      id: row.id,
      at: row.at,
      actor: row.actor ?? 'user',
      action: row.action,
      target: row.target ?? null,
      detail: row.detail ?? null,
    });
  }

  list(limit: number, offset: number): AuditLogRow[] {
    return this.stmtList.all({ limit, offset }) as unknown as AuditLogRow[];
  }
}
