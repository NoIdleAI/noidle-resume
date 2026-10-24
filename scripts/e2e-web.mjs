#!/usr/bin/env node
/**
 * 阶段三 Web 管理面 E2E：真服务（托管 apps/web/dist）+ 真浏览器走 UI 全链。
 * 登录令牌门 → 登记会话 → 启用 → 人工登记限额(2 秒后重置) → 总览主任务卡
 * → 等到「已恢复」→ 任务详情核验叶 → 设置页保存。全程零真模型调用。
 * 产物：/tmp/car-e2e-shots/*.png（人工目验用）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CAR_E2E_PORT ?? 7847);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = '/tmp/car-e2e-shots';
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

// ---- 临时环境（同 smoke：假引擎 + 夹具转写） ----
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'car-e2e-')));
const projectsRoot = path.join(root, 'projects');
const dataDir = path.join(root, 'data');
fs.mkdirSync(projectsRoot, { recursive: true });
const binDir = path.join(root, 'bin');
fs.mkdirSync(binDir, { recursive: true });
const fakeBin = path.join(binDir, 'fake-claude');
fs.writeFileSync(
  fakeBin,
  `#!/bin/sh\nexec node "${path.join(REPO, 'scripts', 'fake-claude.mjs')}" "$@"\n`,
  { mode: 0o755 },
);

const sessionId = `e2e-${Date.now().toString(36)}`;
const projectPath = path.join(projectsRoot, 'workspaces', 'ws-e2e');
fs.mkdirSync(projectPath, { recursive: true });
const encoded = projectPath.replace(/[^A-Za-z0-9]/g, '-');
const transcriptDir = path.join(projectsRoot, encoded);
fs.mkdirSync(transcriptDir, { recursive: true });
const transcriptFile = path.join(transcriptDir, `${sessionId}.jsonl`);
const baseLeaf = 'e2e-a1';
fs.writeFileSync(
  transcriptFile,
  [
    // 发现扫描只收 VS Code 侧边栏会话（entrypoint 标记），夹具须带
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', entrypoint: 'claude-vscode', sessionId }),
    JSON.stringify({
      type: 'user', uuid: 'e2e-u1', parentUuid: null,
      message: { role: 'user', content: 'E2E 初始问题' },
      sessionId, cwd: projectPath, timestamp: new Date().toISOString(),
    }),
    JSON.stringify({
      type: 'assistant', uuid: baseLeaf, parentUuid: 'e2e-u1',
      message: { role: 'assistant', content: [{ type: 'text', text: '初始回答' }] },
      sessionId, cwd: projectPath, timestamp: new Date().toISOString(),
    }),
  ].join('\n') + '\n',
);

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
child.stdout.on('data', (b) => process.stdout.write(`[server] ${b}`));
child.stderr.on('data', (b) => process.stderr.write(`[server!] ${b}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/health`);
      if (res.ok) return;
    } catch { /* 未起 */ }
    if (child.exitCode !== null) throw new Error(`服务提前退出: ${child.exitCode}`);
    await sleep(300);
  }
  throw new Error('健康检查超时');
}

let failed = false;
let browser;
try {
  await waitHealth();
  const token = fs.readFileSync(path.join(dataDir, 'token.txt'), 'utf8').trim();
  console.log('① 服务已起，令牌已取');

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1500 } });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  // ② 令牌门
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type="password"]', { timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/01-gate.png`, fullPage: true });
  await page.fill('input[type="password"]', 'wrong-token-first');
  await page.click('button:has-text("进入值守台")');
  await page.waitForSelector('.form-error', { timeout: 8000 });
  console.log('② 错误令牌被拒 ✓');
  await page.fill('input[type="password"]', token);
  await page.click('button:has-text("进入值守台")');
  await page.waitForSelector('header.top', { timeout: 8000 });
  console.log('③ 正确令牌进入 ✓');
  await page.screenshot({ path: `${SHOTS}/02-dashboard-empty.png`, fullPage: true });

  // ③ 登记会话（走「最近会话发现」自绘下拉）→ 启用
  await page.click('nav.nav >> text=会话');
  // 等扫描完成：触发钮文案出现「发现」
  await page.waitForFunction(
    () => (document.querySelector('.pick-trigger')?.textContent ?? '').includes('发现'),
    undefined,
    { timeout: 8000, polling: 300 },
  );
  await page.click('.pick-trigger');
  await page.waitForSelector('.pick-item', { timeout: 5000 });
  // 夹具转写无 ai-title/summary → 建议名 = 首条用户消息
  await page.click('.pick-item:has-text("E2E 初始问题")');
  const sidFilled = await page.inputValue('input[placeholder="claude 会话 UUID"]');
  if (sidFilled !== sessionId) throw new Error('下拉选择未自动填充 sessionId');
  const ppFilled = await page.inputValue('input[placeholder="/Users/you/WorkSpace/my-app"]');
  if (!ppFilled.endsWith('ws-e2e')) throw new Error('下拉选择未自动填充工作区路径');
  await page.fill('input[placeholder="后端接口开发"]', 'E2E 值守会话');
  await page.screenshot({ path: `${SHOTS}/03-sessions-form.png`, fullPage: true });
  console.log('④ 最近会话下拉 → 自动填充 ✓');
  await page.click('button:has-text("登记并核验身份")');
  await page.waitForSelector('.form-ok', { timeout: 8000 });
  console.log('⑤ 加入自动化列表 ✓');
  await page.waitForSelector('.list .row', { timeout: 8000 });
  const rowText = await page.locator('.list .row').first().innerText();
  if (!rowText.includes('监控中')) throw new Error('列表行未显示监控中（加列表即守护语义失效）');
  await page.screenshot({ path: `${SHOTS}/04-sessions-enabled.png`, fullPage: true });
  console.log('⑥ 自动化列表就绪（加列表即守护，无开关）✓');

  // ⑤ 补录撞限：粘贴限额原文 → 自动解析重置时刻（+3 秒）→ 补录
  await page.click('button:has-text("补录限额")');
  await page.waitForSelector('.dialog', { timeout: 5000 });
  const d = new Date(Date.now() + 3000 + 8 * 3600_000); // Asia/Shanghai 墙上钟
  const p = (n) => String(n).padStart(2, '0');
  const resetWall = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  await page.fill(
    '.dialog textarea',
    `API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 ${resetWall} 重置。][e2e-raw]`,
  );
  await page.click('button:has-text("解析并填充")');
  await page.waitForFunction(
    () => (document.querySelector('.dialog input[type="datetime-local"]') ?? {}).value?.length === 19,
    undefined,
    { timeout: 8000, polling: 200 },
  );
  await page.screenshot({ path: `${SHOTS}/05-manual-event.png`, fullPage: true });
  await page.click('.dialog button:has-text("补录")');
  await page.waitForSelector('.dialog .form-ok', { timeout: 8000 });
  console.log('⑦ 补录撞限（粘贴自动解析）→ 任务入队 ✓');
  await page.screenshot({ path: `${SHOTS}/05-manual-event.png`, fullPage: true });
  // 点弹层外部关闭（overlay @click.self）
  await page.mouse.click(20, 20);
  await page.waitForSelector('.overlay', { state: 'detached', timeout: 5000 });

  // ⑤ 总览主任务卡 → 等到已恢复
  await page.click('nav.nav >> text=总览');
  await page.waitForSelector('.hero', { timeout: 8000 });
  await page.screenshot({ path: `${SHOTS}/06-hero-waiting.png`, fullPage: true });
  const heroText = await page.locator('.hero').innerText();
  if (!heroText.includes('E2E 值守会话')) throw new Error('主任务卡未显示会话名');
  if (!heroText.includes('429') || !heroText.includes('1308')) throw new Error('主任务卡缺证据标签');
  console.log('⑧ 主任务卡（倒计时/窗口/证据/时间线）✓');

  await page.waitForFunction(
    () => document.querySelector('.hero .chip')?.textContent?.includes('已恢复'),
    undefined,
    { timeout: 40000, polling: 500 },
  );
  console.log('⑨ 调度 → 续跑 → 叶核验 → 已恢复 ✓');
  await page.screenshot({ path: `${SHOTS}/07-hero-resumed.png`, fullPage: true });

  // ⑥ 详情页
  await page.click('.hero button:has-text("详情")');
  await page.waitForSelector('.subcard', { timeout: 8000 });
  const detailText = await page.locator('.hero').innerText();
  if (!detailText.includes('恢复成功')) throw new Error('详情页缺「恢复成功」解读');
  if (!detailText.includes('verifiedLeaf') || !detailText.includes('baseLeaf')) {
    throw new Error('详情页缺叶信息');
  }
  await page.screenshot({ path: `${SHOTS}/08-task-detail.png`, fullPage: true });
  console.log('⑩ 任务详情（六问齐全）✓');

  // ⑦ 设置页保存
  await page.click('nav.nav >> text=设置');
  await page.waitForSelector('button:has-text("保存")', { timeout: 8000 });
  const maxInput = page.locator('.field input[type="number"]').first();
  await maxInput.fill('4');
  await page.click('button:has-text("保存")');
  await page.waitForSelector('.form-ok', { timeout: 8000 });
  await page.screenshot({ path: `${SHOTS}/09-settings.png`, fullPage: true });
  console.log('⑪ 设置保存 ✓');

  // ⑧ 转写事实
  const lines = fs.readFileSync(transcriptFile, 'utf8').trim().split('\n');
  const frames = lines.map((l) => JSON.parse(l));
  const ourTurn = frames.find((f) => f.type === 'user' && f.parentUuid === baseLeaf);
  console.log(`⑫ 转写 ${lines.length} 帧；本工具轮 user 帧:`, ourTurn ? '存在 ✓' : '缺失 ✗');

  failed = !ourTurn;
  console.log(failed ? '✗ E2E 未通过' : '✓ Web 管理面 E2E 全链通过（门→登记→启用→限额→值守→恢复→详情→设置）');
} catch (err) {
  failed = true;
  console.error('✗ E2E 失败:', err.message);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  child.kill('SIGTERM');
  await sleep(400);
  if (child.exitCode === null) child.kill('SIGKILL');
  console.log('（截图在', SHOTS, '；现场保留在', root, '）');
}
process.exit(failed ? 1 : 0);
