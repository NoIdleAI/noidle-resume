import { EventEmitter } from 'node:events';
import type { WsEvent, WsEventType } from '@noidle/resume-contracts';

/**
 * 服务内事件总线：模块只管发，API 层订阅转 WebSocket 推送。
 * 每条事件带全局单调 seq——客户端对账用：重连/心跳/轮询发现缺口即补拉快照。
 * 事件只是增量优化，快照才是事实源。
 */
export class EventBus {
  private emitter = new EventEmitter();
  private seqCounter = 0;

  constructor() {
    this.emitter.setMaxListeners(64);
  }

  /** 当前最新事件序号（WS 心跳与 GET /api/v1/revision 对账用；进程内单调）。 */
  get seq(): number {
    return this.seqCounter;
  }

  emit(type: WsEventType, payload: unknown): void {
    const event: WsEvent = {
      type,
      at: new Date().toISOString(),
      payload,
      seq: ++this.seqCounter,
    };
    this.emitter.emit('event', event);
  }

  onEvent(listener: (event: WsEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
