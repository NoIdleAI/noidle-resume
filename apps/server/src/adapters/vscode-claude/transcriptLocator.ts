import fs from 'node:fs';
import path from 'node:path';

/**
 * Claude Code 转写定位（adapters/vscode-claude）。
 *
 * 转写布局：`<projectsRoot>/<工作区路径编码>/<sessionId>.jsonl`（探针定案）。
 * 编码规则：路径中所有非字母数字字符替换为 '-'，如
 * /Users/u/WorkSpace → -Users-u-WorkSpace。
 *
 * 身份核验不信任目录名：回读转写帧内的 cwd 字段比对真实工作区路径。
 */

export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-');
}

export function transcriptPath(
  projectsRoot: string,
  sessionId: string,
  projectPath: string,
): string {
  const primary = path.join(
    projectsRoot,
    encodeProjectPath(projectPath),
    `${sessionId}.jsonl`,
  );
  if (fs.existsSync(primary)) return primary;
  // 符号链接容差：注册路径与真实路径（/var → /private/var 之类）编码目录不同时回落
  try {
    const real = fs.realpathSync(projectPath);
    if (real !== projectPath) {
      const secondary = path.join(
        projectsRoot,
        encodeProjectPath(real),
        `${sessionId}.jsonl`,
      );
      if (fs.existsSync(secondary)) return secondary;
    }
  } catch {
    /* realpath 不可得时用 primary */
  }
  return primary;
}

export interface IdentityCheck {
  ok: boolean;
  reason?: string;
}

/**
 * 会话身份核验（设计书 §9.3 / §5.1 规则 8）：
 * 转写文件存在，且帧内 cwd 与登记工作区一致（realpath 归一后比对）。
 */
export function verifySessionIdentity(
  projectsRoot: string,
  sessionId: string,
  projectPath: string,
): IdentityCheck {
  const file = transcriptPath(projectsRoot, sessionId, projectPath);
  if (!fs.existsSync(file)) {
    return { ok: false, reason: `转写不存在: ${path.basename(file)}` };
  }

  let realWorkspace: string;
  try {
    realWorkspace = fs.realpathSync(projectPath);
  } catch {
    return { ok: false, reason: `工作区路径不存在: ${projectPath}` };
  }

  // 只读头部拿 cwd（每帧必带）。窗宽与发现扫描器一致：行数优先、1MB 兜底，
  // 否则大帧顶在前面时读不到任何 cwd 帧 → 假「不一致」
  const head = readHeadLines(file, 120, 1024 * 1024);
  const cwdRe = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;
  for (const line of head) {
    const m = cwdRe.exec(line);
    if (!m?.[1]) continue;
    let frameCwd: string;
    try {
      frameCwd = JSON.parse(`"${m[1]}"`) as string;
    } catch {
      continue;
    }
    let realFrameCwd = frameCwd;
    try {
      realFrameCwd = fs.realpathSync(frameCwd);
    } catch {
      /* 帧内路径可能已不存在，按原样比对 */
    }
    if (realFrameCwd === realWorkspace) return { ok: true };
  }
  return { ok: false, reason: '转写帧内 cwd 与登记工作区不一致' };
}

/**
 * 只读文件头部：按行数为主、字节为兜底上限，分块读避免一次分配。
 * 窗口必须够宽——真实转写前面常有几百 KB 的大帧（图片 base64 等），
 * 64KB 只能盖到两三行 queue-operation，cwd 帧会被整个错过（登记核验假阴性事故）。
 * 身份核验与最近会话发现共用。
 */
export function readHeadLines(file: string, maxLines: number, maxBytes: number): string[] {
  const fd = fs.openSync(file, 'r');
  try {
    const parts: Buffer[] = [];
    let total = 0;
    const buf = Buffer.alloc(64 * 1024);
    while (total < maxBytes) {
      const read = fs.readSync(fd, buf, 0, Math.min(buf.length, maxBytes - total), null);
      if (read <= 0) break;
      total += read;
      parts.push(Buffer.from(buf.subarray(0, read)));
      if (read < buf.length) break; // EOF
    }
    return Buffer.concat(parts).toString('utf8').split('\n').slice(0, maxLines);
  } finally {
    fs.closeSync(fd);
  }
}
