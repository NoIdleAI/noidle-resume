import type { ResumeTaskDto, UsageEventDto } from '@noidle/auto-resume-contracts';
import { fmtHM } from './format';

export interface TimelineStep {
  t: string;
  n: string;
  state: 'done' | 'next' | 'idle' | 'bad';
}

/**
 * 任务 → 五步恢复时间线（检测 → 解析 → 到期核验 → 续跑 → 叶核验）。
 * 状态机每一态在时间线上都有唯一投影；暂停/失败落点标红（bad），
 * 退避重排是「还会再来」的 next，不冒充失败。
 */
export function buildTimeline(
  task: ResumeTaskDto,
  event: UsageEventDto | null,
  tz: string,
): TimelineStep[] {
  const at = (iso: string | null): string => fmtHM(iso, tz);
  const detectedAt = event?.detectedAt ?? task.createdAt;
  const resetAt = event?.resetAt ?? null;

  const s0: TimelineStep = { t: at(detectedAt), n: '检测到限额', state: 'done' };

  let s1: TimelineStep;
  if (resetAt) {
    s1 = { t: at(resetAt), n: '解析重置时刻', state: 'done' };
  } else if (task.lastErrorCode === 'RESET_TIME_UNPARSED') {
    s1 = { t: '—', n: '解析重置时刻', state: 'bad' };
  } else {
    s1 = { t: '—', n: '解析重置时刻', state: 'idle' };
  }

  // 到期核验：waiting=即将（next）；checking=进行中；之后为 done
  const checkingDone =
    task.status === 'recovering' ||
    task.status === 'resumed' ||
    (task.attemptCount > 0 && task.status !== 'waiting' && task.status !== 'checking');
  let s2: TimelineStep;
  if (task.status === 'failed') {
    s2 = { t: at(task.lastAttemptAt), n: '到期核验', state: 'bad' };
  } else if (checkingDone) {
    s2 = { t: at(task.lastAttemptAt), n: '到期核验', state: 'done' };
  } else {
    s2 = { t: at(task.scheduledAt), n: '到期核验', state: 'next' };
  }

  // 续跑原会话
  let s3: TimelineStep;
  if (task.status === 'resumed') {
    s3 = { t: at(task.lastAttemptAt), n: '续跑原会话', state: 'done' };
  } else if (task.status === 'recovering') {
    s3 = { t: '…', n: '续跑原会话', state: 'next' };
  } else {
    s3 = { t: '—', n: '续跑原会话', state: 'idle' };
  }

  // 叶落盘核验
  let s4: TimelineStep;
  if (task.status === 'resumed') {
    s4 = { t: at(task.updatedAt), n: '叶落盘核验', state: 'done' };
  } else if (task.lastErrorCode === 'RESUME_RESULT_UNKNOWN') {
    s4 = { t: at(task.lastAttemptAt), n: '叶落盘核验', state: 'bad' };
  } else {
    s4 = { t: '—', n: '叶落盘核验', state: 'idle' };
  }

  return [s0, s1, s2, s3, s4];
}
