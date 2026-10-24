import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AppConfig {
  /** 数据目录：数据库、访问令牌（设计书 §14 用户应用数据目录）。 */
  dataDir: string;
  dbFile: string;
  tokenFile: string;
  migrationsDir: string;
  /** HTTP 监听地址：默认仅本机（设计书 §11.1）。 */
  host: string;
  port: number;
  /** 恢复引擎调用的 claude CLI。 */
  claudeBin: string;
  /** Claude Code 转写根目录：~/.claude/projects。 */
  projectsRoot: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir =
    env.CAR_DATA_DIR ??
    path.join(os.homedir(), 'Library', 'Application Support', 'noidle-resume');
  return {
    dataDir,
    dbFile: path.join(dataDir, 'car.db'),
    tokenFile: path.join(dataDir, 'token.txt'),
    migrationsDir: env.CAR_MIGRATIONS_DIR ?? defaultMigrationsDir(),
    host: env.CAR_HOST ?? '127.0.0.1',
    port: Number(env.CAR_PORT ?? 7842),
    claudeBin: env.CAR_CLAUDE_BIN ?? 'claude',
    projectsRoot: env.CAR_PROJECTS_ROOT ?? path.join(os.homedir(), '.claude', 'projects'),
  };
}

function defaultMigrationsDir(): string {
  // src/config.ts → apps/server/src → 仓库根/migrations
  return new URL('../../../migrations/', import.meta.url).pathname;
}

/**
 * 旧版数据目录 noidle-auto-resume → noidle-resume 一次性搬迁：
 * 新目录还没有库而旧目录有，则拷贝（库 + WAL + 令牌），原目录保留不动。
 */
export function importLegacyDataDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.CAR_DATA_DIR) return; // 显式指定数据目录的不掺和
  const legacyDir = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'noidle-auto-resume',
  );
  if (fs.existsSync(path.join(dataDir, 'car.db'))) return;
  if (!fs.existsSync(path.join(legacyDir, 'car.db'))) return;
  fs.mkdirSync(dataDir, { recursive: true });
  for (const f of ['car.db', 'car.db-wal', 'car.db-shm', 'token.txt']) {
    const from = path.join(legacyDir, f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dataDir, f));
  }
}
