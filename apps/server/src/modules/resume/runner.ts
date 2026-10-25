import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { transcriptPath } from '../../adapters/vscode-claude/transcriptLocator.ts';
import {
  findUserEntryByContent,
  hasLineage,
  newestDescendantLeaf,
  readTranscriptEntries,
} from './transcript.ts';
import { assertCold, type ColdCheckResult } from './coldGuard.ts';
import { redact } from '../../shared/redact.ts';

const execFileAsync = promisify(execFile);

export type ResumeAttemptKind = 'ok' | 'still-limited' | 'error' | 'timeout';

export interface ResumeAttemptResult {
  kind: ResumeAttemptKind;
  /** 结果 JSON 里的 session_id，用于比对是否分叉。 */
  resultSessionId?: string;
  message?: string;
}

export interface ResumeVerificationResult {
  status: 'verified' | 'pending' | 'unknown';
  leafUuid?: string;
  ourTurnUuid?: string;
  /** 落盘叶的文本内容：调度方据此识别「落盘的其实是 429 仍受限轮次」。 */
  leafText?: string;
  reason?: string;
}

/** §13 ResumeRunner 契约。 */
export interface ResumeRunner {
  assertCold(sessionId: string): Promise<ColdCheckResult>;
  resume(sessionId: string, prompt: string, projectPath: string): Promise<ResumeAttemptResult>;
  verifyResumeLeaf(
    sessionId: string,
    projectPath: string,
    baseLeafUuid: string,
    promptSent: string,
  ): Promise<ResumeVerificationResult>;
}

export interface RunnerOptions {
  claudeBin: string;
  projectsRoot: string;
  /** 支持传 getter，设置热更新即时生效。 */
  timeoutMs: number | (() => number);
}

const STILL_LIMITED_RE = /429|1308|usage limit|使用上限|重置/i;
const MAX_BUFFER = 16 * 1024 * 1024;

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
}

/**
 * 平台策略点 3：Windows 下的 claude 拉起方式。
 * 原生安装（claude.exe）：libuv 自带 PATH 搜索与 argv 引号处理，直 spawn；
 * npm shim（claude.cmd/.bat）：libuv 无法直接 spawn（EINVAL），经
 * `cmd /d /s /c "<整条命令>"` 包装，参数自行按 MSVCRT 规则引号转义。
 * verbatim=true 时 Node 不再加工参数（cmd 不认 \" 转义），整行必须已转义完毕。
 */
export interface SpawnPlan {
  bin: string;
  args: string[];
  verbatim: boolean;
}

export function windowsSpawnPlan(bin: string, args: string[], comspec?: string): SpawnPlan {
  const lower = bin.toLowerCase();
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) {
    return { bin, args, verbatim: false };
  }
  const line = [bin, ...args].map(argvQuote).join(' ');
  return {
    bin: comspec ?? process.env.comspec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  };
}

/**
 * MSVCRT argv 引号规则：无空格无引号的参数裸传；否则整体加引号，
 * 引号写作 反斜杠×(前置反斜杠数×2+1)+"，引号前的连续反斜杠按双倍落尾。
 * 纯函数，单测覆盖（tests/unit/platform.test.ts）。
 */
export function argvQuote(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      slashes++;
      continue;
    }
    if (ch === '"') out += '\\'.repeat(slashes * 2 + 1);
    else out += '\\'.repeat(slashes);
    slashes = 0;
    out += ch;
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}

const whereCache = new Map<string, Promise<string>>();

/**
 * 裸名 claude 在 Windows 的落地解析：`where claude` 探测一次并缓存，
 * .exe 优先（原生安装），回落 .cmd/.bat（npm shim）；探测失败按原样
 * 交给 libuv PATH 搜索。有扩展名的配置按原样直用。
 */
export function resolveWindowsBin(bin: string, run: typeof execFileAsync = execFileAsync): Promise<string> {
  if (/\.(exe|cmd|bat)$/i.test(bin)) return Promise.resolve(bin);
  const cached = whereCache.get(bin);
  if (cached) return cached;
  const probe = run('where.exe', [bin], { timeout: 5000, windowsHide: true })
    .then(({ stdout }) => {
      const hits = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return (
        hits.find((h) => /\.exe$/i.test(h)) ??
        hits.find((h) => /\.(cmd|bat)$/i.test(h)) ??
        bin
      );
    })
    .catch(() => bin);
  whereCache.set(bin, probe);
  return probe;
}

/**
 * 硬结算执行：不管子进程怎么退场都保证落定。
 * 教训（2026-10-24 真机）：CLI 答完轮次后可能因 MCP 子进程等攥住 stdio 不退场，
 * execFile 的 Promise 会永远悬着 → 任务卡 recovering。这里 SIGTERM→SIGKILL→兜底强制结算，
 * 且轮次是否真的落盘以转写核验为准（调度层），进程结局只作归类参考。
 */
function execHardSettled(
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; maxBuffer: number },
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let killed = false;
    let stdout = '';
    let stderr = '';
    // windowsHide：sidecar 本身无控制台，防止子进程另开黑窗闪烁
    const plan =
      process.platform === 'win32'
        ? windowsSpawnPlan(bin, args)
        : ({ bin, args, verbatim: false } satisfies SpawnPlan);
    const child = spawn(plan.bin, plan.args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatim,
    });
    child.stdout?.on('data', (b: Buffer) => {
      if (stdout.length < opts.maxBuffer) stdout += b;
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (stderr.length < opts.maxBuffer) stderr += b;
    });
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(bottomTimer);
      resolve({ stdout, stderr, code, killed });
    };
    const termTimer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.();
    }, opts.timeoutMs);
    // 兜底：close 迟迟不来（孙进程攥管道）也必须在超时后强制结算
    const bottomTimer = setTimeout(() => done(killed ? -1 : null), opts.timeoutMs + 8_000);
    bottomTimer.unref?.();
    child.on('close', (code) => done(code));
    child.on('error', () => done(-1));
  });
}

/**
 * headless CLI 续跑引擎（2026-10-23 探针定案，设计书 §2.3）：
 * `claude -p "<msg>" --resume <sid> --output-format json --permission-mode default`
 * —— 同 session_id 不分叉；--permission-mode default 必须显式带
 * （CLI 2.1.301 headless 免询问回归的压回教训）。
 */
export class ClaudeResumeRunner implements ResumeRunner {
  constructor(private opts: RunnerOptions) {}

  assertCold(sessionId: string): Promise<ColdCheckResult> {
    return assertCold(sessionId);
  }

  async resume(
    sessionId: string,
    prompt: string,
    projectPath: string,
  ): Promise<ResumeAttemptResult> {
    const timeoutMs =
      typeof this.opts.timeoutMs === 'function'
        ? this.opts.timeoutMs()
        : this.opts.timeoutMs;
    const args = [
      '-p',
      prompt,
      '--resume',
      sessionId,
      '--output-format',
      'json',
      '--permission-mode',
      'default',
    ];
    // Windows：裸名先经 where 落地（exe 优先），.cmd shim 再由 spawn 计划包装
    const bin =
      process.platform === 'win32'
        ? await resolveWindowsBin(this.opts.claudeBin)
        : this.opts.claudeBin;
    const out = await execHardSettled(bin, args, {
      cwd: projectPath,
      timeoutMs,
      maxBuffer: MAX_BUFFER,
    });
    // stdout 有结果 JSON 就以它归类（SIGTERM 前结果已打印 = 轮次已完成）
    if (out.stdout.trim()) {
      const classified = classifyResult(out.stdout, sessionId);
      if (classified.kind !== 'error' || !out.killed) return classified;
      // 进程被杀且输出解析不出结果 → 按超时算
    }
    if (out.killed) {
      return { kind: 'timeout', message: `续跑超时(${timeoutMs}ms)被终止` };
    }
    return {
      kind: 'error',
      message: redact(`退出码 ${out.code} ${out.stderr.slice(0, 300)}`),
    };
  }

  async verifyResumeLeaf(
    sessionId: string,
    projectPath: string,
    baseLeafUuid: string,
    promptSent: string,
  ): Promise<ResumeVerificationResult> {
    const file = transcriptPath(this.opts.projectsRoot, sessionId, projectPath);
    let entries;
    try {
      entries = readTranscriptEntries(file);
    } catch {
      return { status: 'unknown', reason: '转写文件不可读' };
    }

    // ① 定位本工具发出的 user 帧（内容全等比对）
    const ourTurn = findUserEntryByContent(entries, promptSent);
    if (!ourTurn?.uuid) {
      return { status: 'pending', reason: '续跑轮尚未落盘（或仍受限未成轮）' };
    }

    // ② 本工具轮必须锚定在恢复起点叶上（血统断言，非文件级启发）
    if (!hasLineage(entries, ourTurn.uuid, baseLeafUuid)) {
      return {
        status: 'unknown',
        reason: '续跑轮血统未穿过恢复起点叶（疑似分叉）',
      };
    }

    // ③ 后代叶即本工具分支的最新落盘叶
    const leaf = newestDescendantLeaf(entries, ourTurn.uuid) ?? ourTurn.uuid;
    return {
      status: 'verified',
      leafUuid: leaf,
      ourTurnUuid: ourTurn.uuid,
      leafText: entryText(entries.find((e) => e.uuid === leaf)),
    };
  }
}

/** 抽取转写帧的文本内容（字符串或 content 块数组）。 */
function entryText(entry: { message?: { content?: string | Array<{ type?: string; text?: string }> } } | undefined): string | undefined {
  const c = entry?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return undefined;
}

interface ClaudeResultJson {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  session_id?: string;
}

/** 解析 --output-format json 的单行结果并归类。 */
export function classifyResult(stdout: string, expectedSessionId: string): ResumeAttemptResult {
  let parsed: ClaudeResultJson | undefined;
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t) as ClaudeResultJson;
      if (j.type === 'result' || 'is_error' in j) parsed = j;
    } catch {
      /* 非结果行 */
    }
  }
  if (!parsed) {
    return {
      kind: 'error',
      message: redact(`无结果 JSON 输出: ${stdout.slice(0, 200)}`),
    };
  }
  if (parsed.session_id && parsed.session_id !== expectedSessionId) {
    return {
      kind: 'error',
      message: `session_id 不符: 期望 ${expectedSessionId}，得到 ${parsed.session_id}`,
    };
  }
  const text =
    typeof parsed.result === 'string'
      ? parsed.result
      : JSON.stringify(parsed.result ?? '');
  if (parsed.is_error === true) {
    if (STILL_LIMITED_RE.test(text)) {
      return { kind: 'still-limited', resultSessionId: parsed.session_id, message: redact(text) };
    }
    return { kind: 'error', resultSessionId: parsed.session_id, message: redact(text) };
  }
  return { kind: 'ok', resultSessionId: parsed.session_id, message: redact(text, 200) };
}
