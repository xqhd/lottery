import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = InstanceType<typeof Database>;

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export function openDb(dbPath: string): Db {
  ensureParentDir(dbPath);

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  return db;
}

export function migrate(db: Db): void {
  let userVersion = db.pragma("user_version", { simple: true }) as number;

  if (userVersion < 1) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      start_time TEXT,
      end_time TEXT,
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prizes (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      name TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 0,
      quantity INTEGER NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      allow_repeat INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS prizes_event_id_idx ON prizes(event_id);

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      name TEXT NOT NULL,
      employee_id TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL DEFAULT '',
      weight REAL NOT NULL DEFAULT 1,
      dedupe_key TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      custom_fields_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      UNIQUE (event_id, dedupe_key)
    );

    CREATE INDEX IF NOT EXISTS participants_event_id_idx ON participants(event_id);

    CREATE TABLE IF NOT EXISTS draw_runs (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      prize_id TEXT NOT NULL,
      prize_name TEXT NOT NULL DEFAULT '',
      count INTEGER NOT NULL,
      seed TEXT NOT NULL,
      candidate_hash TEXT NOT NULL,
      candidate_snapshot_json TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (prize_id) REFERENCES prizes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS draw_runs_event_id_idx ON draw_runs(event_id);
    CREATE INDEX IF NOT EXISTS draw_runs_prize_id_idx ON draw_runs(prize_id);

    CREATE TABLE IF NOT EXISTS draw_results (
      id TEXT PRIMARY KEY,
      draw_run_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (draw_run_id) REFERENCES draw_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
      UNIQUE (draw_run_id, participant_id)
    );

    CREATE INDEX IF NOT EXISTS draw_results_participant_id_idx ON draw_results(participant_id);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT '',
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS audit_logs_event_id_idx ON audit_logs(event_id);

    CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      filename TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);

    db.pragma("user_version = 1");
    userVersion = 1;
  }

  if (userVersion < 2) {
    const hasPrizeName = db
      .prepare(`SELECT 1 FROM pragma_table_info('draw_runs') WHERE name = ? LIMIT 1`)
      .get("prize_name");

    if (!hasPrizeName) {
      db.exec(`ALTER TABLE draw_runs ADD COLUMN prize_name TEXT NOT NULL DEFAULT ''`);
    }

    db.exec(`
      UPDATE draw_runs
      SET prize_name = (SELECT name FROM prizes WHERE prizes.id = draw_runs.prize_id)
      WHERE prize_name = ''
    `);

    db.pragma("user_version = 2");
    userVersion = 2;
  }

  if (userVersion < 3) {
    const hasIsDeleted = db
      .prepare(`SELECT 1 FROM pragma_table_info('draw_results') WHERE name = ? LIMIT 1`)
      .get("is_deleted");

    if (!hasIsDeleted) {
      db.exec(`ALTER TABLE draw_results ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0`);
    }

    const hasDeletedAt = db
      .prepare(`SELECT 1 FROM pragma_table_info('draw_results') WHERE name = ? LIMIT 1`)
      .get("deleted_at");

    if (!hasDeletedAt) {
      db.exec(`ALTER TABLE draw_results ADD COLUMN deleted_at TEXT`);
    }

    db.pragma("user_version = 3");
    userVersion = 3;
  }

  if (userVersion < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS stage_states (
        event_id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'IDLE',
        prize_id TEXT,
        prize_name TEXT NOT NULL DEFAULT '',
        draw_run_id TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS stage_states_updated_at_idx ON stage_states(updated_at);
    `);

    db.pragma("user_version = 4");
    userVersion = 4;
  }

  if (userVersion < 5) {
    const hasMediaUrl = db
      .prepare(`SELECT 1 FROM pragma_table_info('prizes') WHERE name = ? LIMIT 1`)
      .get("media_url");

    if (!hasMediaUrl) {
      db.exec(`ALTER TABLE prizes ADD COLUMN media_url TEXT NOT NULL DEFAULT ''`);
    }

    db.pragma("user_version = 5");
    userVersion = 5;
  }

  if (userVersion < 6) {
    const hasSeq = db
      .prepare(`SELECT 1 FROM pragma_table_info('participants') WHERE name = ? LIMIT 1`)
      .get("seq");

    if (!hasSeq) {
      db.exec(`ALTER TABLE participants ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`);
    }

    db.pragma("user_version = 6");
    userVersion = 6;
  }
}
