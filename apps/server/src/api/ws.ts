import type { FastifyInstance } from 'fastify';
import type { EventBus } from '../shared/bus.ts';
import {
  AUTH_COOKIE,
  bearerTokenOf,
  cookieTokenOf,
  tokensEqual,
} from './auth.ts';

interface WsLikeConnection {
  socket: {
    send(data: string): void;
    close(code: number, reason: string): void;
    on(event: string, listener: () => void): void;
  };
}

/** WebSocket 网关（设计书 §9.1 WS /api/v1/events）：同样要鉴权（§11.1）。 */
export function registerWsGateway(
  app: FastifyInstance,
  opts: { bus: EventBus; token: string },
): void {
  app.get('/api/v1/events', { websocket: true }, (conn: WsLikeConnection, req) => {
    const bearer = bearerTokenOf(req);
    const cookie = cookieTokenOf(req, AUTH_COOKIE);
    const authorized =
      (bearer !== null && tokensEqual(bearer, opts.token)) ||
      (cookie !== null && tokensEqual(cookie, opts.token));
    if (!authorized) {
      conn.socket.close(4401, 'unauthorized');
      return;
    }
    const off = opts.bus.onEvent((event) => {
      try {
        conn.socket.send(JSON.stringify(event));
      } catch {
        /* 连接竞争时忽略 */
      }
    });
    conn.socket.on('close', off);
  });
}
