import { execFile } from 'node:child_process';
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
    try {
      const { stdout } = await execFileAsync(this.opts.claudeBin, args, {
        cwd: projectPath,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
      });
      return classifyResult(stdout, sessionId);
    } catch (err) {
      const e = err as {
        killed?: boolean;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      if (e.killed) {
        return { kind: 'timeout', message: `续跑超时(${timeoutMs}ms)被终止` };
      }
      // 进程非零退出但 stdout 仍可能有结果 JSON（如额度未恢复时的 is_error 结果）
      const combined = `${e.stdout ?? ''}`;
      if (combined.trim()) {
        const classified = classifyResult(combined, sessionId);
        if (classified.kind === 'ok') return classified;
        return classified;
      }
      return {
        kind: 'error',
        message: redact(`${e.message ?? String(err)} ${e.stderr ?? ''}`),
      };
    }
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
    return { status: 'verified', leafUuid: leaf, ourTurnUuid: ourTurn.uuid };
  }
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
