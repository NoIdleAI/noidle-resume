import type { FastifyInstance } from 'fastify';
import type { ManualUsageLimitRequest } from '@noidle/auto-resume-contracts';
import type { AppContext } from '../context.ts';
import { BizError, validationError } from '../shared/errors.ts';
import { toAuditDto, toSessionDto, toTaskDto, toUsageEventDto } from '../shared/mappers.ts';
import { parseLimitMessage } from '../modules/limit/detector.ts';
import { zonedTimeToUtc } from '../modules/limit/timezone.ts';

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

  // ---- 限额提示原文解析（补录对话框「粘贴自动填充」；纯工具端点，不入库） ----
  app.post('/api/v1/parse-limit', async (req) => {
    const { rawMessage } = (req.body ?? {}) as { rawMessage?: string };
    const text = (rawMessage ?? '').trim();
    if (!text) throw validationError('rawMessage 必填');
    const limit = parseLimitMessage(text);
    if (!limit) {
      throw new BizError('VALIDATION_ERROR', '未识别出限额特征（需要 429/1308 与「将在 … 重置」时刻）', 422);
    }
    const tz = services.settings.get().timezone;
    let resetAt: string | null = null;
    if (limit.resetAtRaw) {
      try {
        resetAt = zonedTimeToUtc(limit.resetAtRaw, tz).toISOString();
      } catch {
        resetAt = null; // 墙钟解析失败 → 前端让用户手填
      }
    }
    return {
      httpStatus: limit.httpStatus,
      providerCode: limit.providerCode,
      resetAtRaw: limit.resetAtRaw,
      resetAt,
      resetTz: limit.resetAtRaw ? tz : null,
      confidence: limit.confidence,
    };
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

  // 任务级手动动词（重试/暂停/取消）已全部退役（2026-10-24）：
  // 是否自动重发看 settings.autoResend；停止守护=会话页移除（仓储层连带取消）；
  // 重新入队=会话页补录撞限。任务详情页纯只读。

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

  // 清空历史归档（终态任务）；进行中任务不受影响
  app.delete('/api/v1/tasks/history', async () => {
    const cleared = services.tasks.clearHistory();
    ctx.auditNote('api.tasks.clear_history', null, `${cleared} 条`);
    return { cleared };
  });

  // ---- 日志与设置 ----
  app.get('/api/v1/logs', async (req) => {
    const q = req.query as { limit?: string; offset?: string };
    const rows = services.audit.list(intQuery(q.limit, 100, 100), intQuery(q.offset, 0, 1e6));
    return { logs: rows.map(toAuditDto) };
  });

  app.get('/api/v1/settings', async () => ({ settings: services.settings.get() }));

  app.patch('/api/v1/settings', async (req) => {
    const settings = services.settings.patch(req.body as Record<string, unknown>);
    ctx.auditNote('api.settings.update', null, JSON.stringify(req.body ?? {}));
    return { settings };
  });
}
