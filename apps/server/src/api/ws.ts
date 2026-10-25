import type { FastifyInstance } from 'fastify';
import type { EventBus } from '../shared/bus.ts';
import {
  AUTH_COOKIE,
  bearerTokenOf,
  cookieTokenOf,
  tokensEqual,
} from './auth.ts';

/** @fastify/websocket v10+：首参就是 WebSocket 实例本身。 */
interface WsSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
  on(event: string, listener: () => void): void;
  ping?(): void;
}

/** 心跳周期：20s 一拍。客户端看门狗阈值取 2 倍 + 余量（45s）判半开。 */
const HEARTBEAT_MS = 20_000;

/**
 * WebSocket 网关（设计书 §9.1 WS /api/v1/events）：同样要鉴权（§11.1）。
 *
 * 可靠性契约（2026-10-25 页面冻结事故）：
 * - 连接建立即发一帧 heartbeat（携当前 seq）——客户端据此对齐游标；
 * - 每 20s 心跳一帧（携最新 seq）——探活 + 免费对账；隐藏窗口被系统挂起、
 *   重连后、漏推后，客户端都能凭 seq 缺口或 revision 轮询补拉快照。
 * 事件只是增量优化，快照才是事实源。
 */
export function registerWsGateway(
  app: FastifyInstance,
  opts: { bus: EventBus; token: string },
): void {
  app.get('/api/v1/events', { websocket: true }, (socket: WsSocket, req) => {
    const bearer = bearerTokenOf(req);
    const cookie = cookieTokenOf(req, AUTH_COOKIE);
    const authorized =
      (bearer !== null && tokensEqual(bearer, opts.token)) ||
      (cookie !== null && tokensEqual(cookie, opts.token));
    if (!authorized) {
      socket.close(4401, 'unauthorized');
      return;
    }
    const sendSafe = (data: string): void => {
      try {
        socket.send(data);
      } catch {
        /* 连接竞争时忽略 */
      }
    };
    const heartbeat = (): void => {
      sendSafe(
        JSON.stringify({
          type: 'heartbeat',
          at: new Date().toISOString(),
          seq: opts.bus.seq,
          payload: { seq: opts.bus.seq },
        }),
      );
    };
    const off = opts.bus.onEvent((event) => sendSafe(JSON.stringify(event)));
    const hbTimer = setInterval(heartbeat, HEARTBEAT_MS);
    hbTimer.unref?.();
    const cleanup = (): void => {
      off();
      clearInterval(hbTimer);
    };
    socket.on('close', cleanup);
    heartbeat(); // 建立即对齐：客户端拿到当前 seq 游标
  });
}
