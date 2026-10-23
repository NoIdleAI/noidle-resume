import { EventEmitter } from 'node:events';
import type { WsEvent, WsEventType } from '@noidle/auto-resume-contracts';

/** 服务内事件总线：模块只管发，API 层订阅转 WebSocket 推送。 */
export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(64);
  }

  emit(type: WsEventType, payload: unknown): void {
    const event: WsEvent = { type, at: new Date().toISOString(), payload };
    this.emitter.emit('event', event);
  }

  onEvent(listener: (event: WsEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
