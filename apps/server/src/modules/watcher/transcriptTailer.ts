import fs from 'node:fs';

export interface TailerOptions {
  file: string;
  startOffset: number;
  /** 每批完整行回调。 */
  onLines(lines: string[]): void;
  onError?(err: unknown): void;
}

/**
 * 单文件追加监听：fs.watch 为主、轮询兜底，按字节偏移增量读。
 * 文件被截断（异常重写）时归零重放——上层 event_hash 去重兜底。
 * 转写是 append-only（探针定案），此路径只为防御。
 */
export class TranscriptTailer {
  private offset: number;
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private buf = '';
  private reading = false;
  private stopped = false;

  constructor(private opts: TailerOptions) {
    this.offset = opts.startOffset;
  }

  get byteOffset(): number {
    return this.offset;
  }

  start(): void {
    this.attachWatch();
    this.pollTimer = setInterval(() => this.read(), 3000);
    this.pollTimer.unref?.();
    // 启动立即读一次，尽快追上积压
    queueMicrotask(() => this.read());
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private attachWatch(): void {
    if (this.stopped || this.watcher) return;
    try {
      this.watcher = fs.watch(this.opts.file, (eventType) => {
        if (eventType === 'change') this.read();
        if (eventType === 'rename') {
          // 文件可能被重建：下个 tick 重挂 watch
          this.watcher?.close();
          this.watcher = null;
          setTimeout(() => this.attachWatch(), 1000)?.unref?.();
          this.read();
        }
      });
      // 不持事件循环：进程存活的持有点是 HTTP server；
      // 这样测试/多上下文场景下未 stop 的 tailer 也不会钉死进程
      this.watcher.unref?.();
    } catch {
      // 文件尚不存在：交给轮询，出现后由 read() 再挂 watch
    }
  }

  private read(): void {
    if (this.stopped || this.reading) return;
    this.reading = true;
    try {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(this.opts.file);
      } catch {
        return; // 文件未出现
      }
      if (stat.size < this.offset) {
        this.offset = 0; // 截断 → 重放（hash 去重）
        this.buf = '';
      }
      if (stat.size === this.offset) return;

      if (!this.watcher) this.attachWatch();

      const fd = fs.openSync(this.opts.file, 'r');
      try {
        const chunk = Buffer.alloc(stat.size - this.offset);
        fs.readSync(fd, chunk, 0, chunk.length, this.offset);
        this.offset += chunk.length;
        this.buf += chunk.toString('utf8');
        const parts = this.buf.split('\n');
        this.buf = parts.pop() ?? '';
        const lines = parts.filter((l) => l.trim().length > 0);
        if (lines.length > 0) this.opts.onLines(lines);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.reading = false;
    }
  }
}
