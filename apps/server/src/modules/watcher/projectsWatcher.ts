import fs from 'node:fs';
import { transcriptPath } from '../../adapters/vscode-claude/transcriptLocator.ts';
import type { WatchOffsetsRepo } from '../../persistence/repos/watchOffsets.ts';
import type { Clock } from '../../shared/clock.ts';
import { TranscriptTailer } from './transcriptTailer.ts';

export interface WatchedSession {
  sessionId: string;
  projectPath: string;
}

export interface WatcherDeps {
  projectsRoot: string;
  offsets: WatchOffsetsRepo;
  clock: Clock;
  /** 每条完整 JSONL 行回调（已按会话定位）。 */
  onLine(session: WatchedSession, line: string): void;
  onError?(err: unknown): void;
}

/**
 * 已登记会话的转写监听总管（设计书 §6.1 定案：转写=事件源）。
 * 只监听白名单登记的会话，不扫描无关项目（§11.2 数据最小化）。
 * 首次挂载从文件尾开始：历史 429 不追认，人工登记兜底。
 */
export class ProjectsWatcher {
  private tailers = new Map<string, TranscriptTailer>();

  constructor(private deps: WatcherDeps) {}

  /** 与登记表对齐：新增的挂上，移除的停掉。 */
  sync(sessions: WatchedSession[]): void {
    const wanted = new Map<string, WatchedSession>();
    for (const s of sessions) wanted.set(keyOf(s), s);

    for (const [key, tailer] of this.tailers) {
      if (!wanted.has(key)) {
        tailer.stop();
        this.tailers.delete(key);
      }
    }
    for (const [key, session] of wanted) {
      if (!this.tailers.has(key)) this.startTailer(key, session);
    }
  }

  stopAll(): void {
    for (const t of this.tailers.values()) t.stop();
    this.tailers.clear();
  }

  private startTailer(key: string, session: WatchedSession): void {
    const file = transcriptPath(
      this.deps.projectsRoot,
      session.sessionId,
      session.projectPath,
    );
    let startOffset = this.deps.offsets.get(key);
    if (startOffset === undefined) {
      // 首挂从 EOF 起（历史事件不追认）
      try {
        startOffset = fs.statSync(file).size;
      } catch {
        startOffset = 0;
      }
    }
    const tailer = new TranscriptTailer({
      file,
      startOffset,
      onLines: (lines) => {
        for (const line of lines) {
          try {
            this.deps.onLine(session, line);
          } catch (err) {
            this.deps.onError?.(err);
          }
        }
        this.deps.offsets.set(key, tailer.byteOffset, this.deps.clock.now().toISOString());
      },
      onError: this.deps.onError,
    });
    tailer.start();
    this.tailers.set(key, tailer);
  }
}

export function keyOf(s: WatchedSession): string {
  return `${s.projectPath}::${s.sessionId}`;
}
