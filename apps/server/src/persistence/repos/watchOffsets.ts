import type { Db } from '../db.ts';

/** 转写尾部偏移持久化：重启后从上次位置继续，已处理事件靠 event_hash 去重。 */
export class WatchOffsetsRepo {
  private stmtGet;
  private stmtSet;

  constructor(private db: Db) {
    this.stmtGet = db.prepare(
      'SELECT byte_offset FROM watcher_offsets WHERE session_key = ?',
    );
    this.stmtSet = db.prepare(
      `INSERT INTO watcher_offsets (session_key, byte_offset, updated_at)
       VALUES (@key, @offset, @at)
       ON CONFLICT(session_key) DO UPDATE SET byte_offset = excluded.byte_offset,
         updated_at = excluded.updated_at`,
    );
  }

  get(sessionKey: string): number | undefined {
    const row = this.stmtGet.get(sessionKey) as
      | { byte_offset: number }
      | undefined;
    return row?.byte_offset;
  }

  set(sessionKey: string, offset: number, at: string): void {
    this.stmtSet.run({ key: sessionKey, offset, at });
  }
}
