import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export type Db = DatabaseSync;

export function openDb(dbFile: string): Db {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL'); // 设计书 §8.6
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/**
 * SQLite 唯一约束冲突判定。better-sqlite3 给 code='SQLITE_CONSTRAINT_UNIQUE'，
 * node:sqlite 给 errcode 数字码（1555=PRIMARYKEY，2067=UNIQUE），兼容两者。
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (code?.startsWith('SQLITE_CONSTRAINT')) return true;
  const errcode = (err as { errcode?: number }).errcode;
  return errcode === 1555 || errcode === 2067;
}

/**
 * node:sqlite 没有内建事务包装，等价 better-sqlite3 的 db.transaction：
 * BEGIN → 执行 → COMMIT，异常 ROLLBACK 后原样抛出。
 */
export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 事务已被前序语句终结则忽略 */
    }
    throw err;
  }
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
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    inTransaction(db, () => {
      db.exec(sql);
      insert.run(file, new Date().toISOString());
    });
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
