import fs from 'node:fs';

/**
 * 转写读取与叶血统核验（设计书 §2.4 / §5.1 规则 13）。
 *
 * 转写是 parentUuid 树。核验只认血统：从候选叶沿 parentUuid 上溯，
 * 必须穿过指定祖先叶；禁止行号/时间戳/字数等文件级启发式。
 */

export interface TranscriptEntry {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  };
  raw: unknown;
}

export function readTranscriptEntries(file: string): TranscriptEntry[] {
  const text = fs.readFileSync(file, 'utf8');
  const entries: TranscriptEntry[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const raw = JSON.parse(t) as Record<string, unknown>;
      entries.push({
        type: String(raw['type'] ?? ''),
        uuid: typeof raw['uuid'] === 'string' ? raw['uuid'] : undefined,
        parentUuid:
          typeof raw['parentUuid'] === 'string' ? raw['parentUuid'] : null,
        timestamp: typeof raw['timestamp'] === 'string' ? raw['timestamp'] : undefined,
        cwd: typeof raw['cwd'] === 'string' ? raw['cwd'] : undefined,
        message: raw['message'] as TranscriptEntry['message'],
        raw,
      });
    } catch {
      // 坏行跳过：核验以可解析帧为准
    }
  }
  return entries;
}

/** 树的叶 = 出现过 uuid 但从未被任何帧认作 parent 的节点；取最新一笔。 */
export function latestLeafUuid(entries: TranscriptEntry[]): string | null {
  const seen = new Set<string>();
  const parented = new Set<string>();
  for (const e of entries) {
    if (e.uuid) seen.add(e.uuid);
    if (e.parentUuid) parented.add(e.parentUuid);
  }
  let leaf: string | null = null;
  for (const e of entries) {
    if (e.uuid && seen.has(e.uuid) && !parented.has(e.uuid)) leaf = e.uuid;
  }
  return leaf;
}

/** 从 fromUuid 沿 parentUuid 上溯，判断是否经过 ancestorUuid（血统断言）。 */
export function hasLineage(
  entries: TranscriptEntry[],
  fromUuid: string,
  ancestorUuid: string,
): boolean {
  const parentOf = new Map<string, string | null>();
  for (const e of entries) {
    if (e.uuid && !parentOf.has(e.uuid)) {
      parentOf.set(e.uuid, e.parentUuid ?? null);
    }
  }
  const guard = parentOf.size + 1;
  let cur: string | null = fromUuid;
  for (let i = 0; i < guard && cur; i++) {
    if (cur === ancestorUuid) return true;
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

/** user 帧内容归一化为纯文本。 */
export function userEntryText(e: TranscriptEntry): string | null {
  const content = e.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string);
    if (texts.length > 0) return texts.join('\n');
  }
  return null;
}

/** 精确匹配本工具发出的 user 帧（全等比对，不扫描模型输出，防自污染）。 */
export function findUserEntryByContent(
  entries: TranscriptEntry[],
  content: string,
): TranscriptEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.type === 'user' && userEntryText(e) === content) return e;
  }
  return null;
}

/** rootUuid 的后代中，仍是叶（无子节点）的最新一笔。 */
export function newestDescendantLeaf(
  entries: TranscriptEntry[],
  rootUuid: string,
): string | null {
  const parented = new Set<string>();
  const inSubtree = new Set<string>([rootUuid]);
  let grew = true;
  const byUuid = new Map<string, TranscriptEntry>();
  for (const e of entries) {
    if (e.uuid) byUuid.set(e.uuid, e);
  }
  // 多轮迭代收拢子树（轮数=深度，转写深度有限；上限兜底）
  for (let round = 0; round < 512 && grew; round++) {
    grew = false;
    for (const e of entries) {
      if (
        e.uuid &&
        e.parentUuid &&
        inSubtree.has(e.parentUuid) &&
        !inSubtree.has(e.uuid)
      ) {
        inSubtree.add(e.uuid);
        grew = true;
      }
    }
  }
  for (const e of entries) {
    if (e.parentUuid) parented.add(e.parentUuid);
  }
  let leaf: string | null = null;
  for (const e of entries) {
    if (
      e.uuid &&
      inSubtree.has(e.uuid) &&
      e.uuid !== rootUuid &&
      !parented.has(e.uuid)
    ) {
      leaf = e.uuid;
    }
  }
  return leaf;
}
