/**
 * 到期后仍受限的指数退避（设计书 §6.3）：
 * base * 2^(attempt-1)，封顶 cap。attempt 从 1 计。
 */
export function backoffDelay(attempt: number, baseMs: number, capMs: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(baseMs * 2 ** (safeAttempt - 1), capMs);
}
