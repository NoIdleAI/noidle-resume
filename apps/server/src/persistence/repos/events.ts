import { isUniqueViolation, type Db } from '../db.ts';

export interface UsageEventRow {
  id: string;
  provider: string;
  session_id: string;
  project_path: string;
  http_status: number | null;
  provider_code: string | null;
  reset_at: string | null;
  reset_at_raw: string | null;
  reset_tz: string | null;
  detected_at: string;
  source: string;
  confidence: string;
  raw_message: string | null;
  event_hash: string;
  created_at: string;
}

export interface NewUsageEventRow {
  id: string;
  provider: string;
  session_id: string;
  project_path: string;
  httpStatus: number | null;
  providerCode: string | null;
  resetAt: string | null;
  resetAtRaw: string | null;
  resetTz: string | null;
  detectedAt: string;
  source: string;
  confidence: string;
  rawMessage: string | null;
  eventHash: string;
}

export class EventsRepo {
  private stmtInsert;
  private stmtByHash;
  private stmtList;

  constructor(private db: Db) {
    this.stmtInsert = db.prepare(
      `INSERT INTO usage_events
         (id, provider, session_id, project_path, http_status, provider_code,
          reset_at, reset_at_raw, reset_tz, detected_at, source, confidence,
          raw_message, event_hash, created_at)
       VALUES
         (@id, @provider, @session_id, @project_path, @httpStatus, @providerCode,
          @resetAt, @resetAtRaw, @resetTz, @detectedAt, @source, @confidence,
          @rawMessage, @eventHash, @detectedAt)`,
    );
    this.stmtByHash = db.prepare('SELECT * FROM usage_events WHERE event_hash = ?');
    this.stmtList = db.prepare(
      'SELECT * FROM usage_events ORDER BY detected_at DESC LIMIT @limit OFFSET @offset',
    );
  }

  insert(row: NewUsageEventRow): boolean {
    try {
      this.stmtInsert.run({
        id: row.id,
        provider: row.provider,
        session_id: row.session_id,
        project_path: row.project_path,
        httpStatus: row.httpStatus,
        providerCode: row.providerCode,
        resetAt: row.resetAt,
        resetAtRaw: row.resetAtRaw,
        resetTz: row.resetTz,
        detectedAt: row.detectedAt,
        source: row.source,
        confidence: row.confidence,
        rawMessage: row.rawMessage,
        eventHash: row.eventHash,
      });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false; // 重复事件（§7.3 多条相同日志只记一次）
      throw err;
    }
  }

  byHash(hash: string): UsageEventRow | undefined {
    return this.stmtByHash.get(hash) as UsageEventRow | undefined;
  }

  list(limit: number, offset: number): UsageEventRow[] {
    return this.stmtList.all({ limit, offset }) as unknown as UsageEventRow[];
  }
}
