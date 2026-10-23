import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';

export type Db = Database;

export function openDb(dbFile: string): Db {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new BetterSqlite3(dbFile);
  db.pragma('journal_mode = WAL'); // 设计书 §8.6
  db.pragma('foreign_keys = ON');
  return db;
}

/** 顺序应用 migrations/*.sql，已应用的跳过（设计书 §8.6 启动迁移）。 */
export function migrate(db: Db, migrationsDir: string): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    (
      db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]
    ).map((r) => r.name),
  );
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const ran: string[] = [];
  const insert = db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  );
  const tx = db.transaction((file: string, sql: string) => {
    db.exec(sql);
    insert.run(file, new Date().toISOString());
  });
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    tx(file, sql);
    ran.push(file);
  }
  return ran;
}

/** 仓库根 migrations 目录（自持解析，供测试/脚本复用）。 */
export function migrationsDirOf(): string {
  // apps/server/src/persistence/db.ts → 仓库根/migrations
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../migrations');
}
