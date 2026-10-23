import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiscoveryService } from '../../apps/server/src/modules/discover/discoveryService.ts';
import type { SessionRow } from '../../apps/server/src/persistence/repos/sessions.ts';

function tmpRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'car-disc-')));
}

function writeTranscript(
  root: string,
  projectPath: string,
  sessionId: string,
  frames: unknown[],
  mtimeMs?: number,
  entrypoint: string | null = 'claude-vscode',
): string {
  const dir = path.join(root, projectPath.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const all = entrypoint
    ? [{ type: 'queue-operation', entrypoint, sessionId, operation: 'enqueue' }, ...frames]
    : frames;
  fs.writeFileSync(
    file,
    all.map((f) => JSON.stringify(f)).join('\n') + '\n',
  );
  if (mtimeMs !== undefined) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

function fakeRepo(rows: Partial<SessionRow>[]): { list: () => SessionRow[] } {
  return {
    list: () =>
      rows.map((r, i) => ({
        id: `row-${i}`,
        provider: 'zhipu-glm',
        session_id: '',
        project_path: '',
        display_name: '',
        enabled: 1,
        created_at: '',
        updated_at: '',
        ...r,
      })) as SessionRow[],
  };
}

const cwd = '/tmp/car-disc-workspace/ws1';

test('扫描时间窗内会话：mtime 降序、cwd 归一、建议名取首条用户消息', () => {
  const root = tmpRoot();
  const now = Date.now();
  writeTranscript(root, cwd, 'aaaa-1', [
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: '修复登录页  的样式  问题' }, cwd, timestamp: '' },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant' }, cwd, timestamp: '' },
  ], now - 60_000);
  writeTranscript(root, '/tmp/car-disc-workspace/ws2', 'bbbb-2', [
    { type: 'user', uuid: 'u2', parentUuid: null, message: { role: 'user', content: '<command-name>/abc</command-name>' }, cwd: '/tmp/car-disc-workspace/ws2', timestamp: '' },
    { type: 'user', uuid: 'u3', parentUuid: null, isMeta: true, message: { role: 'user', content: 'meta 帧不当建议名' }, cwd: '/tmp/car-disc-workspace/ws2', timestamp: '' },
    { type: 'user', uuid: 'u4', parentUuid: null, message: { role: 'user', content: [{ type: 'text', text: '数组形态的    用户消息' }] }, cwd: '/tmp/car-disc-workspace/ws2', timestamp: '' },
  ], now - 120_000);

  const svc = new DiscoveryService({ sessions: fakeRepo([]) as never, projectsRoot: root });
  const out = svc.list(24);
  assert.equal(out.length, 2);
  assert.equal(out[0].sessionId, 'aaaa-1'); // 更近的在前
  assert.equal(out[0].suggestedName, '修复登录页 的样式 问题'); // 空白收敛
  assert.ok(out[0].projectPath.endsWith('ws1'));
  assert.equal(out[0].registered, false);
  // 机制性首帧（<command> / isMeta）跳过，建议名落到数组形态文本帧
  assert.equal(out[1].suggestedName, '数组形态的 用户消息');
  assert.ok(out[0].sizeBytes > 0);
  assert.ok(Math.abs(new Date(out[0].lastActiveAt).getTime() - (now - 60_000)) < 2000);
});

test('只收 VS Code 侧边栏会话：entrypoint=claude-vscode，sdk-cli/缺失都排除', () => {
  const root = tmpRoot();
  const now = Date.now();
  const mk = (sid: string, ep: string | null) =>
    writeTranscript(root, cwd, sid, [
      { type: 'user', uuid: sid + '-u', parentUuid: null, message: { role: 'user', content: 'x' }, cwd, timestamp: '' },
    ], now - 60_000, ep);
  mk('vsce-01', 'claude-vscode');
  mk('sdkc-02', 'sdk-cli'); // orbit 守护/SDK headless 驱动
  mk('noep-03', null); // 老版本无标记
  const svc = new DiscoveryService({ sessions: fakeRepo([]) as never, projectsRoot: root });
  assert.deepEqual(svc.list(24).map((s) => s.sessionId), ['vsce-01']);
});

test('ai-title 优先于 summary 和首条用户消息（与侧边栏标题同源）', () => {
  const root = tmpRoot();
  const now = Date.now();
  writeTranscript(root, cwd, 'titl-01', [
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: '首条消息不该当标题' }, cwd, timestamp: '' },
    { type: 'summary', summary: '压实摘要也不该当标题' },
    { type: 'ai-title', aiTitle: '侧边栏就是这个标题' },
  ], now - 60_000);
  const svc = new DiscoveryService({ sessions: fakeRepo([]) as never, projectsRoot: root });
  assert.equal(svc.list(24)[0].suggestedName, '侧边栏就是这个标题');
});

test('大帧吃不满字节窗口时按行数窗口兜底（64KB 截断丢 ai-title 的回归）', () => {
  const root = tmpRoot();
  const now = Date.now();
  const fat = 'x'.repeat(80 * 1024); // 80KB 大帧（模拟图片 base64），单行超旧 64KB 窗口
  writeTranscript(root, cwd, 'fatl-02', [
    { type: 'file-history-snapshot', snapshot: fat, cwd, timestamp: '' },
    { type: 'ai-title', aiTitle: '被大帧顶走的标题' },
  ], now - 60_000);
  const svc = new DiscoveryService({ sessions: fakeRepo([]) as never, projectsRoot: root });
  assert.equal(svc.list(24)[0].suggestedName, '被大帧顶走的标题');
});

test('summary 帧优先作建议名；超出时间窗/垃圾文件忽略；同会话多目录取最近', () => {
  const root = tmpRoot();
  const now = Date.now();
  writeTranscript(root, cwd, 'cccc-3', [
    { type: 'summary', summary: '登录模块修复会话' },
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: '正文首条' }, cwd, timestamp: '' },
  ], now - 30_000);
  // 同一会话的另一编码目录（符链别名场景），更旧 → 去重后不出现
  writeTranscript(root, '/tmp/car-disc-workspace/ws1-alias', 'cccc-3', [
    { type: 'user', uuid: 'u9', parentUuid: null, message: { role: 'user', content: '旧别名' }, cwd, timestamp: '' },
  ], now - 90_000);
  writeTranscript(root, cwd, 'dddd-4', [
    { type: 'user', uuid: 'u0', parentUuid: null, message: { role: 'user', content: '三天前' }, cwd, timestamp: '' },
  ], now - 72 * 3600_000);
  // 超时窗之外
  const oldDir = path.join(root, 'old-dir');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'eeee-5.jsonl'), '{}\n');
  fs.utimesSync(path.join(oldDir, 'eeee-5.jsonl'), new Date(now - 72 * 3600_000), new Date(now - 72 * 3600_000));
  // 垃圾内容不出错
  fs.mkdirSync(path.join(root, 'junk-dir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'junk-dir', 'ffff-6.jsonl'), 'not json at all\n{"cwd":');

  const svc = new DiscoveryService({ sessions: fakeRepo([]) as never, projectsRoot: root });
  const out = svc.list(24);
  assert.deepEqual(out.map((s) => s.sessionId), ['cccc-3']);
  assert.equal(out[0].suggestedName, '登录模块修复会话'); // summary 优先
});

test('registered 标记：同 sessionId 且工作区（含 realpath 归一）一致才认', () => {
  const root = tmpRoot();
  const now = Date.now();
  writeTranscript(root, cwd, 'gggg-7', [
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' }, cwd, timestamp: '' },
  ], now - 10_000);

  const svc = new DiscoveryService({
    sessions: fakeRepo([{ session_id: 'gggg-7', project_path: cwd }]) as never,
    projectsRoot: root,
  });
  assert.equal(svc.list(24)[0].registered, true);

  const other = new DiscoveryService({
    sessions: fakeRepo([
      { session_id: 'other-session', project_path: cwd },
      { session_id: 'gggg-7', project_path: '/tmp/car-disc-别的目录' },
    ]) as never,
    projectsRoot: root,
  });
  assert.equal(other.list(24)[0].registered, false);
});

test('转写根不存在 → 空列表不抛错；hours 越界收敛到 1..336', () => {
  const svc = new DiscoveryService({
    sessions: fakeRepo([]) as never,
    projectsRoot: path.join(os.tmpdir(), 'car-disc-不存在-xyz'),
  });
  assert.deepEqual(svc.list(24), []);
  const root = tmpRoot();
  const now = Date.now();
  writeTranscript(root, cwd, 'hhhh-8', [
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'x' }, cwd, timestamp: '' },
  ], now - 2 * 3600_000);
  const svc2 = new DiscoveryService({ sessions: fakeRepo([]) as never, projectsRoot: root });
  assert.equal(svc2.list(0.5).length, 0); // 收敛到 1h → 2h 前的在窗外
  assert.equal(svc2.list(9999).length, 1); // 收敛到 336h → 在窗内
});
