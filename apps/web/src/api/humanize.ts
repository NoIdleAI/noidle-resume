import type { TaskStatus } from '@noidle/resume-contracts';

/** 错误码 → 人话（设计书 §9.4：按码展示原因，不透堆栈）。 */
const ERROR_HINTS: Record<string, string> = {
  UNAUTHORIZED: '需要本地访问令牌',
  VALIDATION_ERROR: '输入有误',
  NOT_FOUND: '目标不存在',
  SESSION_ALREADY_EXISTS: '该会话已在白名单里',
  SESSION_NOT_ENABLED: '该会话未启用自动续跑',
  SESSION_NOT_LIMITED: '该会话未处于限额状态，无需加入自动化列表',
  SESSION_IDENTITY_UNVERIFIED: '身份核验未通过：转写里的 cwd 与登记工作区不一致，或转写不存在',
  SESSION_TRANSCRIPT_MISSING: '找不到该会话的转写文件',
  SESSION_HOT_HELD: '侧边栏正持有该会话（热），等它冷下来自动再试',
  USAGE_EVENT_UNASSOCIATED: '事件无法关联到已登记会话',
  RESET_TIME_UNPARSED: '重置时刻解析失败 — 到会话页补录正确时刻重新入队',
  RESUME_ATTEMPT_FAILED: '续跑进程执行失败',
  RESUME_ATTEMPT_TIMEOUT: '续跑进程超时',
  RESUME_RESULT_UNKNOWN: '续跑结果未知（轮次未落盘）',
  STILL_LIMITED: '到期核验时额度仍受限，已按退避重排',
  TASK_ALREADY_ACTIVE: '该会话已有进行中的任务',
  TASK_CANCELLED: '任务已取消',
  TASK_NOT_RETRYABLE: '当前状态不可执行该操作',
  LEGACY_PAUSED: '旧版暂停任务（已按未完成归档）',
  INTERNAL_ERROR: '内部错误',
};

export function humanizeError(code: string, fallback?: string): string {
  const hint = ERROR_HINTS[code];
  if (hint && code !== 'VALIDATION_ERROR') return hint;
  return fallback || hint || code;
}

/** 任务状态 → chip 文案与配色类。 */
export const STATUS_CHIP: Record<TaskStatus, { label: string; cls: string }> = {
  waiting: { label: '等待重置', cls: 'waiting' },
  checking: { label: '核验中', cls: 'checking' },
  recovering: { label: '续跑中', cls: 'recovering' },
  resumed: { label: '已恢复', cls: 'resumed' },
  paused: { label: '已停止', cls: 'paused' },
  failed: { label: '失败', cls: 'failed' },
  cancelled: { label: '已取消', cls: 'cancelled' },
};

/** 审计动作 → 人话短语（日志行用）。 */
export const ACTION_LABELS: Record<string, string> = {
  'service.started': '服务启动',
  'session.added': '登记会话',
  'session.enabled': '启用会话',
  'session.disabled': '禁用会话',
  'session.renamed': '重命名会话',
  'session.removed': '移除会话',
  'session.auto_removed': '完结自动移除',
  'event.detected': 'EVENT',
  'event.manual': '人工登记限额',
  'task.created': '任务入队',
  'task.reconciled': '重启对账',
  'api.sessions.add': 'API 登记会话',
  'api.tasks.retry': 'API 重试任务',
  'api.tasks.cancel': 'API 取消任务',
  'api.tasks.clear_history': '清空历史记录',
  'api.tasks.pause': 'API 暂停任务',
  'api.tasks.pause_all': 'API 全部暂停',
  'task.resumed': '恢复成功',
  'task.auto_resend': '自动重发排队',
  'task.failed': '恢复失败',
  'task.hot_held': '热持有拒绝（自动重试）',
  'task.verify_unknown': '叶核验未确认',
  'api.settings.update': '更新配置',
  'api.error': 'API 错误',
};
