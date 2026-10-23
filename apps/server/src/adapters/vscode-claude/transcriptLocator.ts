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

  // 只读前若干行拿 cwd（会话首帧必带），避免为核验读整个大文件
  const head = readHeadLines(file, 40);
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

function readHeadLines(file: string, n: number): string[] {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, read).toString('utf8');
    return text.split('\n').slice(0, n);
  } finally {
    fs.closeSync(fd);
  }
}
