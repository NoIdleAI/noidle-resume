/**
 * NoIdle Auto Resume — 前后端共享契约（DTO、枚举、错误码）。
 *
 * 设计来源：《限额恢复设计方案01.md》（下称设计书）。
 * 阶段二交付范围：后台任务引擎 + 本地 API（§16 阶段二）。
 */

/** 提供商。首版固定智谱 GLM，但模型不写死（设计书 §5.1）。 */
export const PROVIDERS = ['zhipu-glm'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** 限额事件来源。2026-10-23 定案：转写监听为主、人工登记兜底（设计书 §6.1）。 */
export const EVENT_SOURCES = ['transcript', 'manual'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** 事件可信度（设计书 §6.2 识别规则）。 */
export const EVENT_CONFIDENCE = ['high', 'medium', 'low'] as const;
export type EventConfidence = (typeof EVENT_CONFIDENCE)[number];

/** 恢复任务状态机（设计书 §7.1）。 */
export const TASK_STATUSES = [
  'waiting',
  'checking',
  'recovering',
  'resumed',
  'paused',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 任务终态（不可再转换）。 */
export const TASK_TERMINAL_STATUSES: readonly TaskStatus[] = [
  'resumed',
  'failed',
  'cancelled',
];

/** 统一业务错误码（设计书 §9.4）。 */
export const ERROR_CODES = [
  'UNAUTHORIZED',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'SESSION_ALREADY_EXISTS',
  'SESSION_NOT_ENABLED',
  'SESSION_IDENTITY_UNVERIFIED',
  'SESSION_TRANSCRIPT_MISSING',
  'SESSION_HOT_HELD',
  'USAGE_EVENT_UNASSOCIATED',
  'RESET_TIME_UNPARSED',
  'RESUME_ATTEMPT_FAILED',
  'RESUME_ATTEMPT_TIMEOUT',
  'RESUME_RESULT_UNKNOWN',
  'STILL_LIMITED',
  'TASK_ALREADY_ACTIVE',
  'TASK_CANCELLED',
  'TASK_NOT_RETRYABLE',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** 会话白名单条目（设计书 §8.1）。 */
export interface SessionDto {
  id: string;
  provider: Provider;
  sessionId: string;
  projectPath: string;
  displayName: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 限额事件（设计书 §6.2 / §8.2）。 */
export interface UsageEventDto {
  id: string;
  provider: Provider;
  sessionId: string;
  projectPath: string;
  httpStatus: number | null;
  providerCode: string | null;
  /** 重置时刻，UTC ISO 8601；解析失败为 null。 */
  resetAt: string | null;
  /** 原始墙钟文本与解析所用时区，用于审计。 */
  resetAtRaw: string | null;
  resetTz: string | null;
  detectedAt: string;
  source: EventSource;
  confidence: EventConfidence;
  /** 截断脱敏后的原始错误文本。 */
  rawMessage: string | null;
  eventHash: string;
}

/** 恢复任务（设计书 §8.3）。 */
export interface ResumeTaskDto {
  id: string;
  sessionId: string;
  sessionDisplayName: string;
  projectPath: string;
  usageEventId: string | null;
  status: TaskStatus;
  /** 恢复起点的转写叶（设计书 §5.1 任务唯一键 / §2.4）。 */
  baseLeafUuid: string | null;
  /** 本工具发出的续跑提示词全文（含机器标记，核验凭据之一）。 */
  promptSent: string | null;
  /** 核验通过的本工具分支叶。 */
  verifiedLeafUuid: string | null;
  scheduledAt: string;
  attemptCount: number;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
  /** 状态机证据（JSON：核验细节）。 */
  evidence: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 服务配置（设计书 §8.4 app_settings 的合并视图）。 */
export interface SettingsDto {
  /** IANA 时区名，重置时刻按此墙钟解析。 */
  timezone: string;
  /** 同一任务的最大恢复尝试次数，超过转 paused。 */
  maxAttempts: number;
  /** 到期后仍受限时的退避基数（毫秒）。 */
  backoffBaseMs: number;
  /** 退避上限（毫秒）。 */
  backoffCapMs: number;
  /** 单次 headless 续跑超时（毫秒）。 */
  resumeAttemptTimeoutMs: number;
  /** 续跑提示词模板，{taskId} 会被替换为任务 id。 */
  resumePromptTemplate: string;
  /** 串行恢复并发数（设计书 §5.1 规则 6，默认 1）。 */
  concurrency: number;
}

/** 脱敏操作日志（设计书 §8.5）。 */
export interface AuditLogDto {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
}

/** 统一错误响应体（设计书 §9.4）。 */
export interface ApiErrorBody {
  error: {
    code: ErrorCode | 'UNAUTHORIZED';
    message: string;
    requestId: string;
  };
}

/** WebSocket 推送事件（设计书 §9.1 WS /api/v1/events）。 */
export type WsEventType =
  | 'task.changed'
  | 'session.changed'
  | 'event.detected'
  | 'service.note';

export interface WsEvent<T = unknown> {
  type: WsEventType;
  at: string;
  payload: T;
}

/** API 请求/响应荷载。 */
export interface AddSessionRequest {
  provider?: Provider;
  sessionId: string;
  projectPath: string;
  displayName?: string;
  enabled?: boolean;
}

export interface PatchSessionRequest {
  displayName?: string;
  enabled?: boolean;
}

export interface ManualUsageLimitRequest {
  provider?: Provider;
  sessionId: string;
  projectPath: string;
  httpStatus?: number;
  providerCode?: string;
  /** ISO 8601 或「YYYY-MM-DD HH:mm:ss」墙钟（按配置时区解释）。 */
  resetAt?: string;
  rawMessage?: string;
}
