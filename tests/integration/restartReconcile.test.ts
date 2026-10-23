import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTestEnv, type TestEnv } from '../helpers/testEnv.ts';
import { buildContext } from '../../apps/server/src/context.ts';
import {
  appendResumeTurn,
  makeWorkspaceFixture,
  type WorkspaceFixture,
} from '../helpers/fixtures.ts';

/**
 * 崩溃对账（§7.3，单位=叶）：进程在 recovering/checking 中途重启，
 * 重开后 reconcileOnBoot 必须给出诚实终态——已落盘→resumed，不明→paused，绝不重发。
 */

let envA: TestEnv;
let fixtureA: WorkspaceFixture;

before(() => {
  envA = makeTestEnv();
  fixtureA = makeWorkspaceFixture(envA.config.projectsRoot, 'ws-reconcile-a');
});

after(() => {
  envA.cleanup();
  envB?.cleanup();
});

let envB: TestEnv | undefined;

function driveToRecovering(env: TestEnv, fixture: WorkspaceFixture): string {
  const row = env.ctx.services.sessions.add({
    sessionId: fixture.sessionId,
    projectPath: fixture.projectPath,
    enabled: true,
  });
  const outcome = env.ctx.services.intake.handleManual({
    sessionId: fixture.sessionId,
    projectPath: fixture.projectPath,
    httpStatus: 429,
    providerCode: '1308',
    resetAt: '2026-10-23 00:00:00',
  });
  const taskId = outcome.task!.id;
  const now = new Date().toISOString();
  assert.equal(env.ctx.repos.tasks.claimWaiting(taskId, now), true);
  const prompt = `继续 [car:auto ${taskId}]`; // 与 settings 模板一致
  assert.equal(
    env.ctx.repos.tasks.toRecovering(taskId, fixture.baseLeafUuid, prompt, now),
    true,
  );
  void row;
  return taskId;
}

test('场景 A：recovering 中崩溃，但续跑轮已落盘 → 重启对账为 resumed', async () => {
  const taskId = driveToRecovering(envA, fixtureA);
  const prompt = `继续 [car:auto ${taskId}]`;
  const turn = appendResumeTurn(fixtureA, prompt, fixtureA.baseLeafUuid);

  // 模拟崩溃：直接关库，用同一数据目录重开新 context
  envA.ctx.db.close();
  const ctx2 = (
    await import('../../apps/server/src/context.ts')
  ).buildContext(envA.config, { env: 'test' });
  const summary = await ctx2.services.scheduler.reconcileOnBoot();

  assert.equal(summary.recoveringResumed, 1);
  const task = ctx2.repos.tasks.byId(taskId);
  assert.equal(task.status, 'resumed');
  assert.equal(task.verified_leaf_uuid, turn.assistantUuid);
  ctx2.db.close();
});

let envB2: TestEnv;
let fixtureB: WorkspaceFixture;
let fixtureC: WorkspaceFixture;

test('场景 B/C 准备：recovering 无落盘 + checking 中途', () => {
  envB2 = makeTestEnv();
  envB = envB2;
  fixtureB = makeWorkspaceFixture(envB2.config.projectsRoot, 'ws-rec-b');
  fixtureC = makeWorkspaceFixture(envB2.config.projectsRoot, 'ws-rec-c');
});

test('场景 B：recovering 中崩溃且无续跑轮 → paused（绝不重发）', async () => {
  const taskId = driveToRecovering(envB2, fixtureB);
  envB2.ctx.db.close();
  const ctx2 = (
    await import('../../apps/server/src/context.ts')
  ).buildContext(envB2.config, { env: 'test' });
  const summary = await ctx2.services.scheduler.reconcileOnBoot();

  assert.equal(summary.recoveringPaused, 1);
  const task = ctx2.repos.tasks.byId(taskId);
  assert.equal(task.status, 'paused');
  assert.equal(task.last_error_code, 'RESUME_RESULT_UNKNOWN');
  assert.equal(task.verified_leaf_uuid, null);
  // 转写零增长
  const lines = fs.readFileSync(fixtureB.transcriptFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  ctx2.db.close();
});

test('场景 C：checking 中崩溃（无副作用）→ 回 waiting 重排队', async () => {
  // 前序场景已关过库，这里用自持上下文重开同一数据目录
  const ctx1 = buildContext(envB2.config, { env: 'test' });
  const row = ctx1.services.sessions.add({
    sessionId: fixtureC.sessionId,
    projectPath: fixtureC.projectPath,
    enabled: true,
  });
  void row;
  const outcome = ctx1.services.intake.handleManual({
    sessionId: fixtureC.sessionId,
    projectPath: fixtureC.projectPath,
    httpStatus: 429,
    providerCode: '1308',
    resetAt: '2026-10-23 00:00:00',
  });
  const taskId = outcome.task!.id;
  assert.equal(
    ctx1.repos.tasks.claimWaiting(taskId, new Date().toISOString()),
    true,
  );

  ctx1.db.close();
  const ctx2 = buildContext(envB2.config, { env: 'test' });
  const summary = await ctx2.services.scheduler.reconcileOnBoot();

  assert.equal(summary.checkingBackToWaiting, 1);
  const task = ctx2.repos.tasks.byId(taskId);
  assert.equal(task.status, 'waiting');
  ctx2.db.close();
});
