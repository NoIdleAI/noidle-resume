/**
 * 限额识别器（设计书 §6.2 识别规则 + §13 LimitDetector）。
 *
 * 输入：转写 api_error 帧的错误文本（或人工登记的 rawMessage）。
 * 识别规则：
 *  - HTTP 429 + 智谱错误码 1308 同时出现 → 强匹配（confidence: high）。
 *  - 只有 1308 → 仍按限额事件处理（confidence: medium）。
 *  - 只有 429 → 不能断定是 5 小时额度限制，返回 null（不入队）。
 *  - 重置时刻解析失败 → 返回 resetAt=null，由上层进 paused 等人工确认。
 */

export interface ParsedLimit {
  httpStatus: number | null;
  providerCode: string | null;
  /** 墙钟原文，如「2026-10-18 11:37:19」。 */
  resetAtRaw: string | null;
  rawMessage: string;
  confidence: 'high' | 'medium';
}

const RESET_RE = /限额将在\s*(\d{4}-\d{2}-\d{2})[\s T]+(\d{2}:\d{2}:\d{2})\s*重置/;
const CODE_1308_RE = /\[?1308\]?/;
const HTTP_429_RE = /\b429\b/;

export function parseLimitMessage(text: string): ParsedLimit | null {
  const raw = text ?? '';
  const has429 = HTTP_429_RE.test(raw);
  const has1308 = CODE_1308_RE.test(raw);

  if (!has429 && !has1308) return null;
  if (has429 && !has1308) return null; // 普通 429 不足以断定 5 小时限额

  const timeMatch = RESET_RE.exec(raw);
  return {
    httpStatus: has429 ? 429 : null,
    providerCode: has1308 ? '1308' : null,
    resetAtRaw: timeMatch ? `${timeMatch[1]} ${timeMatch[2]}` : null,
    rawMessage: raw,
    confidence: has429 && has1308 ? 'high' : 'medium',
  };
}
