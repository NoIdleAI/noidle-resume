import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeReviveCommand, transcriptQuiet } from '../../apps/server/src/modules/resume/hotTakeover.ts';

test('静默判定：转写 mtime 早于阈值 → 静默；新写入 → 不静默；文件缺失 → 不静默（保守）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-quiet-'));
  const f = path.join(dir, 't.jsonl');
  fs.writeFileSync(f, 'x\n');
  const now = Date.now();
  fs.utimesSync(f, new Date(now - 30 * 60_000), new Date(now - 30 * 60_000)); // 30 分钟前
  assert.equal(transcriptQuiet(f, 10 * 60_000, now), true);
  fs.utimesSync(f, new Date(now - 60_000), new Date(now - 60_000)); // 1 分钟前
  assert.equal(transcriptQuiet(f, 10 * 60_000, now), false);
  assert.equal(transcriptQuiet(path.join(dir, 'missing.jsonl'), 10 * 60_000, now), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('复活命令：macOS 用 open；Windows 用 cmd start；URI 精确携带 session', () => {
  const mac = makeReviveCommand('abc-123', 'darwin');
  assert.equal(mac.bin, 'open');
  assert.deepEqual(mac.args, ['vscode://anthropic.claude-code/open?session=abc-123']);

  const win = makeReviveCommand('abc-123', 'win32');
  assert.equal(win.bin, 'cmd.exe');
  assert.deepEqual(win.args, ['/d', '/s', '/c', 'start', '', 'vscode://anthropic.claude-code/open?session=abc-123']);
});
