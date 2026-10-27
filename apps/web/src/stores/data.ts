import { computed, reactive } from 'vue';
import type {
  AuditLogDto,
  ResumeTaskDto,
  SettingsDto,
  UsageEventDto,
  WsEvent,
} from '@noidle/resume-contracts';
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
    .filter((t) => t.status === 'failed')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (trouble.length > 0) return trouble[0]!;
  return [...ts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
});

export const counters = computed(() => ({
  enabled: store.sessions.filter((s) => s.enabled).length,
  waiting: store.tasks.filter((t) => ACTIVE_ORDER.includes(t.status)).length,
  failed: store.tasks.filter((t) => t.status === 'failed').length,
}));

/** 活动任务（值守中）：监控下拉、总览/会话页自动化列表、ALL 看板统一用它，一处过滤处处同步。 */
export const activeTasks = computed(() =>
  store.tasks.filter((t) => ACTIVE_ORDER.includes(t.status)),
);

/** 历史记录：已完结任务（成功/失败/取消），按完结时间倒序。 */
export const historyTasks = computed(() =>
  store.tasks
    .filter((t) => ['resumed', 'failed', 'cancelled'].includes(t.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
);

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
      autoResend: true,
      hotTakeover: false,
      hotTakeoverQuietMs: 600_000,
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
  touchWatchdog(evt); // 任何帧（含心跳）都证明连接活着，并推进本地游标
  switch (evt.type) {
    case 'task.changed': {
      upsertTask(evt.payload as ResumeTaskDto);
      debouncedRefresh(refreshLogs, 'logs'); // 审计面板不再停在「服务启动」
      break;
    }
    case 'event.detected': {
      store.events.unshift(evt.payload as UsageEventDto);
      debouncedRefresh(refreshTasks, 'tasks');
      debouncedRefresh(refreshSessions, 'sessions');
      debouncedRefresh(refreshLogs, 'logs');
      break;
    }
    case 'session.changed': {
      debouncedRefresh(refreshSessions, 'sessions');
      debouncedRefresh(refreshLogs, 'logs');
      break;
    }
    case 'service.note': {
      debouncedRefresh(refreshLogs, 'logs');
      break;
    }
    case 'heartbeat': {
      // 纯探活/对账帧：游标已在 touchWatchdog 推进，无数据要刷。
      // 若本该夹在两拍心跳之间的事件没到（seq 有缺口），对账轮询会兜住。
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
    // 重连即补快照（2026-10-25 冻结事故）：断线期间错过的事件不再永久缺失。
    // 快照拉完刷新本地游标，避免对账轮询再触发一次全量。
    void refreshAll()
      .catch(() => undefined)
      .finally(() => {
        lastSeq = null; // 以下一帧事件/心跳重新对齐
      });
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
    scheduleReconnect();
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

// ---- 可靠性设施（2026-10-25 页面冻结事故的四层防线，业界通行做法） ----
// ① 服务端 20s 心跳（见 api/ws.ts）② 本地看门狗判半开 ③ revision 对账兜底
// ④ 重连/回前台补快照。拔掉任意一层，界面最多旧 20s，而不是旧一晚上。

/** 本地 WS 游标（最近一帧的 seq）与最后一帧到达时刻。 */
let lastSeq: number | null = null;
let lastMsgAt = 0;
/** 看门狗：超过 45s（2 拍心跳 + 余量）没有任何帧 → 判半开，主动断开触发重连。 */
const STALE_MS = 45_000;
/** 对账周期：20s 一问，给最大陈旧时间封顶。 */
const RECONCILE_MS = 20_000;

function touchWatchdog(evt: WsEvent): void {
  lastMsgAt = Date.now();
  if (typeof evt.seq === 'number') lastSeq = evt.seq;
}

function scheduleReconnect(): void {
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(connectWs, 3000);
}

/** revision 对账：服务端 seq 领先本地游标 = 有事件没送到 → 补拉快照。 */
async function reconcile(): Promise<void> {
  if (store.auth !== 'ok' || document.visibilityState === 'hidden') return;
  try {
    const { seq } = await api.revision();
    if (lastSeq === null) {
      lastSeq = seq; // 首次对齐（如 WS 一直没连上，纯 HTTP 也能对齐）
      return;
    }
    if (seq !== lastSeq) {
      await refreshAll();
      lastSeq = seq;
    }
  } catch {
    /* 服务暂不可达：下轮再试 */
  }
}

let reliabilityStarted = false;

/** 幂等启动：App 挂载时调用（与 startTicker 同级）。 */
export function startReliabilityWatch(): void {
  if (reliabilityStarted) return;
  reliabilityStarted = true;
  // 看门狗：15s 巡检一次「多久没收到帧」
  window.setInterval(() => {
    if (store.auth !== 'ok' || !lastMsgAt) return;
    if (Date.now() - lastMsgAt > STALE_MS) {
      try {
        ws?.close(); // 半开连接：主动断开，走 onclose 的重连路径
      } catch {
        /* 忽略 */
      }
    }
  }, 15_000);
  // 对账轮询：WS 再怎么出问题，数据最多旧 20s
  window.setInterval(() => void reconcile(), RECONCILE_MS);
  // 回前台必刷新：系统挂起隐藏窗口期间世界已经变了
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshAll().catch(() => undefined);
  });
  window.addEventListener('focus', () => void refreshAll().catch(() => undefined), { once: false });
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
