import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTestEnv, type TestEnv } from '../helpers/testEnv.ts';
import {
  makeWorkspaceFixture,
  type WorkspaceFixture,
} from '../helpers/fixtures.ts';

let env: TestEnv;
let fixture: WorkspaceFixture;

before(() => {
  env = makeTestEnv();
  fixture = makeWorkspaceFixture(env.config.projectsRoot, 'ws-limit');
  process.env.CAR_FAKE_MODE = 'limited'; // 假引擎恒报 429
});

after(() => env.cleanup());

test('到期后仍受限：按退避回 waiting，attempt 递增（§6.3）', async () => {
  const row = env.ctx.services.sessions.add({
    sessionId: fixture.sessionId,
    projectPath: fixture.projectPath,
    enabled: true,
  });
  env.ctx.services.settings.patch({
    maxAttempts: 2,
    backoffBaseMs: 50,
    backoffCapMs: 120,
  });

  const outcome = env.ctx.services.intake.handleManual({
    sessionId: fixture.sessionId,
    projectPath: fixture.projectPath,
    httpStatus: 429,
    providerCode: '1308',
    resetAt: '2026-10-23 00:00:00',
  });
  assert.equal(outcome.taskCreated, true);
  const taskId = outcome.task!.id;

  // 第一次尝试：still-limited → waiting + 退避
  await env.ctx.services.scheduler.runAttempt(
    env.ctx.services.tasks.list(10, 0).find((t) => t.id === taskId)!,
  );
  let task = env.ctx.repos.tasks.byId(taskId);
  assert.equal(task.status, 'waiting');
  assert.equal(task.attempt_count, 1);
  assert.equal(task.last_error_code, 'STILL_LIMITED');
  assert.ok(new Date(task.scheduled_at).getTime() > Date.now());

  // 退避到期后第二次尝试：attempts 耗尽 → paused 等人工，绝不误报成功
  await new Promise((r) => setTimeout(r, 150));
  await env.ctx.services.scheduler.runAttempt(
    env.ctx.services.tasks.list(10, 0).find((t) => t.id === taskId)!,
  );
  task = env.ctx.repos.tasks.byId(taskId);
  assert.equal(task.status, 'paused');
  assert.equal(task.last_error_code, 'STILL_LIMITED');
  assert.equal(task.attempt_count, 2);
  assert.equal(task.verified_leaf_uuid, null);

  // 转写零增长：仍受限时绝不落任何帧（只有初始 u1/a1 两行）
  const lines = fs
    .readFileSync(fixture.transcriptFile, 'utf8')
    .trim()
    .split('\n');
  assert.equal(lines.length, 2);
});

test('paused 任务可手动重试，重试后重新走全链（§5.2）', () => {
  const task = env.ctx.services.tasks
    .list(10, 0)
    .find((t) => t.last_error_code === 'STILL_LIMITED')!;
  const retried = env.ctx.services.tasks.retry(task.id);
  assert.equal(retried.status, 'waiting');
  assert.equal(retried.cancel_requested, 0);
  // attempt 保留，防无限循环
  assert.ok(retried.attempt_count >= 2);

  assert.throws(
    () => env.ctx.services.tasks.retry(task.id),
    (err: unknown) => (err as { code?: string }).code === 'TASK_NOT_RETRYABLE',
  );
});
