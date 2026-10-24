import type {
  AuditLogDto,
  EventConfidence,
  EventSource,
  Provider,
  ResumeTaskDto,
  SessionDto,
  TaskStatus,
  UsageEventDto,
} from '@noidle/auto-resume-contracts';
import type { SessionRow } from '../persistence/repos/sessions.ts';
import type { UsageEventRow } from '../persistence/repos/events.ts';
import type { ResumeTaskRow, TaskWithSessionRow } from '../persistence/repos/tasks.ts';
import type { AuditLogRow } from '../persistence/repos/audit.ts';

export function toSessionDto(row: SessionRow): SessionDto {
  return {
    id: row.id,
    provider: row.provider as Provider,
    sessionId: row.session_id,
    projectPath: row.project_path,
    displayName: row.display_name,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toUsageEventDto(row: UsageEventRow): UsageEventDto {
  return {
    id: row.id,
    provider: row.provider as Provider,
    sessionId: row.session_id,
    projectPath: row.project_path,
    httpStatus: row.http_status,
    providerCode: row.provider_code,
    resetAt: row.reset_at,
    resetAtRaw: row.reset_at_raw,
    resetTz: row.reset_tz,
    detectedAt: row.detected_at,
    source: row.source as EventSource,
    confidence: row.confidence as EventConfidence,
    rawMessage: row.raw_message,
    eventHash: row.event_hash,
  };
}

export function toTaskDto(row: ResumeTaskRow | TaskWithSessionRow): ResumeTaskDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    sessionDisplayName: row.display_name ?? row.session_id,
    projectPath: row.project_path,
    usageEventId: row.usage_event_id,
    status: row.status as TaskStatus,
    baseLeafUuid: row.base_leaf_uuid,
    promptSent: row.prompt_sent,
    verifiedLeafUuid: row.verified_leaf_uuid,
    scheduledAt: row.scheduled_at,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    lastErrorCode: row.last_error_code,
    evidence: row.evidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toAuditDto(row: AuditLogRow): AuditLogDto {
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    target: row.target,
    detail: row.detail,
  };
}
