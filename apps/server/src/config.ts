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
