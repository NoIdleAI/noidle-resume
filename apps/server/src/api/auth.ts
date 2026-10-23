import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const AUTH_COOKIE = 'car_session';

/** 首次启动生成本地访问令牌，0600 存数据目录（设计书 §11.1）。 */
export function ensureToken(tokenFile: string): string {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* 首次生成 */
  }
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  return token;
}

/** 常量时间比较（先哈希定长，防时序侧信道）。 */
export function tokensEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function bearerTokenOf(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

export function cookieTokenOf(req: FastifyRequest, cookieName: string): string | null {
  const jar = (req as unknown as { cookies?: Record<string, string> }).cookies;
  return jar?.[cookieName] ?? null;
}

function isLocalHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

/** Origin 必须是本机名（端口不做比对——Host 已由 isLocalHost 钉死）。 */
function originAllowed(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function unauthorized(reply: FastifyReply, req: FastifyRequest): void {
  void reply.code(401).send({
    error: { code: 'UNAUTHORIZED', message: '需要本地访问令牌', requestId: req.id },
  });
}

/**
 * 本地访问控制（设计书 §11.1）：
 *  - Host 校验（防 DNS rebinding）；
 *  - Bearer 头（curl/脚本）或 HttpOnly Cookie（浏览器）二选一；
 *  - Cookie 路径的写操作额外要求自定义头 X-CAR-Auth + 同源 Origin
 *    （自定义头无法跨站伪造，等价 CSRF 防护）。
 * health 与 auth/verify 豁免。
 */
export function applyAuth(app: FastifyInstance, opts: { token: string; port: number }): void {
  app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url ?? '';
    // 鉴权只护 API：静态页面壳本身不含数据（§11.1），数据全部走 /api/*
    if (!url.startsWith('/api/')) return;
    if (url.startsWith('/api/v1/health') || url.startsWith('/api/v1/auth/')) return;

    const host = req.headers.host ?? '';
    if (!isLocalHost(host)) return unauthorized(reply, req);

    const bearer = bearerTokenOf(req);
    if (bearer && tokensEqual(bearer, opts.token)) return;

    const cookie = cookieTokenOf(req, AUTH_COOKIE);
    if (cookie && tokensEqual(cookie, opts.token)) {
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
      // 写操作 CSRF 防护
      if (req.headers['x-car-auth'] !== '1') return unauthorized(reply, req);
      const origin = req.headers.origin;
      if (origin && !originAllowed(origin)) return unauthorized(reply, req);
      return;
    }
    return unauthorized(reply, req);
  });
}

/** 浏览器本地授权：Bearer 验证通过后下发 HttpOnly Cookie。 */
export function registerAuthRoutes(app: FastifyInstance, opts: { token: string }): void {
  app.post('/api/v1/auth/verify', async (req, reply) => {
    const bearer = bearerTokenOf(req);
    const cookie = cookieTokenOf(req, AUTH_COOKIE);
    const ok =
      (bearer && tokensEqual(bearer, opts.token)) ||
      (cookie && tokensEqual(cookie, opts.token));
    if (!ok) return unauthorized(reply, req);
    void reply.setCookie(AUTH_COOKIE, opts.token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 30 * 24 * 3600,
    });
    return { ok: true };
  });
}
