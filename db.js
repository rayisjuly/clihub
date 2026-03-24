// input: data/clihub.db (SQLite database file)
// output: session CRUD + event storage + migration
// pos: persistence layer, replaces JSON/NDJSON file storage

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'clihub.db');
const MIGRATE_MARKER = path.join(DATA_DIR, '.migrated');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const MAX_TOOL_OUTPUT_SIZE = 100 * 1024; // 100 KB

let db;

// ─── Initialization ──────────────────────────────────

function initDB() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

  db = new Database(DB_PATH);
  // Restrict DB file to owner-only access
  try { fs.chmodSync(DB_PATH, 0o600); } catch {}
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      claude_session_id TEXT,
      created_at INTEGER NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      model TEXT,
      seq INTEGER DEFAULT 0,
      server_text_buffer TEXT DEFAULT '',
      turn_index INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      content TEXT,
      tool_name TEXT,
      tool_use_id TEXT,
      tool_input TEXT,
      tool_output TEXT,
      is_error INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
  `);

  // Add context_window column if missing
  try { db.exec('ALTER TABLE sessions ADD COLUMN context_window INTEGER DEFAULT 0'); } catch {}

  migrateFromFiles();

  return db;
}

// ─── Session CRUD ────────────────────────────────────

function createSession(id, name, projectDir) {
  db.prepare(`
    INSERT INTO sessions (id, name, project_dir, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, name, projectDir, Date.now());
}

function getSession(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
}

function listSessions() {
  return db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all();
}

function updateSession(id, fields) {
  const allowed = [
    'name', 'claude_session_id', 'input_tokens', 'output_tokens',
    'cache_creation_tokens', 'cache_read_tokens', 'cost_usd', 'model',
    'context_window', 'seq', 'server_text_buffer', 'turn_index',
  ];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(fields[key]);
    }
  }
  if (sets.length === 0) return;
  sets.push('updated_at = unixepoch()');
  vals.push(id);
  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function deleteSession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

// ─── Event Storage ───────────────────────────────────

function appendEvent(sessionId, event) {
  // Truncate oversized tool output
  let toolOutput = event.toolOutput || null;
  if (toolOutput && toolOutput.length > MAX_TOOL_OUTPUT_SIZE) {
    toolOutput = toolOutput.slice(0, MAX_TOOL_OUTPUT_SIZE) + '\n...[truncated]';
  }

  db.prepare(`
    INSERT INTO events (session_id, seq, ts, type, content, tool_name, tool_use_id, tool_input, tool_output, is_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    event.seq || 0,
    event.ts || Date.now(),
    event.type,
    event.content || null,
    event.toolName || null,
    event.toolUseId || null,
    event.toolInput || null,
    toolOutput,
    event.isError ? 1 : 0
  );
}

function getEvents(sessionId, opts = {}) {
  const limit = opts.limit || 200;
  let query, params;

  if (opts.beforeId) {
    query = `
      SELECT * FROM events
      WHERE session_id = ? AND id < ?
      ORDER BY id DESC
      LIMIT ?
    `;
    params = [sessionId, opts.beforeId, limit + 1];
  } else {
    query = `
      SELECT * FROM events
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `;
    params = [sessionId, limit + 1];
  }

  const rows = db.prepare(query).all(...params);
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit).reverse(); // chronological order
  return { events, hasMore };
}

function getEventsSinceSeq(sessionId, lastSeq) {
  return db.prepare(`
    SELECT * FROM events
    WHERE session_id = ? AND seq > ?
    ORDER BY id ASC
  `).all(sessionId, lastSeq);
}

// ─── Cleanup ─────────────────────────────────────────

function cleanupOldEvents(retentionDays = 30) {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  const cutoffMs = cutoff * 1000;

  // Delete old events, but keep at least 500 per session
  const sessions = db.prepare('SELECT id FROM sessions').all();
  const deleteStmt = db.prepare(`
    DELETE FROM events
    WHERE session_id = ? AND ts < ? AND id NOT IN (
      SELECT id FROM events WHERE session_id = ? ORDER BY id DESC LIMIT 500
    )
  `);

  const transaction = db.transaction(() => {
    for (const s of sessions) {
      deleteStmt.run(s.id, cutoffMs, s.id);
    }
  });
  transaction();

  const deleted = db.prepare('SELECT changes() AS c').get();
  if (deleted && deleted.c > 0) {
    console.log(`[DB] Cleaned up old events`);
  }
}

// ─── Migration from JSON/NDJSON ──────────────────────

function migrateFromFiles() {
  if (fs.existsSync(MIGRATE_MARKER)) return;
  if (!fs.existsSync(SESSIONS_DIR)) return;

  const jsonFiles = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  if (jsonFiles.length === 0) return;

  console.log(`[DB] Migrating ${jsonFiles.length} sessions from JSON/NDJSON...`);

  const transaction = db.transaction(() => {
    for (const file of jsonFiles) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8'));
        const id = data.id;

        // Check if session already exists in DB
        const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
        if (existing) continue;

        // Insert session metadata
        db.prepare(`
          INSERT INTO sessions (id, name, project_dir, claude_session_id, created_at,
            input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
            cost_usd, model)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          data.name || 'unknown',
          data.projectDir || '',
          data.claudeSessionId || null,
          data.createdAt || Date.now(),
          data.usage?.input_tokens || 0,
          data.usage?.output_tokens || 0,
          data.usage?.cache_creation_input_tokens || 0,
          data.usage?.cache_read_input_tokens || 0,
          data.costUsd || 0,
          data.model || null
        );

        // Migrate NDJSON messages
        const ndjsonFile = path.join(SESSIONS_DIR, id + '.ndjson');
        if (fs.existsSync(ndjsonFile)) {
          const lines = fs.readFileSync(ndjsonFile, 'utf-8').trim().split('\n').filter(Boolean);
          let seq = 0;
          for (const line of lines) {
            try {
              const msg = JSON.parse(line);
              seq++;
              appendEvent(id, {
                seq,
                ts: msg.ts || Date.now(),
                type: msg.role === 'user' ? 'user_message' : 'text',
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
              });
            } catch {}
          }
          // Update session seq
          db.prepare('UPDATE sessions SET seq = ? WHERE id = ?').run(seq, id);
        }

        console.log(`[DB] Migrated session: ${id} (${data.name})`);
      } catch (err) {
        console.error(`[DB] Migration failed for ${file}:`, err.message);
      }
    }
  });

  transaction();
  fs.writeFileSync(MIGRATE_MARKER, new Date().toISOString());
  console.log('[DB] Migration complete');
}

// ─── Exports ─────────────────────────────────────────

module.exports = {
  initDB,
  createSession,
  getSession,
  listSessions,
  updateSession,
  deleteSession,
  appendEvent,
  getEvents,
  getEventsSinceSeq,
  cleanupOldEvents,
  getDB: () => db,
};
