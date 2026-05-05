import path from "node:path";
import fs from "node:fs";
import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import { config } from "../config";

let db: Database<sqlite3.Database, sqlite3.Statement> | null = null;

export async function getDb(): Promise<Database<sqlite3.Database, sqlite3.Statement>> {
  if (db) {
    return db;
  }

  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  db = await open({
    filename: config.databasePath,
    driver: sqlite3.Database
  });

  await db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export async function initDb(): Promise<void> {
  const database = await getDb();
  await database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      status TEXT NOT NULL,
      is_debug_session INTEGER NOT NULL DEFAULT 0,
      ghost_count INTEGER NOT NULL DEFAULT 0,
      category_id TEXT,
      lobby_channel_id TEXT,
      meeting_channel_id TEXT,
      admin_channel_id TEXT,
      emergency_channel_id TEXT,
      join_message_id TEXT,
      created_by TEXT NOT NULL,
      emergency_user_id TEXT NOT NULL DEFAULT '',
      last_emergency_meeting_at INTEGER,
      emergency_cooldown_seconds INTEGER NOT NULL DEFAULT 300,
      meeting_phase TEXT NOT NULL DEFAULT 'none',
      discussion_started_at INTEGER,
      voting_started_at INTEGER,
      short_tasks INTEGER NOT NULL,
      medium_tasks INTEGER NOT NULL,
      long_tasks INTEGER NOT NULL,
      discussion_time_minutes INTEGER NOT NULL DEFAULT 3,
      voting_time_minutes INTEGER NOT NULL DEFAULT 2,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      discord_user_id TEXT,
      is_ghost INTEGER NOT NULL DEFAULT 0,
      username TEXT NOT NULL,
      role TEXT,
      state TEXT NOT NULL DEFAULT 'alive',
      death_reported INTEGER NOT NULL DEFAULT 0,
      false_body_reports INTEGER NOT NULL DEFAULT 0,
      channel_id TEXT,
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, user_id),
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS player_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      task_id TEXT,
      title TEXT,
      description TEXT NOT NULL,
      location TEXT,
      completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS player_task_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assigned_task_id INTEGER NOT NULL,
      step_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      UNIQUE(assigned_task_id, step_id),
      FOREIGN KEY(assigned_task_id) REFERENCES player_tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      reporter_id TEXT NOT NULL,
      victim_id TEXT,
      location TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS kills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      killer_id TEXT NOT NULL,
      victim_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS kill_cooldowns (
      session_id INTEGER NOT NULL,
      impostor_id TEXT NOT NULL,
      next_kill_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, impostor_id),
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS votes (
      session_id INTEGER NOT NULL,
      voter_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      PRIMARY KEY(session_id, voter_id),
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS false_report_warnings (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      warnings INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(guild_id, user_id)
    );
  `);
  await ensureColumn(database, "reports", "victim_id", "TEXT");
  await ensureColumn(database, "sessions", "discussion_time_minutes", "INTEGER NOT NULL DEFAULT 3");
  await ensureColumn(database, "sessions", "voting_time_minutes", "INTEGER NOT NULL DEFAULT 2");
  await ensureColumn(database, "sessions", "is_debug_session", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(database, "sessions", "ghost_count", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(database, "sessions", "emergency_channel_id", "TEXT");
  await ensureColumn(database, "sessions", "emergency_user_id", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, "sessions", "last_emergency_meeting_at", "INTEGER");
  await ensureColumn(database, "sessions", "emergency_cooldown_seconds", "INTEGER NOT NULL DEFAULT 300");
  await ensureColumn(database, "sessions", "meeting_phase", "TEXT NOT NULL DEFAULT 'none'");
  await ensureColumn(database, "sessions", "discussion_started_at", "INTEGER");
  await ensureColumn(database, "sessions", "voting_started_at", "INTEGER");
  await ensureColumn(database, "players", "death_reported", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(database, "players", "false_body_reports", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(database, "players", "discord_user_id", "TEXT");
  await ensureColumn(database, "players", "is_ghost", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(database, "player_tasks", "task_id", "TEXT");
  await ensureColumn(database, "player_tasks", "title", "TEXT");
  await ensureColumn(database, "player_tasks", "location", "TEXT");
  await ensureColumn(database, "player_tasks", "completed_at", "TEXT");
  await database.run("UPDATE players SET discord_user_id = user_id WHERE discord_user_id IS NULL AND (is_ghost IS NULL OR is_ghost = 0)");
  await database.run("UPDATE player_tasks SET title = description WHERE title IS NULL OR title = ''");
}

async function ensureColumn(
  database: Database<sqlite3.Database, sqlite3.Statement>,
  table: string,
  column: string,
  definition: string
): Promise<void> {
  const rows = await database.all(`PRAGMA table_info(${table})`);
  if (!rows.some((row: any) => row.name === column)) {
    await database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
