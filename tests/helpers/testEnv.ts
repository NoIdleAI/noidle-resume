import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationsDirOf } from '../../apps/server/src/persistence/db.ts';
import { buildContext, type AppContext } from '../../apps/server/src/context.ts';
import type { AppConfig } from '../../apps/server/src/config.ts';

export interface TestEnv {
  root: string;
  config: AppConfig;
  ctx: AppContext;
  /** 可执行假恢复引擎路径（赋给 config.claudeBin）。 */
  fakeBin: string;
  cleanup(): void;
}

/**
 * 集成测试环境：临时转写根 + 临时数据目录 + fake-claude 壳脚本。
 * 调度器/监听器不自动启动（buildContext 只装配），测试手动驱动。
 */
export function makeTestEnv(): TestEnv {
  // realpath：/var → /private/var 这类符号链接会让 fake 引擎的 process.cwd()
  // 与登记路径编码出不同目录（实测踩过），一律按真实路径建现场
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'car-test-')));
  const projectsRoot = path.join(root, 'projects');
  fs.mkdirSync(projectsRoot, { recursive: true });

  const fakeBin = makeFakeBin(root);

  const config: AppConfig = {
    dataDir: path.join(root, 'data'),
    dbFile: path.join(root, 'data', 'car.db'),
    tokenFile: path.join(root, 'data', 'token.txt'),
    migrationsDir: migrationsDirOf(),
    host: '127.0.0.1',
    port: 0,
    claudeBin: fakeBin,
    projectsRoot,
  };
  process.env.CAR_PROJECTS_ROOT = projectsRoot; // fake-claude 从环境读

  const ctx = buildContext(config, { env: 'test' });
  return {
    root,
    config,
    ctx,
    fakeBin,
    cleanup() {
      // 先停转写监听：fs.watch 句柄会钉住事件循环，必须显式释放
      try {
        ctx.services.watcher.stopAll();
      } catch {
        /* 已停 */
      }
      try {
        ctx.db.close();
      } catch {
        /* 已关 */
      }
      delete process.env.CAR_PROJECTS_ROOT;
      delete process.env.CAR_FAKE_MODE;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 生成壳脚本：exec node fake-claude.mjs "$@"（execFile 需要可直接执行文件）。 */
function makeFakeBin(root: string): string {
  const fakeClaudeTs = fileURLToPath(
    new URL('../../scripts/fake-claude.mjs', import.meta.url),
  );
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, 'fake-claude');
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nexec node "${fakeClaudeTs}" "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}
