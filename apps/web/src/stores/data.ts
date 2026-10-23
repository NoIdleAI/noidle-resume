import { computed, reactive } from 'vue';
import type {
  AuditLogDto,
  ResumeTaskDto,
  SettingsDto,
  UsageEventDto,
  WsEvent,
} from '@noidle/auto-resume-contracts';
import {
  api,
  currentToken,
  setToken,
  UnauthorizedError,
  type HealthInfo,
  type SessionWithTask,
} from '../api/client';

export type AuthState = 'checking' | 'gate' | 'ok';

interface DataState {
  auth: AuthState;
  connected: boolean;
  health: HealthInfo | null;
  sessions: SessionWithTask[];
  tasks: ResumeTaskDto[];
  events: UsageEventDto[];
  logs: AuditLogDto[];
  settings: SettingsDto | null;
}

export const store = reactive<DataState>({
  auth: 'checking',
  connected: false,
  health: null,
  sessions: [],
  tasks: [],
  events: [],
  logs: [],
  settings: null,
});

// ---- 派生 ----

const ACTIVE_ORDER = ['recovering', 'checking', 'waiting'];

/** 主任务卡：活动任务按到期时间最早优先；否则最近一次需关注/已完结。 */
export const heroTask = computed<ResumeTaskDto | null>(() => {
  const ts = store.tasks;
  if (ts.length === 0) return null;
  const active = ts
    .filter((t) => ACTIVE_ORDER.includes(t.status))
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  if (active.length > 0) return active[0]!;
  const trouble = ts
    .filter((t) => t.status === 'paused' || t.status === 'failed')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (trouble.length > 0) return trouble[0]!;
  return [...ts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
});

export const counters = computed(() => ({
  enabled: store.sessions.filter((s) => s.enabled).length,
  waiting: store.tasks.filter((t) => ACTIVE_ORDER.includes(t.status)).length,
  paused: store.tasks.filter((t) => t.status === 'paused').length,
  failed: store.tasks.filter((t) => t.status === 'failed').length,
}));

export const eventById = computed(() => {
  const m = new Map<string, UsageEventDto>();
  for (const e of store.events) m.set(e.id, e);
  return m;
});

export const settings = computed<SettingsDto>(
  () =>
    store.settings ?? {
      timezone: 'Asia/Shanghai',
      maxAttempts: 5,
      backoffBaseMs: 60_000,
      backoffCapMs: 600_000,
      resumeAttemptTimeoutMs: 900_000,
      resumePromptTemplate: '继续 [car:auto {taskId}]',
      concurrency: 1,
    },
);

// ---- 拉取 ----

export async function refreshHealth(): Promise<void> {
  try {
    store.health = await api.health();
  } catch {
    store.health = null;
  }
}

export async function refreshSessions(): Promise<void> {
  store.sessions = (await api.sessions()).sessions;
}

export async function refreshTasks(): Promise<void> {
  store.tasks = (await api.tasks()).tasks;
}

export async function refreshEvents(): Promise<void> {
  store.events = (await api.events()).events;
}

export async function refreshLogs(): Promise<void> {
  store.logs = (await api.logs()).logs;
}

export async function refreshSettings(): Promise<void> {
  store.settings = (await api.settings()).settings;
}

export async function refreshAll(): Promise<void> {
  await Promise.all([
    refreshHealth(),
    refreshSessions(),
    refreshTasks(),
    refreshEvents(),
    refreshLogs(),
    refreshSettings(),
  ]);
}

// ---- WS 网关（§9.1：单连接收推送；4401 → 回登录门） ----

let ws: WebSocket | null = null;
let retryTimer: number | null = null;
const pending = new Map<string, number>();

function debouncedRefresh(kind: () => Promise<void>, key: string): void {
  const prev = pending.get(key);
  if (prev !== undefined) window.clearTimeout(prev);
  pending.set(
    key,
    window.setTimeout(() => {
      pending.delete(key);
      void kind().catch(() => undefined);
    }, 250),
  );
}

function upsertTask(dto: ResumeTaskDto): void {
  const i = store.tasks.findIndex((t) => t.id === dto.id);
  if (i >= 0) store.tasks.splice(i, 1, dto);
  else store.tasks.unshift(dto);
}

function upsertSession(row: SessionWithTask): void {
  const i = store.sessions.findIndex((s) => s.id === row.id);
  if (i >= 0) store.sessions.splice(i, 1, row);
  else store.sessions.unshift(row);
}

function handleEvent(evt: WsEvent): void {
  switch (evt.type) {
    case 'task.changed': {
      upsertTask(evt.payload as ResumeTaskDto);
      break;
    }
    case 'event.detected': {
      store.events.unshift(evt.payload as UsageEventDto);
      debouncedRefresh(refreshTasks, 'tasks');
      debouncedRefresh(refreshSessions, 'sessions');
      break;
    }
    case 'session.changed': {
      debouncedRefresh(refreshSessions, 'sessions');
      break;
    }
    case 'service.note': {
      debouncedRefresh(refreshLogs, 'logs');
      break;
    }
  }
}

function connectWs(): void {
  if (ws) {
    try {
      ws.close();
    } catch {
      /* 忽略 */
    }
    ws = null;
  }
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/api/v1/events`);
  socket.onopen = () => {
    store.connected = true;
  };
  socket.onmessage = (m) => {
    try {
      handleEvent(JSON.parse(String(m.data)) as WsEvent);
    } catch {
      /* 非 JSON 帧忽略 */
    }
  };
  socket.onclose = (e) => {
    store.connected = false;
    ws = null;
    if (store.auth !== 'ok') return;
    if (e.code === 4401) {
      store.auth = 'gate';
      return;
    }
    retryTimer = window.setTimeout(connectWs, 3000);
  };
  socket.onerror = () => {
    try {
      socket.close();
    } catch {
      /* 忽略 */
    }
  };
  ws = socket;
}

// ---- 鉴权入口 ----

/** 启动：凭已有 cookie（或恢复的 Bearer）尝试静默验证。 */
export async function initAuth(): Promise<void> {
  store.auth = 'checking';
  try {
    await api.verify(); // cookie 路径；Bearer 已在 client 里自动带
    store.auth = 'ok';
    void refreshAll();
    connectWs();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      // cookie 无效：若 sessionStorage 还有令牌，verify 已带过Bearer 也失败 → 要门
      setToken(null);
      store.auth = 'gate';
    } else {
      // 网络不通（服务未起）：也进门，用户可先粘贴令牌；连上后 initAuth 重试
      store.auth = 'gate';
    }
  }
}

/** 令牌门提交：验证通过即下发 HttpOnly cookie（WS 也靠它）。 */
export async function loginWithToken(t: string): Promise<void> {
  setToken(t.trim());
  try {
    await api.verify();
  } catch (err) {
    setToken(null);
    throw err;
  }
  store.auth = 'ok';
  void refreshAll();
  connectWs();
}

/** 供 catch 后兜底重置（例如 WS 中途失效）。 */
export function forceGate(): void {
  setToken(null);
  store.auth = 'gate';
  if (ws) {
    try {
      ws.close();
    } catch {
      /* 忽略 */
    }
    ws = null;
  }
}

export function hasStoredToken(): boolean {
  return currentToken() !== null;
}
