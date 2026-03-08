import { Database } from 'bun:sqlite'
import path from 'path'
import fs from 'fs'
import type { Provider, Profile, LogEntry } from '../../shared/types'

const DB_DIR = path.join(process.cwd(), 'data')
const DB_PATH = path.join(DB_DIR, 'admiral.db')
const RETENTION_DAYS = 3
const SUCCESS_CONTEXT_RETENTION_HOURS = 3
const MAX_LOG_ROWS_PER_PROFILE = 5000
const LOG_PRUNE_EVERY_N_INSERTS = 100
const MAX_STATS_ROWS_PER_PROFILE = 20_000
const STATS_PRUNE_EVERY_N_INSERTS = 100

let db: Database | null = null

export function getDb(): Database {
  if (db) {
    // Verify the DB file still exists and connection is healthy
    if (!fs.existsSync(DB_PATH)) {
      try { db.close() } catch { /* ignore */ }
      db = null
    } else {
      try {
        // Quick health check - try a real query
        db.query('SELECT 1 FROM profiles LIMIT 1').get()
        return db
      } catch {
        try { db.close() } catch { /* ignore */ }
        db = null
      }
    }
  }

  fs.mkdirSync(DB_DIR, { recursive: true })
  db = new Database(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  migrate(db)
  return db
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      api_key TEXT DEFAULT '',
      failover_api_key TEXT DEFAULT '',
      base_url TEXT DEFAULT '',
      status TEXT DEFAULT 'unknown'
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      username TEXT,
      password TEXT,
      empire TEXT DEFAULT '',
      player_id TEXT,
      provider TEXT,
      model TEXT,
      failover_provider TEXT,
      failover_model TEXT,
      directive TEXT DEFAULT '',
      connection_mode TEXT DEFAULT 'http',
      server_url TEXT DEFAULT 'https://game.spacemolt.com',
      autoconnect INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS log_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      type TEXT NOT NULL,
      summary TEXT,
      detail TEXT,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_log_profile ON log_entries(profile_id, id);

    CREATE TABLE IF NOT EXISTS stats_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      ts TEXT DEFAULT (datetime('now')),
      connected INTEGER NOT NULL DEFAULT 0,
      running INTEGER NOT NULL DEFAULT 0,
      adaptive_mode TEXT DEFAULT 'normal',
      effective_context_budget_ratio REAL,
      credits REAL,
      ore_mined REAL,
      trades_completed REAL,
      systems_explored REAL,
      source TEXT DEFAULT 'poll',
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_stats_profile_ts ON stats_snapshots(profile_id, ts DESC);

    CREATE TABLE IF NOT EXISTS stats_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      ts TEXT DEFAULT (datetime('now')),
      type TEXT NOT NULL,
      value TEXT,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_stats_events_profile_ts ON stats_events(profile_id, ts DESC);

    CREATE TABLE IF NOT EXISTS profile_skills (
      profile_id TEXT PRIMARY KEY,
      ts TEXT DEFAULT (datetime('now')),
      skills_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_profile_skills_ts ON profile_skills(ts DESC);

    CREATE TABLE IF NOT EXISTS llm_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      model_name TEXT,
      provider_name TEXT,
      system_prompt TEXT,
      messages_json TEXT,
      message_count INTEGER,
      estimated_tokens INTEGER,
      last_error TEXT,
      response_model TEXT,
      response_stop_reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_llm_requests_profile_status ON llm_requests(profile_id, status, id DESC);

    CREATE TABLE IF NOT EXISTS pending_mutations (
      profile_id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      destination TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS supervisor_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'pending',
      provider_name TEXT,
      model_name TEXT,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      candidates_json TEXT,
      response_text TEXT,
      nudges_json TEXT,
      nudges_sent INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_supervisor_runs_created_at ON supervisor_runs(created_at DESC);
  `)

  // Migrations: add columns that may be missing from older databases
  const profileCols = db.query("PRAGMA table_info(profiles)").all() as Array<{ name: string }>
  if (!profileCols.some(c => c.name === 'todo')) {
    db.exec("ALTER TABLE profiles ADD COLUMN todo TEXT DEFAULT ''")
  }
  if (!profileCols.some(c => c.name === 'context_budget')) {
    db.exec('ALTER TABLE profiles ADD COLUMN context_budget REAL DEFAULT NULL')
  }
  if (!profileCols.some(c => c.name === 'failover_provider')) {
    db.exec('ALTER TABLE profiles ADD COLUMN failover_provider TEXT')
  }
  if (!profileCols.some(c => c.name === 'failover_model')) {
    db.exec('ALTER TABLE profiles ADD COLUMN failover_model TEXT')
  }

  const providerCols = db.query("PRAGMA table_info(providers)").all() as Array<{ name: string }>
  if (!providerCols.some(c => c.name === 'failover_api_key')) {
    db.exec("ALTER TABLE providers ADD COLUMN failover_api_key TEXT DEFAULT ''")
  }

  const llmRequestCols = db.query("PRAGMA table_info(llm_requests)").all() as Array<{ name: string }>
  if (llmRequestCols.length > 0) {
    if (!llmRequestCols.some(c => c.name === 'system_prompt')) {
      db.exec("ALTER TABLE llm_requests ADD COLUMN system_prompt TEXT")
    }
    if (!llmRequestCols.some(c => c.name === 'messages_json')) {
      db.exec("ALTER TABLE llm_requests ADD COLUMN messages_json TEXT")
    }
  }

  const supervisorRunCols = db.query("PRAGMA table_info(supervisor_runs)").all() as Array<{ name: string }>
  if (supervisorRunCols.length > 0) {
    if (!supervisorRunCols.some(c => c.name === 'candidates_json')) {
      db.exec("ALTER TABLE supervisor_runs ADD COLUMN candidates_json TEXT")
    }
    if (!supervisorRunCols.some(c => c.name === 'response_text')) {
      db.exec("ALTER TABLE supervisor_runs ADD COLUMN response_text TEXT")
    }
    if (!supervisorRunCols.some(c => c.name === 'nudges_json')) {
      db.exec("ALTER TABLE supervisor_runs ADD COLUMN nudges_json TEXT")
    }
  }

  // Preferences table
  db.exec(`
    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `)

  // Clean up legacy preferences
  db.exec("DELETE FROM preferences WHERE key = 'display_format'")
  db.exec("DELETE FROM preferences WHERE key = 'alt_solver_after_rounds'")

  // Seed default providers
  const defaultProviders = [
    'anthropic', 'openai', 'groq', 'google', 'google-gemini-cli', 'xai',
    'mistral', 'minimax', 'nvidia', 'openrouter', 'ollama', 'lmstudio', 'custom',
  ]
  const upsert = db.query(
    'INSERT OR IGNORE INTO providers (id) VALUES (?)'
  )
  for (const p of defaultProviders) {
    upsert.run(p)
  }

  // Recover requests that were in-flight when process exited.
  db.exec(`
    UPDATE llm_requests
    SET status = 'pending',
        updated_at = datetime('now'),
        last_error = COALESCE(last_error || '; ', '') || 'Recovered after restart while request was in-flight'
    WHERE status = 'processing'
  `)
}

// --- Provider CRUD ---

export function listProviders(): Provider[] {
  return getDb().query('SELECT * FROM providers ORDER BY id').all() as Provider[]
}

export function getProvider(id: string): Provider | undefined {
  return getDb().query('SELECT * FROM providers WHERE id = ?').get(id) as Provider | undefined
}

export function upsertProvider(id: string, apiKey: string, failoverApiKey: string, baseUrl: string, status: string): void {
  getDb().query(
    `INSERT INTO providers (id, api_key, failover_api_key, base_url, status)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET api_key = ?, failover_api_key = ?, base_url = ?, status = ?`
  ).run(id, apiKey, failoverApiKey, baseUrl, status, apiKey, failoverApiKey, baseUrl, status)
}

// --- Profile CRUD ---

function rowToProfile(row: Record<string, unknown>): Profile {
  return {
    ...row,
    autoconnect: !!row.autoconnect,
    enabled: !!row.enabled,
  } as Profile
}

export function listProfiles(): Profile[] {
  const rows = getDb().query('SELECT * FROM profiles ORDER BY created_at').all() as Record<string, unknown>[]
  return rows.map(rowToProfile)
}

export function getProfile(id: string): Profile | undefined {
  const row = getDb().query('SELECT * FROM profiles WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToProfile(row) : undefined
}

export function createProfile(profile: Omit<Profile, 'created_at' | 'updated_at'>): Profile {
  getDb().query(
    `INSERT INTO profiles (id, name, username, password, empire, player_id, provider, model, failover_provider, failover_model, directive, todo, connection_mode, server_url, autoconnect, enabled, context_budget)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    profile.id, profile.name, profile.username, profile.password,
    profile.empire, profile.player_id, profile.provider, profile.model,
    profile.failover_provider ?? null, profile.failover_model ?? null,
    profile.directive, profile.todo || '', profile.connection_mode, profile.server_url,
    profile.autoconnect ? 1 : 0, profile.enabled ? 1 : 0, profile.context_budget ?? null,
  )
  return getProfile(profile.id)!
}

export function updateProfile(id: string, updates: Partial<Profile>): Profile | undefined {
  const allowed = [
    'name', 'username', 'password', 'empire', 'player_id',
    'provider', 'model', 'failover_provider', 'failover_model',
    'directive', 'connection_mode', 'server_url',
    'autoconnect', 'enabled', 'todo', 'context_budget',
  ]
  const sets: string[] = []
  const vals: unknown[] = []

  for (const key of allowed) {
    if (key in updates) {
      sets.push(`${key} = ?`)
      let val = (updates as Record<string, unknown>)[key]
      if (key === 'autoconnect' || key === 'enabled') val = val ? 1 : 0
      vals.push(val)
    }
  }

  if (sets.length === 0) return getProfile(id)

  sets.push("updated_at = datetime('now')")
  vals.push(id)

  getDb().query(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  return getProfile(id)
}

export function deleteProfile(id: string): void {
  getDb().query('DELETE FROM profiles WHERE id = ?').run(id)
}

// --- Log CRUD ---

export function addLogEntry(profileId: string, type: string, summary: string, detail?: string): number {
  const result = getDb().query(
    'INSERT INTO log_entries (profile_id, type, summary, detail) VALUES (?, ?, ?, ?)'
  ).run(profileId, type, summary, detail ?? null)
  const rowId = Number(result.lastInsertRowid)

  if (rowId % LOG_PRUNE_EVERY_N_INSERTS === 0) {
    getDb().query(
      `DELETE FROM log_entries
       WHERE profile_id = ?
         AND id NOT IN (
           SELECT id FROM log_entries
           WHERE profile_id = ?
           ORDER BY id DESC
           LIMIT ?
         )`
    ).run(profileId, profileId, MAX_LOG_ROWS_PER_PROFILE)
  }

  return rowId
}

export function getLogEntries(profileId: string, afterId?: number, limit: number = 100): LogEntry[] {
  if (afterId) {
    return getDb().query(
      'SELECT * FROM log_entries WHERE profile_id = ? AND id > ? ORDER BY id LIMIT ?'
    ).all(profileId, afterId, limit) as LogEntry[]
  }
  return getDb().query(
    'SELECT * FROM log_entries WHERE profile_id = ? ORDER BY id DESC LIMIT ?'
  ).all(profileId, limit) as LogEntry[]
}

export function clearLogs(profileId: string): void {
  getDb().query('DELETE FROM log_entries WHERE profile_id = ?').run(profileId)
}

export interface LlmRateWindowStats {
  callsLast60s: number
  errors429Last60s: number
  errors429Last300s: number
  failoverActivationsLast300s: number
}

export interface EnqueuedLlmRequest {
  id: number
  idempotencyKey: string
}

export interface LlmPendingSnapshot {
  id: number
  idempotency_key: string
  attempt_count: number
  system_prompt: string | null
  messages_json: string | null
}

export interface PendingMutationSnapshot {
  profile_id: string
  command: string
  destination: string | null
  created_at: string
  updated_at: string
}

export function enqueueLlmRequest(input: {
  profileId: string
  idempotencyKey: string
  modelName?: string
  providerName?: string
  systemPrompt?: string
  messagesJson?: string
  messageCount: number
  estimatedTokens: number
}): EnqueuedLlmRequest {
  const result = getDb().query(
    `INSERT INTO llm_requests (
      profile_id, idempotency_key, status, model_name, provider_name, system_prompt, messages_json, message_count, estimated_tokens
    ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
  ).run(
    input.profileId,
    input.idempotencyKey,
    input.modelName ?? null,
    input.providerName ?? null,
    input.systemPrompt ?? null,
    input.messagesJson ?? null,
    input.messageCount,
    input.estimatedTokens,
  )
  return { id: Number(result.lastInsertRowid), idempotencyKey: input.idempotencyKey }
}

export function markLlmRequestProcessing(id: number, nextAttemptCount: number): void {
  getDb().query(
    `UPDATE llm_requests
     SET status = 'processing', attempt_count = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(nextAttemptCount, id)
}

export function markLlmRequestRetryableError(id: number, error: string): void {
  getDb().query(
    `UPDATE llm_requests
     SET status = 'pending', last_error = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(error, id)
}

export function markLlmRequestSucceeded(id: number, responseModel?: string, responseStopReason?: string): void {
  getDb().query(
    `UPDATE llm_requests
     SET status = 'succeeded',
         response_model = ?,
         response_stop_reason = ?,
         completed_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(responseModel ?? null, responseStopReason ?? null, id)
}

export function markLlmRequestFailed(id: number, error: string): void {
  getDb().query(
    `UPDATE llm_requests
     SET status = 'failed',
         last_error = ?,
         completed_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(error, id)
}

export function getLatestPendingLlmRequest(profileId: string): LlmPendingSnapshot | undefined {
  return getDb().query(
    `SELECT id, idempotency_key, attempt_count, system_prompt, messages_json
     FROM llm_requests
     WHERE profile_id = ? AND status = 'pending'
     ORDER BY id DESC
     LIMIT 1`
  ).get(profileId) as LlmPendingSnapshot | undefined
}

export function getPendingMutation(profileId: string): PendingMutationSnapshot | undefined {
  return getDb().query(
    `SELECT profile_id, command, destination, created_at, updated_at
     FROM pending_mutations
     WHERE profile_id = ?`
  ).get(profileId) as PendingMutationSnapshot | undefined
}

export function setPendingMutation(profileId: string, command: string, destination?: string): void {
  getDb().query(
    `INSERT INTO pending_mutations (profile_id, command, destination, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(profile_id) DO UPDATE SET
       command = excluded.command,
       destination = excluded.destination,
       updated_at = datetime('now')`
  ).run(profileId, command, destination ?? null)
}

export function clearPendingMutation(profileId: string): void {
  getDb().query('DELETE FROM pending_mutations WHERE profile_id = ?').run(profileId)
}

export function getLlmRateWindowStats(profileId: string): LlmRateWindowStats {
  const row = getDb().query(
    `SELECT
      SUM(CASE
        WHEN type = 'llm_call' AND timestamp >= datetime('now', '-60 seconds')
        THEN 1 ELSE 0
      END) AS calls_last_60s,
      SUM(CASE
        WHEN type = 'error'
          AND (summary LIKE '%429%' OR detail LIKE '%429%')
          AND timestamp >= datetime('now', '-60 seconds')
        THEN 1 ELSE 0
      END) AS errors_429_last_60s,
      SUM(CASE
        WHEN type = 'error'
          AND (summary LIKE '%429%' OR detail LIKE '%429%')
          AND timestamp >= datetime('now', '-300 seconds')
        THEN 1 ELSE 0
      END) AS errors_429_last_300s,
      SUM(CASE
        WHEN type = 'system'
          AND summary LIKE 'Switching to failover API key%'
          AND timestamp >= datetime('now', '-300 seconds')
        THEN 1 ELSE 0
      END) AS failover_activations_last_300s
    FROM log_entries
    WHERE profile_id = ?`
  ).get(profileId) as {
    calls_last_60s: number | null
    errors_429_last_60s: number | null
    errors_429_last_300s: number | null
    failover_activations_last_300s: number | null
  } | undefined

  return {
    callsLast60s: Number(row?.calls_last_60s ?? 0),
    errors429Last60s: Number(row?.errors_429_last_60s ?? 0),
    errors429Last300s: Number(row?.errors_429_last_300s ?? 0),
    failoverActivationsLast300s: Number(row?.failover_activations_last_300s ?? 0),
  }
}

// --- Stats CRUD ---

export interface StatsSnapshotInput {
  profile_id: string
  connected: boolean
  running: boolean
  adaptive_mode?: 'normal' | 'soft' | 'high' | 'critical'
  effective_context_budget_ratio?: number | null
  credits?: number | null
  ore_mined?: number | null
  trades_completed?: number | null
  systems_explored?: number | null
  source?: string
}

export interface StatsSnapshotRow {
  id: number
  profile_id: string
  ts: string
  connected: number
  running: number
  adaptive_mode: string
  effective_context_budget_ratio: number | null
  credits: number | null
  ore_mined: number | null
  trades_completed: number | null
  systems_explored: number | null
  source: string | null
}

export interface StatsDelta1h {
  latest_ts: string | null
  anchor_ts: string | null
  credits: number
  ore_mined: number
  trades_completed: number
  systems_explored: number
}

export interface StatsEventRow {
  id: number
  profile_id: string
  ts: string
  type: string
  value: string | null
}

export interface ProfileSkillsRow {
  profile_id: string
  ts: string
  skills_json: string
}

export interface SupervisorRunRow {
  id: number
  status: string
  provider_name: string | null
  model_name: string | null
  candidate_count: number
  candidates_json: string | null
  response_text: string | null
  nudges_json: string | null
  nudges_sent: number
  last_error: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export function addStatsSnapshot(snapshot: StatsSnapshotInput): number {
  const result = getDb().query(
    `INSERT INTO stats_snapshots (
      profile_id, connected, running, adaptive_mode, effective_context_budget_ratio,
      credits, ore_mined, trades_completed, systems_explored, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    snapshot.profile_id,
    snapshot.connected ? 1 : 0,
    snapshot.running ? 1 : 0,
    snapshot.adaptive_mode ?? 'normal',
    snapshot.effective_context_budget_ratio ?? null,
    snapshot.credits ?? null,
    snapshot.ore_mined ?? null,
    snapshot.trades_completed ?? null,
    snapshot.systems_explored ?? null,
    snapshot.source ?? 'poll',
  )
  const rowId = Number(result.lastInsertRowid)

  if (rowId % STATS_PRUNE_EVERY_N_INSERTS === 0) {
    getDb().query(
      `DELETE FROM stats_snapshots
       WHERE profile_id = ?
         AND id NOT IN (
           SELECT id FROM stats_snapshots
           WHERE profile_id = ?
           ORDER BY id DESC
           LIMIT ?
         )`
    ).run(snapshot.profile_id, snapshot.profile_id, MAX_STATS_ROWS_PER_PROFILE)
  }

  return rowId
}

export function getLatestStatsSnapshot(profileId: string): StatsSnapshotRow | undefined {
  return getDb().query(
    'SELECT * FROM stats_snapshots WHERE profile_id = ? ORDER BY id DESC LIMIT 1'
  ).get(profileId) as StatsSnapshotRow | undefined
}

export function listStatsSnapshots(profileId: string, limit: number = 120): StatsSnapshotRow[] {
  return getDb().query(
    'SELECT * FROM stats_snapshots WHERE profile_id = ? ORDER BY id DESC LIMIT ?'
  ).all(profileId, limit) as StatsSnapshotRow[]
}

export function getStatsDelta1h(profileId: string): StatsDelta1h | null {
  const snapshots = listStatsSnapshots(profileId, 240)
  if (snapshots.length === 0) return null
  const newest = snapshots[0]
  const oneHourAgo = Date.now() - (60 * 60 * 1000)
  const anchor = snapshots.find((s) => new Date(s.ts).getTime() <= oneHourAgo) || snapshots[snapshots.length - 1]
  return {
    latest_ts: newest?.ts ?? null,
    anchor_ts: anchor?.ts ?? null,
    credits: numOrZero(newest?.credits) - numOrZero(anchor?.credits),
    ore_mined: numOrZero(newest?.ore_mined) - numOrZero(anchor?.ore_mined),
    trades_completed: numOrZero(newest?.trades_completed) - numOrZero(anchor?.trades_completed),
    systems_explored: numOrZero(newest?.systems_explored) - numOrZero(anchor?.systems_explored),
  }
}

export function addStatsEvent(profileId: string, type: string, value?: string): number {
  const result = getDb().query(
    'INSERT INTO stats_events (profile_id, type, value) VALUES (?, ?, ?)'
  ).run(profileId, type, value ?? null)
  return Number(result.lastInsertRowid)
}

export function listStatsEvents(profileId: string, limit: number = 100): StatsEventRow[] {
  return getDb().query(
    'SELECT * FROM stats_events WHERE profile_id = ? ORDER BY id DESC LIMIT ?'
  ).all(profileId, limit) as StatsEventRow[]
}

export function upsertProfileSkills(profileId: string, skills: Record<string, number>): void {
  getDb().query(
    `INSERT INTO profile_skills (profile_id, ts, skills_json)
     VALUES (?, datetime('now'), ?)
     ON CONFLICT(profile_id) DO UPDATE SET
       ts = excluded.ts,
       skills_json = excluded.skills_json`
  ).run(profileId, JSON.stringify(skills))
}

export function getProfileSkills(profileId: string): { ts: string; skills: Record<string, number> } | null {
  const row = getDb().query(
    'SELECT profile_id, ts, skills_json FROM profile_skills WHERE profile_id = ?'
  ).get(profileId) as ProfileSkillsRow | undefined
  if (!row) return null
  try {
    const parsed = JSON.parse(row.skills_json) as Record<string, unknown>
    const skills = Object.fromEntries(
      Object.entries(parsed)
        .map(([skill, level]) => [skill, Number(level)] as const)
        .filter(([, level]) => Number.isFinite(level))
    )
    return { ts: row.ts, skills }
  } catch {
    return { ts: row.ts, skills: {} }
  }
}

export function listProfileSkills(): Array<{ profile_id: string; ts: string; skills: Record<string, number> }> {
  const rows = getDb().query(
    'SELECT profile_id, ts, skills_json FROM profile_skills ORDER BY ts DESC'
  ).all() as ProfileSkillsRow[]
  return rows.map((row) => {
    try {
      const parsed = JSON.parse(row.skills_json) as Record<string, unknown>
      const skills = Object.fromEntries(
        Object.entries(parsed)
          .map(([skill, level]) => [skill, Number(level)] as const)
          .filter(([, level]) => Number.isFinite(level))
      )
      return { profile_id: row.profile_id, ts: row.ts, skills }
    } catch {
      return { profile_id: row.profile_id, ts: row.ts, skills: {} }
    }
  })
}

function numOrZero(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export function createSupervisorRun(input: {
  providerName?: string
  modelName?: string
  candidateCount: number
  candidatesJson?: string | null
}): number {
  const result = getDb().query(
    `INSERT INTO supervisor_runs (
      status, provider_name, model_name, candidate_count, candidates_json, nudges_sent
    ) VALUES ('processing', ?, ?, ?, ?, 0)`
  ).run(
    input.providerName ?? null,
    input.modelName ?? null,
    input.candidateCount,
    input.candidatesJson ?? null,
  )
  return Number(result.lastInsertRowid)
}

export function recordSupervisorRunResponse(id: number, responseText: string): void {
  getDb().query(
    `UPDATE supervisor_runs
     SET response_text = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(responseText, id)
}

export function markSupervisorRunSucceeded(id: number, nudgesSent: number, nudgesJson?: string | null): void {
  getDb().query(
    `UPDATE supervisor_runs
     SET status = 'succeeded',
         nudges_json = ?,
         nudges_sent = ?,
         completed_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(nudgesJson ?? null, nudgesSent, id)
}

export function markSupervisorRunFailed(id: number, error: string, nudgesJson?: string | null): void {
  getDb().query(
    `UPDATE supervisor_runs
     SET status = 'failed',
         nudges_json = ?,
         last_error = ?,
         completed_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(nudgesJson ?? null, error, id)
}

export function listSupervisorRuns(limit: number = 100): SupervisorRunRow[] {
  return getDb().query(
    'SELECT * FROM supervisor_runs ORDER BY id DESC LIMIT ?'
  ).all(limit) as SupervisorRunRow[]
}

// --- Preferences CRUD ---

export function getPreference(key: string): string | null {
  const row = getDb().query('SELECT value FROM preferences WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setPreference(key: string, value: string): void {
  getDb().query(
    'INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?'
  ).run(key, value, value)
}

export function getAllPreferences(): Record<string, string> {
  const rows = getDb().query('SELECT key, value FROM preferences').all() as Array<{ key: string; value: string }>
  const prefs: Record<string, string> = {}
  for (const row of rows) prefs[row.key] = row.value
  return prefs
}

export function pruneOldRows(): void {
  const db = getDb()
  const cutoffModifier = `-${RETENTION_DAYS} days`
  const successContextCutoffModifier = `-${SUCCESS_CONTEXT_RETENTION_HOURS} hours`

  db.query(
    `UPDATE llm_requests
     SET system_prompt = NULL,
         messages_json = NULL
     WHERE status = 'succeeded'
       AND completed_at IS NOT NULL
       AND completed_at < datetime('now', ?)
       AND (system_prompt IS NOT NULL OR messages_json IS NOT NULL)`
  ).run(successContextCutoffModifier)

  db.query(
    `DELETE FROM llm_requests
     WHERE created_at < datetime('now', ?)`
  ).run(cutoffModifier)

  db.query(
    `DELETE FROM log_entries
     WHERE timestamp < datetime('now', ?)`
  ).run(cutoffModifier)

  db.query(
    `DELETE FROM stats_snapshots
     WHERE ts < datetime('now', ?)`
  ).run(cutoffModifier)

  db.query(
    `DELETE FROM stats_events
     WHERE ts < datetime('now', ?)`
  ).run(cutoffModifier)
}
