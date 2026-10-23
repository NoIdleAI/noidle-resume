-- NoIdle Auto Resume 初始库表（设计书 §8 五张核心表 + 调度辅助表）
-- 时间一律存 UTC ISO 8601；墙钟原文与时区另存审计字段。

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  project_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (provider, session_id, project_path)
);

CREATE TABLE usage_events (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  project_path TEXT NOT NULL,
  http_status  INTEGER,
  provider_code TEXT,
  reset_at     TEXT,
  reset_at_raw TEXT,
  reset_tz     TEXT,
  detected_at  TEXT NOT NULL,
  source       TEXT NOT NULL,
  confidence   TEXT NOT NULL,
  raw_message  TEXT,
  event_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (event_hash)
);

CREATE INDEX idx_events_session ON usage_events (session_id, project_path);

CREATE TABLE resume_tasks (
  id                 TEXT PRIMARY KEY,
  session_row_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_id         TEXT NOT NULL,
  project_path       TEXT NOT NULL,
  usage_event_id     TEXT REFERENCES usage_events(id),
  status             TEXT NOT NULL,
  base_leaf_uuid     TEXT,
  prompt_sent        TEXT,
  verified_leaf_uuid TEXT,
  scheduled_at       TEXT NOT NULL,
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  last_attempt_at    TEXT,
  cancel_requested   INTEGER NOT NULL DEFAULT 0,
  started_at         TEXT,
  finished_at        TEXT,
  last_error_code    TEXT,
  evidence           TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX idx_tasks_status_sched ON resume_tasks (status, scheduled_at);

-- 同一会话同一时刻最多一个活动任务（设计书 §7.3，数据库层执法）
CREATE UNIQUE INDEX idx_tasks_active
  ON resume_tasks (session_row_id)
  WHERE status IN ('waiting', 'checking', 'recovering');

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_logs (
  id     TEXT PRIMARY KEY,
  at     TEXT NOT NULL,
  actor  TEXT NOT NULL DEFAULT 'user',
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);

CREATE INDEX idx_audit_at ON audit_logs (at);

-- 转写尾部偏移（断点续读；重启后从上次位置回放，事件哈希去重兜底）
CREATE TABLE watcher_offsets (
  session_key TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);
