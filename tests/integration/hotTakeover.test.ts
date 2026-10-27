import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTestEnv, type TestEnv } from '../helpers/testEnv.ts';
import { makeWorkspaceFixture, wallClockAhead, type WorkspaceFixture } from '../helpers/fixtures.ts';
import { assertCold } from '../../apps/server/src/modules/resume/coldGuard.ts';
import { killHotHolders } from '../../apps/server/src/modules/resume/hotTakeover.ts';

/**
 * 热会话接管全链（真机实验结论的回归网）：
 * 起「假持有进程」（argv 带 --resume=<sid> 的常驻 node）→ 冷守卫判热 →
 * killHotHolders 精确收割 → 复查变冷 → 调度器在开关开启时接管续跑成功。
 */
let env: TestEnv;
let fixture: WorkspaceFixture;
let holder: ReturnType<typeof spawn> | null = null;
let holderSid = '';

function startHolder(sid: string): ReturnType<typeof spawn> {
  // 常驻进程，命令行精确携带 --resume=<sid>（模拟 VS Code 侧边栏持有形态）。
  // 注意 `--` 分隔：防止 node 把 --resume 当自身参数直接退出（首跑踩过）。
  return spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)', '--', '--resume', sid], { stdio: 'ignore' });
}

before(() => {
  env = makeTestEnv();
  fixture = makeWorkspaceFixture(env.config.projectsRoot, 'ws-hot');
});

after(() => {
  try { holder?.kill('SIGKILL'); } catch { /* 已退 */ }
  env.cleanup();
});

test('假持有进程被冷守卫判热；killHotHolders 精确收割后变冷', async () => {
  holderSid = `hot-holder-${Date.now().toString(36)}-${process.pid}`;
  holder = startHolder(holderSid);
  await new Promise((r) => setTimeout(r, 800)); // 进程起稳

  const hot = await assertCold(holderSid);
  assert.equal(hot.cold, false, '持有进程应被判热');
  assert.ok((hot.pids ?? []).length > 0, '应能枚举到持有 pid');

  const killed = await killHotHolders(holderSid);
  assert.ok(killed.length > 0, '应杀掉至少一个持有进程');
  await new Promise((r) => setTimeout(r, 800));
  const cold = await assertCold(holderSid);
  assert.equal(cold.cold, true, '收割后应判冷');
  holder = null;
});

test('调度器：开关开启 + 静默达标 → 接管续跑成功，audit 记 hot_takeover，tab 复活动作就绪', async () => {
  env.ctx.services.settings.patch({
    hotTakeover: true,
    hotTakeoverQuietMs: 60_000,
    maxAttempts: 2,
    backoffBaseMs: 50,
    backoffCapMs: 120,
  });
  const row = env.ctx.services.sessions.add({
    sessionId: fixture.sessionId,
    projectPath: fixture.projectPath,
    enabled: true,
  });
  void row;
  const outcome = env.ctx.services.intake.handleManual({
    sessionId: fixture.sessionId,
    projectPath: fixture.projectPath,
    httpStatus: 429,
    providerCode: '1308',
    resetAt: wallClockAhead(-60_000), // 已到期，立即调度
  });
  assert.equal(outcome.taskCreated, true);
  const taskId = outcome.task!.id;

  // 转写静默达标：mtime 拨回 10 分钟前
  const tenMinAgo = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(fixture.transcriptFile, tenMinAgo, tenMinAgo);

  // 真持有进程挡路
  holder = startHolder(fixture.sessionId);
  await new Promise((r) => setTimeout(r, 800));

  const task = env.ctx.services.tasks.list(10, 0).find((t) => t.id === taskId)!;
  await env.ctx.services.scheduler.runAttempt(task);

  const afterRun = env.ctx.repos.tasks.byId(taskId);
  assert.equal(afterRun.status, 'resumed', `接管后应续跑成功，实际 ${afterRun.status} ${afterRun.last_error_code ?? ''}`);
  assert.ok(afterRun.verified_leaf_uuid, '血统核验叶应存在');

  // 接管轮真实落盘（fake 引擎追加的帧构成同一条链）
  const lines = fs.readFileSync(fixture.transcriptFile, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 4, '转写应包含初始两帧 + 续跑两帧');

  // 审计应记录接管动作（killed=<pid> coldAfter=true）
  const logs = env.ctx.services.audit.list(50, 0);
  const takeoverLog = logs.find((l) => l.action === 'task.hot_takeover' && l.target === taskId);
  assert.ok(takeoverLog, '应记录 task.hot_takeover');
  assert.match(takeoverLog.detail ?? '', /coldAfter=true/);

  holder?.kill('SIGKILL');
  holder = null;
});
