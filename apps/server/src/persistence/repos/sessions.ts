import type { Db } from '../db.ts';

export interface SessionRow {
  id: string;
  provider: string;
  session_id: string;
  project_path: string;
  display_name: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface NewSessionRow {
  id: string;
  provider: string;
  session_id: string;
  project_path: string;
  display_name: string;
  enabled: number;
  createdAt: string;
}

/** 白名单唯一持久层入口（设计书 §8.6：状态变更统一走 Repository/Service）。 */
export class SessionsRepo {
  private stmtInsert;
  private stmtList;
  private stmtById;
  private stmtByBusinessKey;
  private stmtPatch;
  private stmtRemove;

  constructor(private db: Db) {
    this.stmtInsert = db.prepare(
      `INSERT INTO sessions (id, provider, session_id, project_path, display_name, enabled, created_at, updated_at)
       VALUES (@id, @provider, @session_id, @project_path, @display_name, @enabled, @createdAt, @createdAt)`,
    );
    this.stmtList = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC');
    this.stmtById = db.prepare('SELECT * FROM sessions WHERE id = ?');
    this.stmtByBusinessKey = db.prepare(
      'SELECT * FROM sessions WHERE provider = ? AND session_id = ? AND project_path = ?',
    );
    this.stmtPatch = db.prepare(
      `UPDATE sessions SET
         display_name = COALESCE(@displayName, display_name),
         enabled = COALESCE(@enabled, enabled),
         updated_at = @updatedAt
       WHERE id = @id`,
    );
    this.stmtRemove = db.prepare('DELETE FROM sessions WHERE id = ?');
  }

  insert(row: NewSessionRow): void {
    this.stmtInsert.run({
      id: row.id,
      provider: row.provider,
      session_id: row.session_id,
      project_path: row.project_path,
      display_name: row.display_name,
      enabled: row.enabled,
      createdAt: row.createdAt,
    });
  }

  list(): SessionRow[] {
    return this.stmtList.all() as unknown as SessionRow[];
  }

  byId(id: string): SessionRow | undefined {
    return this.stmtById.get(id) as SessionRow | undefined;
  }

  byBusinessKey(
    provider: string,
    sessionId: string,
    projectPath: string,
  ): SessionRow | undefined {
    return this.stmtByBusinessKey.get(provider, sessionId, projectPath) as
      | SessionRow
      | undefined;
  }

  patch(
    id: string,
    fields: { displayName?: string; enabled?: number },
    updatedAt: string,
  ): void {
    this.stmtPatch.run({
      id,
      displayName: fields.displayName ?? null,
      enabled: fields.enabled ?? null,
      updatedAt,
    });
  }

  remove(id: string): void {
    this.stmtRemove.run(id);
  }
}
