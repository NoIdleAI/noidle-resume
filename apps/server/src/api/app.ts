import fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { applyAuth, registerAuthRoutes } from './auth.ts';
import { registerWsGateway } from './ws.ts';
import { registerRoutes } from './routes.ts';
import { BizError } from '../shared/errors.ts';

export function buildApp(ctx: AppContext): FastifyInstance {
  const app = fastify({
    logger: {
      level: ctx.env === 'test' ? 'error' : 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    genReqId: () => ctx.newRequestId(),
    bodyLimit: 512 * 1024,
  });

  void app.register(cookie);
  void app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  // 宽容 JSON 解析：动作型 POST 常无 body（带 content-type 空体），按 {} 处理
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      if (typeof body !== 'string' || body.trim() === '') return done(null, {});
      try {
        done(null, JSON.parse(body) as unknown);
      } catch (err) {
        done(err as Error);
      }
    },
  );

  applyAuth(app, { token: ctx.token, port: ctx.config.port });
  registerAuthRoutes(app, { token: ctx.token });
  registerWsGateway(app, { bus: ctx.bus, token: ctx.token });
  registerRoutes(app, ctx);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof BizError) {
      void reply.code(err.httpStatus).send({
        error: { code: err.code, message: err.message, requestId: req.id },
      });
      return;
    }
    const e = err as Error & { statusCode?: number };
    // fastify 校验错误（schema 不匹配等）
    const status = e.statusCode ?? 500;
    if (status < 500) {
      void reply.code(status).send({
        error: { code: 'VALIDATION_ERROR', message: e.message, requestId: req.id },
      });
      return;
    }
    ctx.services.audit.log('api.error', req.raw.url, String(err), 'system');
    void reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: '内部错误', requestId: req.id },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({
      error: { code: 'NOT_FOUND', message: '接口不存在', requestId: req.id },
    });
  });

  return app;
}
