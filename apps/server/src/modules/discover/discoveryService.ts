import fs from 'node:fs';
import path from 'node:path';
import type { DiscoveredSessionDto } from '@noidle/auto-resume-contracts';
import type { SessionsRepo } from '../../persistence/repos/sessions.ts';
import { readHeadLines } from '../../adapters/vscode-claude/transcriptLocator.ts';

/** 头部读取窗口：按行数为主（ai-title/cwd 帧都在前几十行），字节为兜底上限。 */
const HEAD_MAX_LINES = 120;
const HEAD_MAX_BYTES = 1024 * 1024;

/**
 * 最近会话发现（登记下拉的数据源，§10.2 登记体验）。
 *
 * 只读扫描转写根 `<projectsRoot>/<编码目录>/<sessionId>.jsonl`：
 * mtime 在时间窗内的文件，读头部 64KB 取帧内 cwd（与登记核验同源）
 * 和首条用户消息（作展示名建议）。纯扫描，不入库、不落白名单。
 */
export class DiscoveryService {
  constructor(
    private deps: {
      sessions: SessionsRepo;
      projectsRoot: string;
    },
  ) {}

  list(hours?: number): DiscoveredSessionDto[] {
    const windowMs =
      Math.min(Math.max(Number(hours) || 24, 1), 24 * 14) * 3600_000;
    const now = Date.now();
    const root = this.deps.projectsRoot;

    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return []; // 转写根不存在（如本机从未跑过 Claude Code）→ 空下拉
    }

    const candidates: { file: string; mtimeMs: number; size: number }[] = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        let st: fs.Stats;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (!st.isFile() || now - st.mtimeMs > windowMs) continue;
        candidates.push({ file: full, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const out: DiscoveredSessionDto[] = [];
    const seen = new Set<string>();
    for (const c of candidates) {
      if (out.length >= 100) break;
      const sessionId = path.basename(c.file, '.jsonl');
      if (seen.has(sessionId)) continue; // 同会话多编码目录（符链等）→ 取最近
      seen.add(sessionId);
      const head = inspectHead(readHeadLines(c.file, HEAD_MAX_LINES, HEAD_MAX_BYTES));
      // 只收 VS Code 侧边栏会话（§产品范围）：sdk-cli 等守护/脚本驱动的不进候选
      if (head.entrypoint !== 'claude-vscode') continue;
      // 读不出 cwd 的（垃圾文件/全 meta 帧）不进下拉：登记核验过不了，只会误导
      if (!head.cwd) continue;
      let projectPath = head.cwd;
      try {
        projectPath = fs.realpathSync(head.cwd);
      } catch {
        /* 帧内路径已不存在则原样给出，登记时自有核验兜底 */
      }
      out.push({
        sessionId,
        projectPath,
        suggestedName: head.title,
        lastActiveAt: new Date(c.mtimeMs).toISOString(),
        sizeBytes: c.size,
        registered: this.isRegistered(sessionId, projectPath),
      });
    }
    return out;
  }

  private isRegistered(sessionId: string, projectPath: string): boolean {
    for (const s of this.deps.sessions.list()) {
      if (s.session_id !== sessionId) continue;
      if (s.project_path === projectPath) return true;
      try {
        if (fs.realpathSync(s.project_path) === projectPath) return true;
      } catch {
        /* 登记目录已删则按原样不等 */
      }
    }
    return false;
  }
}

const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const AI_TITLE_RE = /"aiTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const SUMMARY_RE = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/;

function unescapeJson(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
}

const ENTRYPOINT_RE = /"entrypoint"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/**
 * 头部帧巡检：cwd 必取；entrypoint 标记启动方（claude-vscode=VS Code 侧边栏，
 * sdk-cli=守护/SDK headless——后者不是人的会话，不进登记候选）；
 * 标题三级优先 = ai-title（扩展写入，与侧边栏一致）> summary（压实摘要）
 * > 首条真实用户消息。字符串级快检在前，只有疑似用户消息帧才 JSON.parse（大帧绝不进 parse）。
 */
function inspectHead(lines: string[]): {
  cwd: string | null;
  title: string | null;
  entrypoint: string | null;
} {
  let cwd: string | null = null;
  let entrypoint: string | null = null;
  let aiT: string | null = null;
  let sumT: string | null = null;
  let userTitle: string | null = null;
  for (const line of lines) {
    if (line.length < 8) continue;
    if (!cwd) {
      const m = CWD_RE.exec(line);
      if (m?.[1]) cwd = unescapeJson(m[1]);
    }
    if (!entrypoint) {
      const m = ENTRYPOINT_RE.exec(line);
      if (m?.[1]) entrypoint = unescapeJson(m[1]);
    }
    if (!aiT && line.includes('"aiTitle"')) {
      const m = AI_TITLE_RE.exec(line);
      if (m?.[1]) {
        const t = unescapeJson(m[1]).replace(/\s+/g, ' ').trim();
        if (t) aiT = t.slice(0, 60);
      }
    } else if (!sumT && line.includes('"type":"summary"')) {
      const m = SUMMARY_RE.exec(line);
      if (m?.[1]) {
        const t = unescapeJson(m[1]).replace(/\s+/g, ' ').trim();
        if (t) sumT = t.slice(0, 60);
      }
    }
    // 快检门：真转写的 type 不是首键（前面常有 parentUuid/cwd 等），用 includes 预筛
    if (!userTitle && line.length < 8192 && line.startsWith('{') && line.includes('"type":"user"')) {
      try {
        const f = JSON.parse(line) as Record<string, unknown>;
        if (f.type === 'user' && f.isMeta !== true) {
          const c = (f.message as { content?: unknown } | undefined)?.content;
          const text =
            typeof c === 'string'
              ? c
              : Array.isArray(c)
                ? c
                    .filter((p) => (p as { type?: string })?.type === 'text')
                    .map((p) => String((p as { text?: string }).text ?? ''))
                    .join(' ')
                : '';
          const clean = text.replace(/\s+/g, ' ').trim();
          // 跳过 <command-name> / <local-command> 之类的机制性首帧
          if (clean && !clean.startsWith('<')) userTitle = clean.slice(0, 60);
        }
      } catch {
        /* 截断/非法行跳过 */
      }
    }
    if (cwd && entrypoint && aiT && userTitle) break; // summary 只是备胎，不进提前退出条件
  }
  return { cwd, title: aiT ?? sumT ?? userTitle, entrypoint };
}
