#!/usr/bin/env node
/**
 * 冒烟：起真服务（假恢复引擎），走 API 全链——
 * 登记会话 → 启用 → 人工限额事件(2 秒后重置) → 调度到期 → headless 续跑 → 叶血统核验 → resumed。
 * 全程零真模型调用、零真额度消耗。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CAR_SMOKE_PORT ?? 7846);
const BASE = `http://127.0.0.1:${PORT}`;

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'car-smoke-')));
const projectsRoot = path.join(root, 'projects');
const dataDir = path.join(root, 'data');
fs.mkdirSync(projectsRoot, { recursive: true });

// ---- fake bin 壳 ----
const binDir = path.join(root, 'bin');
fs.mkdirSync(binDir, { recursive: true });
const fakeBin = path.join(binDir, 'fake-claude');
fs.writeFileSync(
  fakeBin,
  `#!/bin/sh\nexec node "${path.join(REPO, 'scripts', 'fake-claude.mjs')}" "$@"\n`,
  { mode: 0o755 },
);

// ---- 夹具工作区 + 初始转写 ----
const sessionId = `smoke-${Date.now().toString(36)}`;
const projectPath = path.join(projectsRoot, 'workspaces', 'ws-smoke');
fs.mkdirSync(projectPath, { recursive: true });
const encoded = projectPath.replace(/[^A-Za-z0-9]/g, '-');
const transcriptDir = path.join(projectsRoot, encoded);
fs.mkdirSync(transcriptDir, { recursive: true });
const transcriptFile = path.join(transcriptDir, `${sessionId}.jsonl`);
const baseLeaf = 'smoke-a1';
fs.writeFileSync(
  transcriptFile,
  [
    JSON.stringify({
      type: 'user', uuid: 'smoke-u1', parentUuid: null,
      message: { role: 'user', content: '冒烟初始问题' },
      sessionId, cwd: projectPath, timestamp: new Date().toISOString(),
    }),
    JSON.stringify({
      type: 'assistant', uuid: baseLeaf, parentUuid: 'smoke-u1',
      message: { role: 'assistant', content: [{ type: 'text', text: '初始回答' }] },
      sessionId, cwd: projectPath, timestamp: new Date().toISOString(),
    }),
  ].join('\n') + '\n',
);

// ---- 起服务 ----
const child = spawn('node', ['--import', 'tsx', 'apps/server/src/index.ts'], {
  cwd: REPO,
  env: {
    ...process.env,
    CAR_DATA_DIR: dataDir,
    CAR_PROJECTS_ROOT: projectsRoot,
    CAR_CLAUDE_BIN: fakeBin,
    CAR_PORT: String(PORT),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = (stream) => (buf) =>
  process.stdout.write(`[server.${stream}] ${buf}`);
child.stdout.on('data', serverLog('out'));
child.stderr.on('data', serverLog('err'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/health`);
      if (res.ok) return await res.json();
    } catch {
      /* 未起 */
    }
    if (child.exitCode !== null) throw new Error(`服务提前退出: ${child.exitCode}`);
    await sleep(300);
  }
  throw new Error('健康检查超时');
}

const api = async (method, url, payload) => {
  const token = fs.readFileSync(path.join(dataDir, 'token.txt'), 'utf8').trim();
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};

let failed = false;
try {
  console.log('① 健康检查…');
  console.log('  ', JSON.stringify(await waitHealth()));

  console.log('② 登记会话（默认不启用）…');
  const add = await api('POST', '/api/v1/sessions', {
    sessionId,
    projectPath,
    displayName: '冒烟会话',
  });
  if (add.status !== 200) throw new Error(`登记失败: ${JSON.stringify(add)}`);
  const sid = add.body.session.id;
  console.log('  ', sid, 'enabled =', add.body.session.enabled);

  console.log('③ 启用白名单…');
  const en = await api('PATCH', `/api/v1/sessions/${sid}`, { enabled: true });
  if (en.body.session?.enabled !== true) throw new Error('启用失败');

  console.log('④ 人工登记限额事件（2 秒后重置）…');
  const d = new Date(Date.now() + 2000);
  const pad = (n) => String(n).padStart(2, '0');
  const resetWall = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const ev = await api('POST', '/api/v1/events/usage-limit', {
    sessionId,
    projectPath,
    httpStatus: 429,
    providerCode: '1308',
    resetAt: resetWall,
    rawMessage: `Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 ${resetWall} 重置。][smoke]`,
  });
  if (ev.body.taskCreated !== true) throw new Error(`事件未建任务: ${JSON.stringify(ev.body)}`);

  console.log('⑤ 等待调度到期 → 自动续跑 → 叶核验…');
  let finalTask = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const list = await api('GET', '/api/v1/tasks');
    finalTask = list.body.tasks.find((t) => t.status !== 'cancelled') ?? list.body.tasks[0];
    if (finalTask && ['resumed', 'paused', 'failed'].includes(finalTask.status)) break;
    await sleep(400);
  }
  if (!finalTask) throw new Error('未观察到任务');
  console.log('   任务终态:', finalTask.status, finalTask.lastErrorCode ?? '');
  console.log('   核验叶:', finalTask.verifiedLeafUuid);

  console.log('⑥ 转写事实核验…');
  const lines = fs.readFileSync(transcriptFile, 'utf8').trim().split('\n');
  const frames = lines.map((l) => JSON.parse(l));
  const ourTurn = frames.find((f) => f.type === 'user' && f.parentUuid === baseLeaf);
  console.log(`   转写共 ${lines.length} 帧；本工具轮 user 帧:`, ourTurn ? '存在 ✓' : '缺失 ✗');

  failed = !(
    finalTask.status === 'resumed' &&
    finalTask.verifiedLeafUuid &&
    ourTurn
  );
  console.log(failed ? '✗ 冒烟未通过' : '✓ 冒烟全链通过（登记→启用→限额→调度→续跑→叶核验）');
} catch (err) {
  failed = true;
  console.error('✗ 冒烟失败:', err.message);
} finally {
  child.kill('SIGTERM');
  await sleep(500);
  if (child.exitCode === null) child.kill('SIGKILL');
  console.log('（现场保留在', root, '，可人工查看）');
}
process.exit(failed ? 1 : 0);
