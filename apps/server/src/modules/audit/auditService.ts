import type { Clock } from '../../shared/clock.ts';
import { newId } from '../../shared/ids.ts';
import type { AuditRepo } from '../../persistence/repos/audit.ts';

/** 脱敏操作日志（设计书 §8.5 / §11.4）。 */
export class AuditService {
  constructor(
    private repo: AuditRepo,
    private clock: Clock,
  ) {}

  log(
    action: string,
    target?: string | null,
    detail?: string | null,
    actor: 'user' | 'system' = 'user',
  ): void {
    this.repo.insert({
      id: newId(),
      at: this.clock.now().toISOString(),
      actor,
      action,
      target: target ?? null,
      detail: detail ?? null,
    });
  }

  list(limit: number, offset: number) {
    return this.repo.list(limit, offset);
  }
}
