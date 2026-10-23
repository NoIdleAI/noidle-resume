import type {
  AddSessionRequest,
  AuditLogDto,
  DiscoveredSessionDto,
  ManualUsageLimitRequest,
  PatchSessionRequest,
  ResumeTaskDto,
  SessionDto,
  SettingsDto,
  UsageEventDto,
} from '@noidle/auto-resume-contracts';

/** 带活动任务视图的会话（GET /api/v1/sessions 行）。 */
export interface SessionWithTask extends SessionDto {
  activeTask: ResumeTaskDto | null;
}

export interface HealthInfo {
  ok: boolean;
  service: string;
  time: string;
}

/** 服务端已会话化（HttpOnly cookie）的令牌；刷新页面后从 sessionStorage 恢复 Bearer。 */
const TOKEN_KEY = 'car_token';
let token: string | null = sessionStorage.getItem(TOKEN_KEY);

export function currentToken(): string | null {
  return token;
}

export function setToken(t: string | null): void {
  token = t;
  if (t) sessionStorage.setItem(TOKEN_KEY, t);
  else sessionStorage.removeItem(TOKEN_KEY);
}

/** 业务错误（设计书 §9.4：前端按错误码展示具体原因）。 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
  }
}

export class UnauthorizedError extends ApiError {
  constructor() {
    super('UNAUTHORIZED', '需要本地访问令牌', 401);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  // Cookie 路径的写操作 CSRF 防护（§11.1）：自定义头无法跨站伪造
  if (method !== 'GET' && method !== 'HEAD') headers['x-car-auth'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new UnauthorizedError();
  const data = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  if (!res.ok) {
    throw new ApiError(
      data.error?.code ?? 'INTERNAL_ERROR',
      data.error?.message ?? `请求失败（HTTP ${res.status}）`,
      res.status,
    );
  }
  return data as T;
}

export const api = {
  health: () => request<HealthInfo>('GET', '/api/v1/health'),

  // ---- 鉴权 ----
  verify: () => request<{ ok: boolean }>('POST', '/api/v1/auth/verify'),

  // ---- 会话 ----
  sessions: () =>
    request<{ sessions: SessionWithTask[] }>('GET', '/api/v1/sessions'),
  addSession: (body: AddSessionRequest) =>
    request<{ session: SessionDto }>('POST', '/api/v1/sessions', body),
  patchSession: (id: string, body: PatchSessionRequest) =>
    request<{ session: SessionDto }>('PATCH', `/api/v1/sessions/${id}`, body),
  removeSession: (id: string) =>
    request<{ ok: boolean }>('DELETE', `/api/v1/sessions/${id}`),

  // ---- 最近会话发现（登记下拉；只读扫描转写根） ----
  discoverSessions: (hours = 24) =>
    request<{ sessions: DiscoveredSessionDto[] }>(
      'GET',
      `/api/v1/discover/sessions?hours=${hours}`,
    ),

  // ---- 任务 ----
  tasks: (limit = 100) =>
    request<{ tasks: ResumeTaskDto[] }>('GET', `/api/v1/tasks?limit=${limit}`),
  task: (id: string) => request<{ task: ResumeTaskDto }>('GET', `/api/v1/tasks/${id}`),
  retryTask: (id: string) =>
    request<{ task: ResumeTaskDto }>('POST', `/api/v1/tasks/${id}/retry`),
  cancelTask: (id: string) =>
    request<{ task: ResumeTaskDto }>('POST', `/api/v1/tasks/${id}/cancel`),
  pauseTask: (id: string) =>
    request<{ task: ResumeTaskDto }>('POST', `/api/v1/tasks/${id}/pause`),
  pauseAllTasks: () => request<{ paused: number }>('POST', '/api/v1/tasks/pause-all'),

  // ---- 事件 ----
  events: (limit = 100) =>
    request<{ events: UsageEventDto[] }>('GET', `/api/v1/events/usage-limit?limit=${limit}`),
  registerUsageLimit: (body: ManualUsageLimitRequest) =>
    request<{ recorded: boolean; taskCreated: boolean; reason: string | null }>(
      'POST',
      '/api/v1/events/usage-limit',
      body,
    ),

  // ---- 日志与设置 ----
  logs: (limit = 200) => request<{ logs: AuditLogDto[] }>('GET', `/api/v1/logs?limit=${limit}`),
  settings: () => request<{ settings: SettingsDto }>('GET', '/api/v1/settings'),
  patchSettings: (body: Partial<SettingsDto>) =>
    request<{ settings: SettingsDto }>('PATCH', '/api/v1/settings', body),
};
