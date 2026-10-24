-- 002 「暂停」状态退役（2026-10-24）
-- 自动化语义收敛：任务要么恢复成功（resumed），要么失败/取消（failed/cancelled）；
-- 等待人工确认的 paused 不再存在。是否自动重发由 settings.autoResend 决定，
-- 存量 paused 一律按未完成处理改判 failed（错误码缺失时补 LEGACY_PAUSED 以示来源）。
UPDATE resume_tasks
SET status = 'failed',
    last_error_code = COALESCE(last_error_code, 'LEGACY_PAUSED')
WHERE status = 'paused';
