import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { applyAuth, registerAuthRoutes } from './auth.ts';
import { registerWsGateway } from './ws.ts';
import { registerRoutes } from './routes.ts';
import { BizError } from '../shared/errors.ts';

/** 前端构建产物目录（存在才托管，开发态可只用 vite dev server）。 */
export function webDistDir(): string {
  // apps/server/src/api/app.ts → 仓库根/apps/web/dist
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../web/dist',
  );
}

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
  // websocket 插件与 WS 路由必须同上下文且先插后路：
  // register 是异步排队的，若路由同步注册会被插件的 onRoute 包装错过，
  // 升级请求就会以普通 HTTP 落进 handler（首参是 Request 而非 WebSocket）。
  void app.register(async (scope) => {
    await scope.register(websocket, { options: { maxPayload: 1024 * 1024 } });
    registerWsGateway(scope, { bus: ctx.bus, token: ctx.token });
  });

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
  registerRoutes(app, ctx);

  // 静态托管前端构建产物（阶段三：单进程即可用完整界面）
  const dist = webDistDir();
  const hasDist = fs.existsSync(path.join(dist, 'index.html'));
  if (hasDist) {
    void app.register(fastifyStatic, { root: dist, wildcard: false });
  }

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
    ctx.services.audit.log('api.error', req.raw.url, (err as Error).stack ?? String(err), 'system');
    void reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: '内部错误', requestId: req.id },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? '';
    // SPA 回退：非 /api 的未知路径回 index.html（前端路由自接管）
    if (hasDist && !url.startsWith('/api/')) {
      void reply.sendFile('index.html');
      return;
    }
    void reply.code(404).send({
      error: { code: 'NOT_FOUND', message: '接口不存在', requestId: req.id },
    });
  });

  return app;
}
