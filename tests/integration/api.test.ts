import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestEnv, type TestEnv } from '../helpers/testEnv.ts';
import {
  limitFrame,
  makeWorkspaceFixture,
  wallClockAhead,
  type WorkspaceFixture,
} from '../helpers/fixtures.ts';
import { buildApp } from '../../apps/server/src/api/app.ts';
import type { FastifyInstance } from 'fastify';

let env: TestEnv;
let app: FastifyInstance;
let fixture: WorkspaceFixture;
let bearer: Record<string, string>;
let cookie: string;

before(() => {
  env = makeTestEnv();
  app = buildApp(env.ctx);
  fixture = makeWorkspaceFixture(env.config.projectsRoot, 'ws-api');
  bearer = {
    'content-type': 'application/json',
    authorization: `Bearer ${env.ctx.token}`,
  };
});

after(() => env.cleanup());

test('health 无需鉴权（仅暴露最小信息）', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test('无令牌访问业务接口 → 401 UNAUTHORIZED', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/sessions' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'UNAUTHORIZED');
});

test('Host 非本机 → 401（防 DNS rebinding，§11.1）', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/sessions',
    headers: { host: 'evil.example.com:7842', authorization: `Bearer ${env.ctx.token}` },
  });
  assert.equal(res.statusCode, 401);
});

test('添加会话（默认不启用）+ 重复登记 409', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    headers: bearer,
    payload: { sessionId: fixture.sessionId, projectPath: fixture.projectPath },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().session.enabled, true); // 加列表即守护（2026-10-24 语义）

  const dup = await app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    headers: bearer,
    payload: { sessionId: fixture.sessionId, projectPath: fixture.projectPath },
  });
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json().error.code, 'SESSION_ALREADY_EXISTS');
});

test('启用会话 → 人工登记限额事件 → 建任务', async () => {
  const id = env.ctx.services.sessions.list()[0]!.id;
  const en = await app.inject({
    method: 'PATCH',
    url: `/api/v1/sessions/${id}`,
    headers: bearer,
    payload: { enabled: true },
  });
  assert.equal(en.statusCode, 200);
  assert.equal(en.json().session.enabled, true);

  const ev = await app.inject({
    method: 'POST',
    url: '/api/v1/events/usage-limit',
    headers: bearer,
    payload: {
      sessionId: fixture.sessionId,
      projectPath: fixture.projectPath,
      httpStatus: 429,
      providerCode: '1308',
      resetAt: wallClockAhead(3600_000),
      rawMessage: `Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 ${wallClockAhead(3600_000)} 重置。]`,
    },
  });
  assert.equal(ev.statusCode, 200);
  assert.equal(ev.json().taskCreated, true);
});

test('任务列表/详情（任务级手动动词已退役：cancel/retry/pause 端点 404）', async () => {
  const list = await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: bearer });
  assert.equal(list.statusCode, 200);
  const task = list.json().tasks[0];
  assert.ok(task);
  assert.equal(task.status, 'waiting');

  const one = await app.inject({
    method: 'GET',
    url: `/api/v1/tasks/${task.id}`,
    headers: bearer,
  });
  assert.equal(one.statusCode, 200);

  const retired = await app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${task.id}/cancel`,
    headers: bearer,
  });
  assert.equal(retired.statusCode, 404);

  const gone = await app.inject({
    method: 'GET',
    url: '/api/v1/tasks/nonexistent',
    headers: bearer,
  });
  assert.equal(gone.statusCode, 404);
  assert.equal(gone.json().error.code, 'NOT_FOUND');
});

test('事件列表 + 日志列表', async () => {
  const events = await app.inject({
    method: 'GET',
    url: '/api/v1/events/usage-limit',
    headers: bearer,
  });
  assert.equal(events.statusCode, 200);
  assert.ok(events.json().events.length >= 1);

  const logs = await app.inject({ method: 'GET', url: '/api/v1/logs', headers: bearer });
  assert.equal(logs.statusCode, 200);
  assert.ok(logs.json().logs.length >= 1);
});

test('设置：非法时区 400；合法更新生效', async () => {
  const bad = await app.inject({
    method: 'PATCH',
    url: '/api/v1/settings',
    headers: bearer,
    payload: { timezone: 'Mars/Phobos' },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'VALIDATION_ERROR');

  const ok = await app.inject({
    method: 'PATCH',
    url: '/api/v1/settings',
    headers: bearer,
    payload: { maxAttempts: 7 },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().settings.maxAttempts, 7);

  const missing = await app.inject({
    method: 'PATCH',
    url: '/api/v1/settings',
    headers: bearer,
    payload: { resumePromptTemplate: '没有占位符' },
  });
  assert.equal(missing.statusCode, 400);
});

test('未登记会话的人工事件 → 422 USAGE_EVENT_UNASSOCIATED', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/events/usage-limit',
    headers: bearer,
    payload: {
      sessionId: 'sid-ghost',
      projectPath: fixture.projectPath,
      httpStatus: 429,
      providerCode: '1308',
    },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, 'USAGE_EVENT_UNASSOCIATED');
});

test('浏览器 Cookie 授权：verify 下发 → 写操作需 X-CAR-Auth 头（CSRF 防护）', async () => {
  const verify = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify',
    headers: { authorization: `Bearer ${env.ctx.token}` },
  });
  assert.equal(verify.statusCode, 200);
  const setCookie = verify.cookies[0];
  assert.ok(setCookie);
  assert.equal(setCookie.httpOnly, true);
  cookie = `${setCookie.name}=${setCookie.value}`;

  // Cookie 已有但缺自定义头 → 401（跨站无法伪造自定义头）
  const noHeader = await app.inject({
    method: 'PATCH',
    url: '/api/v1/settings',
    headers: { 'content-type': 'application/json', cookie },
    payload: {},
  });
  assert.equal(noHeader.statusCode, 401);

  // 带头但 Origin 恶意 → 401
  const evilOrigin = await app.inject({
    method: 'PATCH',
    url: '/api/v1/settings',
    headers: {
      'content-type': 'application/json',
      cookie,
      'x-car-auth': '1',
      origin: 'http://evil.example.com',
    },
    payload: {},
  });
  assert.equal(evilOrigin.statusCode, 401);

  // 同源 + 自定义头 → 200
  const good = await app.inject({
    method: 'PATCH',
    url: '/api/v1/settings',
    headers: {
      'content-type': 'application/json',
      cookie,
      'x-car-auth': '1',
      origin: 'http://localhost:7842',
    },
    payload: {},
  });
  assert.equal(good.statusCode, 200);

  // Cookie 读操作无需自定义头
  const read = await app.inject({
    method: 'GET',
    url: '/api/v1/sessions',
    headers: { cookie },
  });
  assert.equal(read.statusCode, 200);
});

test('转写监听接线：tailer 增量读到限额帧 → 自动建任务', async () => {
  const id = env.ctx.services.sessions.list()[0]!.id;
  env.ctx.services.sessions.patch(id, { enabled: true });

  // 直接驱动 watcher 的 onLine（不真开 fs.watch，避免测试抖动）
  const ws = makeWorkspaceFixture(env.config.projectsRoot, 'ws-api2', {
    sessionId: fixture.sessionId + 'x',
  });
  const row2 = env.ctx.services.sessions.add({
    sessionId: ws.sessionId,
    projectPath: ws.projectPath,
    enabled: true,
  });
  void row2;
  const outcome = env.ctx.services.intake.handleTranscriptFrame(
    ws.sessionId,
    ws.projectPath,
    limitFrame(ws, wallClockAhead(3600_000), 'req_tail'),
  );
  assert.equal(outcome.taskCreated, true);
  assert.equal(outcome.task!.status, 'waiting');
});

test('revision 对账端点：随事件单调递增（2026-10-25 冻结事故的兜底层）', async () => {
  const before = await app.inject({ method: 'GET', url: '/api/v1/revision', headers: bearer });
  assert.equal(before.statusCode, 200);
  const seq0 = before.json().seq;
  assert.ok(Number.isInteger(seq0));
  // 发一条事件（总线直发）后 seq 必须前进
  env.ctx.bus.emit('service.note', { note: 'test' });
  const after = await app.inject({ method: 'GET', url: '/api/v1/revision', headers: bearer });
  assert.ok(after.json().seq > seq0, `seq 应前进: ${seq0} -> ${after.json().seq}`);
});

test('revision 未鉴权 → 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/revision' });
  assert.equal(res.statusCode, 401);
});
