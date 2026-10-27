import type { SettingsDto } from '@noidle/resume-contracts';
import type { SettingsRepo } from '../../persistence/repos/settings.ts';
import type { Clock } from '../../shared/clock.ts';
import { validationError } from '../../shared/errors.ts';
import { isSupportedTimezone } from '../limit/timezone.ts';

export const SETTINGS_DEFAULTS: SettingsDto = {
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
};

const NUMERIC_KEYS = [
  'maxAttempts',
  'backoffBaseMs',
  'backoffCapMs',
  'resumeAttemptTimeoutMs',
  'concurrency',
  'hotTakeoverQuietMs',
] as const;

/** 配置服务（设计书 §8.4）：DB 覆盖默认值；时区不硬编码。 */
export class SettingsService {
  constructor(
    private repo: SettingsRepo,
    private clock: Clock,
  ) {}

  get(): SettingsDto {
    const stored = this.repo.all();
    const merged: SettingsDto = { ...SETTINGS_DEFAULTS };
    for (const key of Object.keys(SETTINGS_DEFAULTS) as (keyof SettingsDto)[]) {
      const raw = stored[key];
      if (raw === undefined) continue;
      try {
        const parsed = JSON.parse(raw) as unknown;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (merged as any)[key] = parsed;
      } catch {
        /* 坏值回落默认 */
      }
    }
    return merged;
  }

  patch(partial: Partial<SettingsDto>): SettingsDto {
    const next = { ...this.get(), ...partial };

    if (!isSupportedTimezone(next.timezone)) {
      throw validationError(`不支持的时区: ${next.timezone}`);
    }
    for (const key of NUMERIC_KEYS) {
      const v = next[key];
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw validationError(`${key} 必须为正数`);
      }
    }
    next.concurrency = Math.min(3, Math.max(1, Math.round(next.concurrency)));
    if (typeof next.autoResend !== 'boolean') {
      throw validationError('autoResend 必须为布尔值');
    }
    if (typeof next.hotTakeover !== 'boolean') {
      throw validationError('hotTakeover 必须为布尔值');
    }
    if (
      typeof next.resumePromptTemplate !== 'string' ||
      !next.resumePromptTemplate.includes('{taskId}')
    ) {
      throw validationError('resumePromptTemplate 必须包含 {taskId} 占位符');
    }

    const at = this.clock.now().toISOString();
    for (const key of Object.keys(SETTINGS_DEFAULTS) as (keyof SettingsDto)[]) {
      this.repo.set(key, JSON.stringify(next[key]), at);
    }
    return next;
  }
}
