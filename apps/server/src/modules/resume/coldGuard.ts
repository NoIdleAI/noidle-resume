import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ColdCheckResult {
  cold: boolean;
  /** 命中的进程号（热持有时）。 */
  pids?: string[];
  /** 检测失败时的原因（按热持有处理，保守拒跑）。 */
  error?: string;
}

/**
 * 冷会话守卫（设计书 §5.1 规则 11 / §13 assertCold）。
 *
 * 探针定案：扩展侧以 `--resume=<sessionId>` 签名 spawn 自带 CLI，
 * 命中即视为热持有，拒绝恢复，避免 silent 分叉。
 * 检测本身失败也按热持有处理（宁可转待确认，不可冒险分叉）。
 */
export async function assertCold(sessionId: string): Promise<ColdCheckResult> {
  const pattern = `--resume[= ]${sessionId}`;
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', '--', pattern], {
      timeout: 5000,
    });
    const pids = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    return { cold: false, pids };
  } catch (err) {
    const e = err as { code?: number; message?: string };
    if (e.code === 1) return { cold: true }; // pgrep 无匹配退出码 1
    return { cold: false, error: e.message ?? String(err) };
  }
}
