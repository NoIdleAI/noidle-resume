import type { FastifyInstance } from 'fastify';
import type { ManualUsageLimitRequest } from '@noidle/auto-resume-contracts';
import type { AppContext } from '../context.ts';
import { BizError } from '../shared/errors.ts';
import { toAuditDto, toSessionDto, toTaskDto, toUsageEventDto } from '../shared/mappers.ts';

function intQuery(v: unknown, def: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { services } = ctx;

  app.get('/api/v1/health', async () => ({
    ok: true,
    service: 'noidle-auto-resume',
    time: ctx.clock.now().toISOString(),
  }));

  // ---- 会话白名单 ----
  app.get('/api/v1/sessions', async () => {
    const rows = services.sessions.listWithActiveTask();
    return {
      sessions: rows.map((r) => ({
        ...toSessionDto(r.session),
        activeTask: r.activeTask,
      })),
    };
  });

  app.post('/api/v1/sessions', async (req) => {
    const row = services.sessions.add(req.body as Parameters<typeof services.sessions.add>[0]);
    ctx.auditNote('api.sessions.add', row.id);
    return { session: { ...toSessionDto(row), activeTask: null } };
  });

  app.patch('/api/v1/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = services.sessions.patch(id, req.body as { displayName?: string; enabled?: boolean });
    return { session: toSessionDto(row) };
  });

  app.delete('/api/v1/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    services.sessions.remove(id);
    return { ok: true };
  });

  // ---- 最近会话发现（登记下拉；只读扫描转写根，不入库） ----
  app.get('/api/v1/discover/sessions', async (req) => {
    const q = req.query as { hours?: string };
    return { sessions: services.discover.list(q.hours ? Number(q.hours) : undefined) };
  });

  // ---- 恢复任务 ----
  app.get('/api/v1/tasks', async (req) => {
    const q = req.query as { limit?: string; offset?: string };
    const rows = services.tasks.list(intQuery(q.limit, 50, 200), intQuery(q.offset, 0, 1e6));
    return { tasks: rows.map(toTaskDto) };
  });

  app.get('/api/v1/tasks/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { task: toTaskDto(services.tasks.byId(id)) };
  });

  app.post('/api/v1/tasks/:id/retry', async (req) => {
    const { id } = req.params as { id: string };
    const task = services.tasks.retry(id);
    ctx.auditNote('api.tasks.retry', id);
    return { task: toTaskDto(task) };
  });

  app.post('/api/v1/tasks/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const task = services.tasks.cancel(id);
    ctx.auditNote('api.tasks.cancel', id);
    return { task: toTaskDto(task) };
  });

  app.post('/api/v1/tasks/:id/pause', async (req) => {
    const { id } = req.params as { id: string };
    const task = services.tasks.pause(id);
    ctx.auditNote('api.tasks.pause', id);
    return { task: toTaskDto(task) };
  });

  app.post('/api/v1/tasks/pause-all', async () => {
    const n = services.tasks.pauseAll();
    ctx.auditNote('api.tasks.pause_all', null, `count=${n}`);
    return { paused: n };
  });

  // ---- 限额事件 ----
  app.post('/api/v1/events/usage-limit', async (req) => {
    const outcome = services.intake.handleManual(req.body as ManualUsageLimitRequest);
    if (!outcome.recorded) {
      if (outcome.reason === '未登记会话，事件丢弃') {
        throw new BizError('USAGE_EVENT_UNASSOCIATED', '事件无法关联到已登记会话', 422);
      }
      throw new BizError('VALIDATION_ERROR', outcome.reason ?? '事件无效', 400);
    }
    return {
      recorded: true,
      taskCreated: outcome.taskCreated,
      reason: outcome.reason ?? null,
      event: outcome.event ? toUsageEventDto(outcome.event) : null,
    };
  });

  // GET 列表与 WS 推送分开：WS 独占 /api/v1/events（§9.1）
  app.get('/api/v1/events/usage-limit', async (req) => {
    const q = req.query as { limit?: string; offset?: string };
    const rows = ctx.repos.events.list(intQuery(q.limit, 50, 200), intQuery(q.offset, 0, 1e6));
    return { events: rows.map(toUsageEventDto) };
  });

  // ---- 日志与设置 ----
  app.get('/api/v1/logs', async (req) => {
    const q = req.query as { limit?: string; offset?: string };
    const rows = services.audit.list(intQuery(q.limit, 100, 500), intQuery(q.offset, 0, 1e6));
    return { logs: rows.map(toAuditDto) };
  });

  app.get('/api/v1/settings', async () => ({ settings: services.settings.get() }));

  app.patch('/api/v1/settings', async (req) => {
    const settings = services.settings.patch(req.body as Record<string, unknown>);
    ctx.auditNote('api.settings.update', null, JSON.stringify(req.body ?? {}));
    return { settings };
  });
}
