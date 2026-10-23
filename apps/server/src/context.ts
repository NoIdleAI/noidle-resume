import { randomBytes } from 'node:crypto';
import type { AppConfig } from './config.ts';
import { openDb, migrate, type Db } from './persistence/db.ts';
import { SessionsRepo } from './persistence/repos/sessions.ts';
import { EventsRepo } from './persistence/repos/events.ts';
import { TasksRepo } from './persistence/repos/tasks.ts';
import { SettingsRepo } from './persistence/repos/settings.ts';
import { AuditRepo } from './persistence/repos/audit.ts';
import { WatchOffsetsRepo } from './persistence/repos/watchOffsets.ts';
import { systemClock, type Clock } from './shared/clock.ts';
import { EventBus } from './shared/bus.ts';
import { ensureToken } from './api/auth.ts';
import { SettingsService } from './modules/settings/settingsService.ts';
import { AuditService } from './modules/audit/auditService.ts';
import { TaskService } from './modules/tasks/taskService.ts';
import { UsageLimitIntake } from './modules/usage-limit/intake.ts';
import { SessionService } from './modules/sessions/sessionService.ts';
import { DiscoveryService } from './modules/discover/discoveryService.ts';
import { ProjectsWatcher } from './modules/watcher/projectsWatcher.ts';
import { ClaudeResumeRunner, type ResumeRunner } from './modules/resume/runner.ts';
import { ResumeScheduler } from './modules/scheduler/scheduler.ts';

export interface AppContext {
  config: AppConfig;
  env: string;
  token: string;
  db: Db;
  bus: EventBus;
  clock: Clock;
  newRequestId(): string;
  /** API 层的审计快捷入口（actor=user）。 */
  auditNote(action: string, target?: string | null, detail?: string): void;
  repos: {
    sessions: SessionsRepo;
    events: EventsRepo;
    tasks: TasksRepo;
    settings: SettingsRepo;
    audit: AuditRepo;
    watchOffsets: WatchOffsetsRepo;
  };
  services: {
    sessions: SessionService;
    discover: DiscoveryService;
    tasks: TaskService;
    intake: UsageLimitIntake;
    scheduler: ResumeScheduler;
    settings: SettingsService;
    audit: AuditService;
    watcher: ProjectsWatcher;
    runner: ResumeRunner;
  };
}

let reqCounter = 0;

export function buildContext(config: AppConfig, opts?: { env?: string }): AppContext {
  const token = ensureToken(config.tokenFile);
  const db = openDb(config.dbFile);
  migrate(db, config.migrationsDir);

  const repos = {
    sessions: new SessionsRepo(db),
    events: new EventsRepo(db),
    tasks: new TasksRepo(db),
    settings: new SettingsRepo(db),
    audit: new AuditRepo(db),
    watchOffsets: new WatchOffsetsRepo(db),
  };
  const bus = new EventBus();
  const clock = systemClock;

  const settings = new SettingsService(repos.settings, clock);
  const audit = new AuditService(repos.audit, clock);
  const tasks = new TaskService({ tasks: repos.tasks, clock, bus });
  const intake = new UsageLimitIntake({
    sessions: repos.sessions,
    events: repos.events,
    settings,
    tasks,
    bus,
    clock,
  });
  const watcher = new ProjectsWatcher({
    projectsRoot: config.projectsRoot,
    offsets: repos.watchOffsets,
    clock,
    onLine: (session, line) => {
      try {
        const frame = JSON.parse(line) as unknown;
        intake.handleTranscriptFrame(session.sessionId, session.projectPath, frame);
      } catch {
        /* 非法行忽略 */
      }
    },
  });
  const sessions = new SessionService({
    sessions: repos.sessions,
    tasks: repos.tasks,
    clock,
    bus,
    audit,
    projectsRoot: config.projectsRoot,
    watcher,
  });
  const discover = new DiscoveryService({
    sessions: repos.sessions,
    projectsRoot: config.projectsRoot,
  });
  const runner = new ClaudeResumeRunner({
    claudeBin: config.claudeBin,
    projectsRoot: config.projectsRoot,
    timeoutMs: () => settings.get().resumeAttemptTimeoutMs,
  });
  const scheduler = new ResumeScheduler({
    tasks: repos.tasks,
    sessions: repos.sessions,
    settings,
    runner,
    clock,
    bus,
    audit,
    projectsRoot: config.projectsRoot,
  });

  return {
    config,
    env: opts?.env ?? process.env.NODE_ENV ?? 'development',
    token,
    db,
    bus,
    clock,
    newRequestId: () => `req_${Date.now().toString(36)}_${(reqCounter++).toString(36)}_${randomBytes(3).toString('hex')}`,
    auditNote: (action, target, detail) =>
      audit.log(action, target ?? null, detail ?? null, 'user'),
    repos,
    services: {
      sessions,
      discover,
      tasks,
      intake,
      scheduler,
      settings,
      audit,
      watcher,
      runner,
    },
  };
}
