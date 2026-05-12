/**
 * Per-session privacy flag.
 *
 * Earlier design: install-wide `CONNECTION_STATE=incognito` env var.
 * That was wrong — it forced the whole install into incognito to get one
 * private session, when the natural request is "I'm normally connected
 * but this conversation shouldn't hit the platform."
 *
 * `sessions.privacy` is set at session creation and immutable for the
 * session's lifetime:
 *   - `normal`     — default. End-of-turn snapshots persist to Warp; the
 *                    session is visible in fleet dashboards and resumable
 *                    across pod incarnations.
 *   - `incognito`  — no platform calls scoped to this session leave the
 *                    runtime. No snapshot, no fleet visibility. In cloud
 *                    the session dies with the pod (that's the contract).
 *                    In local mode the SQLite stays on disk, so the
 *                    operator can still resume it locally.
 *
 * Runtime-infra calls (mission_events audit, heartbeat, mission completion
 * publish) are NOT gated by this — they're the runtime's own platform
 * work, not the session's. Only session-scoped operations (transcript
 * episodes, snapshot upload, semantic memory writes) check this column.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

const ADD_COLUMN_SQL =
  "ALTER TABLE sessions ADD COLUMN privacy TEXT NOT NULL DEFAULT 'normal' " +
  "CHECK(privacy IN ('normal', 'incognito'))";

const INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_sessions_privacy ON sessions(privacy)';

export const migration014: Migration = {
  version: 14,
  name: 'session-privacy',
  up(db: Database.Database) {
    db.exec(ADD_COLUMN_SQL);
    db.exec(INDEX_SQL);
  },
};
