/**
 * 日志脱敏（设计书 §11.4）：只保留来源、错误码、时间、简短原因。
 * 原始错误文本截断存储，不落请求词、密钥与环境变量。
 */
export function truncateText(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** 剔除常见密钥形态的片段，双保险。 */
export function stripSecrets(text: string): string {
  return text
    .replace(/(sk-|api[_-]?key["'=:\s]+|authorization["'=:\s]+|bearer\s+)[^\s"',}]+/gi, '$1***')
    .replace(/[0-9a-f]{32,}/gi, (m) => `${m.slice(0, 6)}***`);
}

export const redact = (text: string, max = 400): string =>
  truncateText(stripSecrets(text), max);
