import fs from 'node:fs';
import path from 'node:path';
import type { AddSessionRequest, PatchSessionRequest, Provider } from '@noidle/auto-resume-contracts';
import type { Clock } from '../../shared/clock.ts';
import { newId } from '../../shared/ids.ts';
import { BizError, notFound, validationError } from '../../shared/errors.ts';
import type { SessionsRepo, SessionRow } from '../../persistence/repos/sessions.ts';
import type { TasksRepo } from '../../persistence/repos/tasks.ts';
import type { ProjectsWatcher } from '../watcher/projectsWatcher.ts';
import { verifySessionIdentity } from '../../adapters/vscode-claude/transcriptLocator.ts';
import type { EventBus } from '../../shared/bus.ts';
import type { AuditService } from '../audit/auditService.ts';
import { toSessionDto, toTaskDto } from '../../shared/mappers.ts';

export interface SessionWithActiveTask {
  session: SessionRow;
  activeTask: ReturnType<typeof toTaskDto> | null;
}

/**
 * 白名单会话服务（设计书 §5 / §10.2）。
 * 新会话默认 enabled=false；启用时重做身份核验（§5.1 规则 8）。
 */
export class SessionService {
  constructor(
    private deps: {
      sessions: SessionsRepo;
      tasks: TasksRepo;
      clock: Clock;
      bus: EventBus;
      audit: AuditService;
      projectsRoot: string;
      watcher: ProjectsWatcher;
    },
  ) {}

  add(input: AddSessionRequest): SessionRow {
    const provider: Provider = input.provider ?? 'zhipu-glm';
    const sessionId = input.sessionId?.trim();
    const projectPath = path.resolve(input.projectPath ?? '');
    if (!sessionId) throw validationError('sessionId 必填');
    if (!projectPath || projectPath === '/') throw validationError('projectPath 必填');

    let stat: fs.Stats;
    try {
      stat = fs.statSync(projectPath);
    } catch {
      throw validationError(`工作区路径不存在: ${projectPath}`);
    }
    if (!stat.isDirectory()) throw validationError(`不是目录: ${projectPath}`);

    // 身份核验：转写帧内 cwd 必须与登记工作区一致（§9.3）
    const identity = verifySessionIdentity(this.deps.projectsRoot, sessionId, projectPath);
    if (!identity.ok) {
      throw new BizError('SESSION_IDENTITY_UNVERIFIED', identity.reason ?? '身份核验失败', 422);
    }
    if (this.deps.sessions.byBusinessKey(provider, sessionId, projectPath)) {
      throw new BizError('SESSION_ALREADY_EXISTS', '该会话已登记', 409);
    }

    const now = this.deps.clock.now().toISOString();
    const displayName =
      input.displayName?.trim() ||
      `${path.basename(projectPath)}#${sessionId.slice(0, 8)}`;
    const row: SessionRow = {
      id: newId(),
      provider,
      session_id: sessionId,
      project_path: projectPath,
      display_name: displayName,
      enabled: input.enabled === true ? 1 : 0, // 默认不启用（§9.2）
      created_at: now,
      updated_at: now,
    };
    this.deps.sessions.insert({
      id: row.id,
      provider: row.provider,
      session_id: row.session_id,
      project_path: row.project_path,
      display_name: row.display_name,
      enabled: row.enabled,
      createdAt: now,
    });
    this.deps.audit.log('session.added', row.id, `${projectPath} enabled=${row.enabled}`);
    this.afterChange(row);
    return row;
  }

  patch(id: string, partial: PatchSessionRequest): SessionRow {
    const row = this.byId(id);
    const now = this.deps.clock.now().toISOString();

    if (partial.enabled === true && row.enabled !== 1) {
      const identity = verifySessionIdentity(
        this.deps.projectsRoot,
        row.session_id,
        row.project_path,
      );
      if (!identity.ok) {
        throw new BizError('SESSION_IDENTITY_UNVERIFIED', identity.reason ?? '身份核验失败', 422);
      }
    }

    this.deps.sessions.patch(
      id,
      {
        displayName: partial.displayName,
        enabled: partial.enabled === undefined ? undefined : partial.enabled ? 1 : 0,
      },
      now,
    );
    const after = this.byId(id);

    if (partial.enabled === false) {
      // 禁用 → 撤销授权并取消待执行任务（§5.2）
      const active = this.deps.tasks.activeBySessionRowId(id);
      if (active && ['waiting', 'checking'].includes(active.status)) {
        this.deps.tasks.cancelPending(active.id, now);
        this.deps.bus.emit('task.changed', toTaskDto(this.deps.tasks.byId(active.id)!));
      }
      this.deps.audit.log('session.disabled', id);
    } else if (partial.enabled === true) {
      this.deps.audit.log('session.enabled', id);
    } else if (partial.displayName) {
      this.deps.audit.log('session.renamed', id, partial.displayName);
    }
    this.afterChange(after);
    return after;
  }

  remove(id: string): void {
    const row = this.byId(id);
    const now = this.deps.clock.now().toISOString();
    // 任务随会话级联删除（迁移 FK ON DELETE CASCADE）；脱敏审计保留
    this.deps.sessions.remove(id);
    this.deps.audit.log('session.removed', id, row.project_path);
    this.afterChange(row);
  }

  list(): SessionRow[] {
    return this.deps.sessions.list();
  }

  listWithActiveTask(): SessionWithActiveTask[] {
    return this.list().map((session) => {
      const active = this.deps.tasks.activeBySessionRowId(session.id);
      return {
        session,
        activeTask: active ? toTaskDto(active) : null,
      };
    });
  }

  private byId(id: string): SessionRow {
    const row = this.deps.sessions.byId(id);
    if (!row) throw notFound('会话不存在');
    return row;
  }

  private afterChange(row: SessionRow): void {
    this.deps.watcher.sync(
      this.list().map((s) => ({ sessionId: s.session_id, projectPath: s.project_path })),
    );
    this.deps.bus.emit('session.changed', toSessionDto(row));
  }
}
