import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const dataDir = env.CAR_DATA_DIR ?? defaultDataDir(process.platform);
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

/**
 * 各平台用户应用数据目录（桌面壳 apps/desktop/src-tauri/src/lib.rs 的
 * default_data_dir 与此同源，两处改动必须同步）：
 * macOS ~/Library/Application Support/noidle-resume；
 * Windows %APPDATA%\noidle-resume；
 * Linux $XDG_DATA_HOME/noidle-resume（兜底 ~/.local/share）。
 */
export function defaultDataDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'noidle-resume');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'noidle-resume');
  }
  const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'noidle-resume');
}

function defaultMigrationsDir(): string {
  // src/config.ts → apps/server/src → 仓库根/migrations
  // fileURLToPath 而非 URL.pathname：Windows 下 pathname 会给出 /C:/... 形态
  return fileURLToPath(new URL('../../../migrations/', import.meta.url));
}

/**
 * 旧版数据目录 noidle-auto-resume → noidle-resume 一次性搬迁：
 * 新目录还没有库而旧目录有，则拷贝（库 + WAL + 令牌），原目录保留不动。
 * 旧目录是 macOS 专属路径，仅 darwin 有此历史包袱。
 */
export function importLegacyDataDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): void {
  if (process.platform !== 'darwin') return;
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
