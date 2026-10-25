import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { defaultDataDir } from '../../apps/server/src/config.ts';
import { samePath } from '../../apps/server/src/adapters/vscode-claude/transcriptLocator.ts';
import { windowsResumeProbeArgs } from '../../apps/server/src/modules/resume/coldGuard.ts';
import {
  argvQuote,
  windowsSpawnPlan,
} from '../../apps/server/src/modules/resume/runner.ts';

// ---------- 策略点 1：数据目录 ----------

test('数据目录：win32 用 %APPDATA%，无 APPDATA 时落到用户目录', () => {
  const saved = process.env.APPDATA;
  try {
    process.env.APPDATA = 'C:\\Users\\u\\AppData\\Roaming';
    // 注意：本测试在 mac/linux runner 上也会跑，path.join 取的是宿主分隔符
    assert.equal(
      defaultDataDir('win32'),
      'C:\\Users\\u\\AppData\\Roaming' + path.sep + 'noidle-resume',
    );
    delete process.env.APPDATA;
    assert.equal(
      defaultDataDir('win32'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'noidle-resume'),
    );
  } finally {
    if (saved === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = saved;
  }
});

test('数据目录：darwin 沿用 Library/Application Support', () => {
  const dir = defaultDataDir('darwin');
  assert.ok(dir.includes('Library/Application Support/noidle-resume'));
});

test('数据目录：linux 走 XDG_DATA_HOME，缺省 ~/.local/share', () => {
  const saved = process.env.XDG_DATA_HOME;
  try {
    process.env.XDG_DATA_HOME = '/data/home';
    assert.equal(defaultDataDir('linux'), '/data/home/noidle-resume');
    delete process.env.XDG_DATA_HOME;
    const dir = defaultDataDir('linux');
    assert.ok(dir.endsWith('/.local/share/noidle-resume'));
  } finally {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
  }
});

// ---------- 策略点 2：Windows 冷守卫探针 ----------

test('WQL 探针：等号与空格两种 --resume 形态都覆盖', () => {
  const args = windowsResumeProbeArgs('a1b2c3d4');
  const script = args.at(-1) as string;
  assert.ok(args[0] === '-NoProfile');
  assert.ok(script.includes(`CommandLine LIKE '%--resume=a1b2c3d4%'`));
  assert.ok(script.includes(`CommandLine LIKE '%--resume a1b2c3d4%'`));
});

test('WQL 探针：非法字符被剥离（防注入），不改变合法 UUID', () => {
  const evil = 'abc" OR 1=1 OR CommandLine LIKE "x';
  const script = windowsResumeProbeArgs(evil).at(-1) as string;
  assert.ok(!script.includes('" OR'), '剥离后不应残留引号注入面');
  const uuid = '8a42c431-952b-4314-be06-903f1b58bd38';
  assert.ok(windowsResumeProbeArgs(uuid).at(-1)!.includes(uuid));
});

// ---------- 策略点 4：路径等值判定 ----------

test('samePath：win32 大小写不敏感且 / 与 \\ 等价', () => {
  assert.ok(samePath('C:\\Users\\U\\Proj', 'c:/users/u/proj', 'win32'));
  assert.ok(!samePath('C:\\Users\\U\\Proj', 'C:\\Users\\U\\Other', 'win32'));
});

test('samePath：非 win32 保持大小写敏感的严格等值', () => {
  assert.ok(samePath('/Users/u/Proj', '/Users/u/Proj', 'darwin'));
  assert.ok(!samePath('/Users/u/Proj', '/users/u/proj', 'darwin'));
});

// ---------- 策略点 3：Windows spawn 计划与引号转义 ----------

test('argvQuote：无空格裸传；空格加引号；引号按 MSVCRT 规则转义', () => {
  assert.equal(argvQuote('plain'), 'plain');
  assert.equal(argvQuote(''), '""');
  assert.equal(argvQuote('two words'), '"two words"');
  assert.equal(argvQuote('say "hi"'), '"say \\"hi\\""');
  assert.equal(argvQuote('a\\"b'), '"a\\\\\\"b"'); // a\"b → 反斜杠翻倍 + 引号转义
  // 无空格无引号则裸传：反斜杠只在紧邻引号时才特殊，落尾单反斜杠无需处理
  assert.equal(argvQuote('tail\\'), 'tail\\');
});

test('spawn 计划：exe/裸名直拉；.cmd 经 cmd /d /s /c 包装且 verbatim', () => {
  const direct = windowsSpawnPlan('claude.exe', ['-p', 'hi']);
  assert.deepEqual(direct, { bin: 'claude.exe', args: ['-p', 'hi'], verbatim: false });

  const bare = windowsSpawnPlan('claude', ['-p', 'hi']);
  assert.equal(bare.bin, 'claude');
  assert.equal(bare.verbatim, false);

  const shim = windowsSpawnPlan('C:\\npm\\claude.cmd', ['-p', 'say "hi"'], 'cmd.exe');
  assert.equal(shim.bin, 'cmd.exe');
  assert.equal(shim.verbatim, true);
  assert.deepEqual(shim.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.ok(shim.args[3].startsWith('"C:\\npm\\claude.cmd'));
  assert.ok(shim.args[3].endsWith('"'));
  assert.ok(shim.args[3].includes('"say \\"hi\\""'));
});
