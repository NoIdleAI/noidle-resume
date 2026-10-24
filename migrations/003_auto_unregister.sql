-- 003 完结自动移除登记（2026-10-24 用户拍板：自动化列表里的会话必须有任务在跑，否则移除）
-- 会话被移除后任务归档保留（历史记录不丢）：
--   FK 从 CASCADE 改为 SET NULL，并快照 display_name 供历史列表展示。
CREATE TABLE resume_tasks_new (
  id                 TEXT PRIMARY KEY,
  session_row_id     TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  session_id         TEXT NOT NULL,
  project_path       TEXT NOT NULL,
  display_name       TEXT,
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

INSERT INTO resume_tasks_new
  (id, session_row_id, session_id, project_path, display_name, usage_event_id,
   status, base_leaf_uuid, prompt_sent, verified_leaf_uuid, scheduled_at,
   attempt_count, last_attempt_at, cancel_requested, started_at, finished_at,
   last_error_code, evidence, created_at, updated_at)
SELECT
  t.id, t.session_row_id, t.session_id, t.project_path, s.display_name, t.usage_event_id,
  t.status, t.base_leaf_uuid, t.prompt_sent, t.verified_leaf_uuid, t.scheduled_at,
  t.attempt_count, t.last_attempt_at, t.cancel_requested, t.started_at, t.finished_at,
  t.last_error_code, t.evidence, t.created_at, t.updated_at
FROM resume_tasks t LEFT JOIN sessions s ON s.id = t.session_row_id;

DROP TABLE resume_tasks;
ALTER TABLE resume_tasks_new RENAME TO resume_tasks;

CREATE INDEX idx_tasks_status_sched ON resume_tasks (status, scheduled_at);
CREATE UNIQUE INDEX idx_tasks_active
  ON resume_tasks (session_row_id)
  WHERE status IN ('waiting', 'checking', 'recovering');
