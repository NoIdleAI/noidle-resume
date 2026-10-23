#!/usr/bin/env node
/**
 * fake-claude：假恢复引擎（测试/冒烟专用，绝不真调模型）。
 *
 * 模拟 `claude -p <prompt> --resume <sid> --output-format json`：
 *  - ok(默认)：向转写追加本工具 user 帧 + assistant 回复帧（叶生长在恢复起点上），
 *    输出成功结果 JSON——让 verifyResumeLeaf 的血统核验走真逻辑。
 *  - limited：不落盘，输出 429/1308 限额结果 JSON，退出码 1。
 *  - error：输出 stderr，退出码 2。
 *
 * 环境变量：CAR_PROJECTS_ROOT（转写根）、CAR_FAKE_MODE（ok|limited|error）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const prompt = argOf('-p') ?? '';
const sid = argOf('--resume');
const mode = process.env.CAR_FAKE_MODE ?? 'ok';
const cwd = process.cwd();
const projectsRoot = process.env.CAR_PROJECTS_ROOT;

if (!sid || !projectsRoot) {
  process.stderr.write('fake-claude: 缺 --resume 或 CAR_PROJECTS_ROOT\n');
  process.exit(2);
}

const encoded = cwd.replace(/[^A-Za-z0-9]/g, '-');
const file = path.join(projectsRoot, encoded, `${sid}.jsonl`);

const readEntries = () => {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return {};
      }
    });
};

const latestLeaf = (entries) => {
  const seen = new Set();
  const parented = new Set();
  for (const e of entries) {
    if (e.uuid) seen.add(e.uuid);
    if (e.parentUuid) parented.add(e.parentUuid);
  }
  let leaf = null;
  for (const e of entries) {
    if (e.uuid && seen.has(e.uuid) && !parented.has(e.uuid)) leaf = e.uuid;
  }
  return leaf;
};

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (mode === 'limited') {
  out({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result:
      'API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-10-24 00:00:00 重置。]',
  });
  process.exit(1);
}
if (mode === 'error') {
  process.stderr.write('fake-claude: 模拟引擎故障\n');
  process.exit(2);
}
if (process.env.CAR_FAKE_NOWRITE === '1') {
  // 只读演练模式：转写根指向真实 ~/.claude/projects 时用——
  // 输出成功结果但绝不向转写落任何帧，叶核验会诚实失败（RESUME_RESULT_UNKNOWN）。
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '（演练模式：未落盘）',
    session_id: sid,
  });
  process.exit(0);
}

// ok：模拟一次真实续跑轮落盘
const entries = readEntries();
const leaf = latestLeaf(entries);
const now = new Date().toISOString();
const userUuid = crypto.randomUUID();
const asstUuid = crypto.randomUUID();
const frames = [
  {
    type: 'user',
    uuid: userUuid,
    parentUuid: leaf,
    message: { role: 'user', content: prompt },
    sessionId: sid,
    cwd,
    timestamp: now,
  },
  {
    type: 'assistant',
    uuid: asstUuid,
    parentUuid: userUuid,
    message: { role: 'assistant', content: [{ type: 'text', text: '好的，继续。' }] },
    sessionId: sid,
    cwd,
    timestamp: now,
  },
];
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.appendFileSync(file, frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
out({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '好的，继续。',
  session_id: sid,
});
