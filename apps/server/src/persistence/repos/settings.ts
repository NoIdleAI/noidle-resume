import type { Db } from '../db.ts';

export class SettingsRepo {
  private stmtGet;
  private stmtAll;
  private stmtSet;

  constructor(private db: Db) {
    this.stmtGet = db.prepare('SELECT value FROM app_settings WHERE key = ?');
    this.stmtAll = db.prepare('SELECT key, value FROM app_settings');
    this.stmtSet = db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (@key, @value, @at)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
  }

  get(key: string): string | undefined {
    const row = this.stmtGet.get(key) as { value: string } | undefined;
    return row?.value;
  }

  all(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.stmtAll.all() as { key: string; value: string }[]) {
      out[row.key] = row.value;
    }
    return out;
  }

  set(key: string, value: string, at: string): void {
    this.stmtSet.run({ key, value, at });
  }
}
