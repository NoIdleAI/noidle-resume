import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTestEnv, type TestEnv } from '../helpers/testEnv.ts';
import {
  appendResumeTurn,
  limitFrame,
  makeWorkspaceFixture,
  wallClockAhead,
  type WorkspaceFixture,
} from '../helpers/fixtures.ts';
import { hasLineage, readTranscriptEntries } from '../../apps/server/src/modules/resume/transcript.ts';

let env: TestEnv;
let fixture: WorkspaceFixture;

before(() => {
  env = makeTestEnv();
  fixture = makeWorkspaceFixture(env.config.projectsRoot, 'ws1');
});

after(() => env.cleanup());

test('添加会话：身份核验通过，默认不启用（§9.2）', () => {
  const row = env.ctx.services.sessions.add({
    sessionId: fixture.sessionId,
    projectPath: fixture.projectPath,
  });
  assert.equal(row.enabled, 0);
  assert.ok(row.display_name.length > 0);
});

test('重复登记同一会话 → SESSION_ALREADY_EXISTS', () => {
  assert.throws(
    () =>
      env.ctx.services.sessions.add({
        sessionId: fixture.sessionId,
        projectPath: fixture.projectPath,
      }),
    (err: unknown) => (err as { code?: string }).code === 'SESSION_ALREADY_EXISTS',
  );
});

test('转写 cwd 与工作区不符 → SESSION_IDENTITY_UNVERIFIED', () => {
  const other = makeWorkspaceFixture(env.config.projectsRoot, 'ws-mismatch', {
    sessionId: 'sid-mismatch',
  });
  // 别名目录存在但转写在原目录编码下：按别名找不到转写 → 身份不可证
  const alias = other.projectPath + '-alias';
  fs.mkdirSync(alias, { recursive: true });
  assert.throws(
    () =>
      env.ctx.services.sessions.add({
        sessionId: other.sessionId,
        projectPath: alias,
      }),
    (err: unknown) => (err as { code?: string }).code === 'SESSION_IDENTITY_UNVERIFIED',
  );
});

test('未启用会话：事件落库但不建任务（§5.2）', () => {
  const outcome = env.ctx.services.intake.handleTranscriptFrame(
    fixture.sessionId,
    fixture.projectPath,
    limitFrame(fixture, wallClockAhead(3600_000)),
  );
  assert.equal(outcome.recorded, true);
  assert.equal(outcome.taskCreated, false);
  assert.equal(outcome.reason, 'SESSION_NOT_ENABLED');
});

test('启用后：事件建 waiting 任务，重置时刻=调度时刻', () => {
  env.ctx.services.sessions.patch(
    env.ctx.services.sessions.list()[0]!.id,
    { enabled: true },
  );
  // 换一个窗口：上一测试已登记 +1h 的事件（同窗即重复帧，去重会拒收）
  const wall = wallClockAhead(5400_000);
  const outcome = env.ctx.services.intake.handleTranscriptFrame(
    fixture.sessionId,
    fixture.projectPath,
    limitFrame(fixture, wall, 'req_1'),
  );
  assert.equal(outcome.taskCreated, true);
  const task = outcome.task ? env.ctx.repos.tasks.byId(outcome.task.id) : undefined;
  assert.ok(task);
  assert.equal(task!.status, 'waiting');
  const expectedReset = new Date(
    `${wall.replace(' ', 'T')}+08:00`,
  ).toISOString();
  assert.equal(task!.scheduled_at, expectedReset);
});

test('同窗口重复帧 → 哈希去重，不重复建任务（§7.3）', () => {
  const before = env.ctx.services.tasks.list(100, 0).length;
  const outcome = env.ctx.services.intake.handleTranscriptFrame(
    fixture.sessionId,
    fixture.projectPath,
    limitFrame(fixture, wallClockAhead(3600_000), 'req_retry_storm'),
  );
  assert.equal(outcome.recorded, false);
  assert.equal(outcome.reason, 'duplicate');
  const after = env.ctx.services.tasks.list(100, 0).length;
  assert.equal(after, before);

  // 同会话再来一个不同窗口的事件 → 活动任务已存在（TASK_ALREADY_ACTIVE）
  const outcome2 = env.ctx.services.intake.handleTranscriptFrame(
    fixture.sessionId,
    fixture.projectPath,
    limitFrame(fixture, wallClockAhead(7200_000), 'req_2'),
  );
  assert.equal(outcome2.recorded, true);
  assert.equal(outcome2.taskCreated, false);
  assert.equal(outcome2.reason, 'TASK_ALREADY_ACTIVE');
});

test('禁用会话 → waiting 任务被取消（§5.2）', () => {
  const sessionIdRow = env.ctx.services.sessions.list()[0]!;
  env.ctx.services.sessions.patch(sessionIdRow.id, { enabled: false });
  const active = env.ctx.repos.tasks.activeBySessionRowId(sessionIdRow.id);
  assert.equal(active, undefined);
  const task = env.ctx.services.tasks.list(1, 0)[0]!;
  assert.equal(task.status, 'cancelled');
});

test('重新启用 + 人工事件（过去时刻）→ 到期即可调度', () => {
  const sessionIdRow = env.ctx.services.sessions.list()[0]!;
  env.ctx.services.sessions.patch(sessionIdRow.id, { enabled: true });
  const outcome = env.ctx.services.intake.handleManual({
    sessionId: fixture.sessionId,
    projectPath: fixture.projectPath,
    httpStatus: 429,
    providerCode: '1308',
    resetAt: '2026-10-23 00:00:00',
    rawMessage:
      'API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-10-23 00:00:00 重置。]',
  });
  assert.equal(outcome.taskCreated, true);
  const task = outcome.task!;
  assert.equal(task.status, 'waiting');
});

test('调度单次尝试（fake 引擎）→ resumed，叶血统核验通过（§7.2）', async () => {
  const nowIso = new Date().toISOString();
  const due = env.ctx.repos.tasks.due(nowIso, 1)[0];
  assert.ok(due, '应有到期任务');

  await env.ctx.services.scheduler.runAttempt(due);

  const task = env.ctx.repos.tasks.byId(due.id);
  assert.equal(task.status, 'resumed');
  assert.ok(task.base_leaf_uuid);
  assert.equal(task.base_leaf_uuid, fixture.baseLeafUuid);
  assert.ok(task.verified_leaf_uuid);
  const evidence = JSON.parse(task.evidence ?? '{}') as {
    ourTurnUuid?: string;
    verifiedLeafUuid?: string;
  };
  assert.ok(evidence.ourTurnUuid);

  // 转写事实：本工具 user 帧存在，且分支叶穿过恢复起点叶（§15.3-9）
  const entries = readTranscriptEntries(fixture.transcriptFile);
  assert.ok(hasLineage(entries, task.verified_leaf_uuid!, task.base_leaf_uuid!));
  assert.ok(
    entries.some(
      (en) => en.type === 'user' && en.parentUuid === fixture.baseLeafUuid,
    ),
  );
  // 叶已生长：新叶 ≠ 起点
  assert.notEqual(task.verified_leaf_uuid, fixture.baseLeafUuid);

  // 状态与提示词凭据齐全
  assert.match(task.prompt_sent ?? '', /\[car:auto /);
});

test('未登记会话的事件一律丢弃（§11.2）', () => {
  const stranger = makeWorkspaceFixture(env.config.projectsRoot, 'ws-stranger', {
    sessionId: 'sid-stranger',
  });
  const outcome = env.ctx.services.intake.handleTranscriptFrame(
    stranger.sessionId,
    stranger.projectPath,
    limitFrame(stranger, wallClockAhead(3600_000)),
  );
  assert.equal(outcome.recorded, false);
  assert.equal(outcome.reason, '未登记会话，事件丢弃');

  const manual = env.ctx.services.intake.handleManual({
    sessionId: stranger.sessionId,
    projectPath: stranger.projectPath,
    httpStatus: 429,
    providerCode: '1308',
  });
  assert.equal(manual.recorded, false);
});

test('恢复轮真实落盘：fake 引擎追加的帧可被再次核验', () => {
  const entries = readTranscriptEntries(fixture.transcriptFile);
  const resumed = env.ctx.services.tasks
    .list(10, 0)
    .find((t) => t.status === 'resumed');
  assert.ok(resumed);
  const turn = appendResumeTurn(
    fixture,
    '手工探测轮',
    resumed.verified_leaf_uuid!,
  );
  assert.ok(hasLineage(readTranscriptEntries(fixture.transcriptFile), turn.assistantUuid, resumed.verified_leaf_uuid!));
  assert.equal(entries.length > 0, true);
});
