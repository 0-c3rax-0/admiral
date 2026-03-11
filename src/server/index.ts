import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { existsSync } from 'fs'
import { join } from 'path'
import profiles from './routes/profiles'
import logs from './routes/logs'
import providers from './routes/providers'
import models from './routes/models'
import commands from './routes/commands'
import preferences from './routes/preferences'
import { addStatsEvent, addStatsSnapshot, getPreference, listProfiles, pruneOldRows } from './lib/db'
import { pruneEconomyRows } from './lib/economy-db'
import { agentManager } from './lib/agent-manager'
import { registerServerForkRoutes, startServerForkServices } from '../fork/server'

const app = new Hono()
app.use('*', cors())

const AUTO_CONNECT_MIN_DELAY_MS = 60_000
const AUTO_CONNECT_MAX_DELAY_MS = 120_000

// API routes
app.route('/api/profiles', profiles)
app.route('/api/profiles', logs)      // logs routes include /:id/logs
app.route('/api/providers', providers)
app.route('/api/models', models)
app.route('/api/commands', commands)
app.route('/api/preferences', preferences)
registerServerForkRoutes(app)

// Health check
app.get('/api/health', (c) => c.json({ ok: true }))

// Static file serving (production) or dev proxy
// Detect production by checking for dist/ directory alongside the binary/entrypoint.
// This is more reliable than NODE_ENV because `bun build --compile` may inline
// process.env.NODE_ENV at compile time, making it unreliable at runtime.
const distDir = join(import.meta.dir, 'dist')
const hasDistDir = existsSync(distDir) || existsSync('./dist/index.html')
const isDev = !hasDistDir && process.env.NODE_ENV !== 'production'

if (isDev) {
  // Proxy non-API requests to Vite dev server
  app.all('*', async (c) => {
    try {
      const url = new URL(c.req.url)
      url.port = '3030'
      const resp = await fetch(url.toString(), {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
      })
      return new Response(resp.body, {
        status: resp.status,
        headers: resp.headers,
      })
    } catch {
      return c.text('Vite dev server not running. Start it with: bun run dev:frontend', 502)
    }
  })
} else {
  // Serve static files from dist/
  app.use('/*', serveStatic({ root: './dist' }))
  // SPA fallback
  app.get('*', serveStatic({ path: './dist/index.html' }))
}

const port = parseInt(process.env.PORT || '3031')
console.log(`Admiral listening on http://0.0.0.0:${port}`)

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback
  const parsed = parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed <= 0) return fallback
  return parsed
}

function scheduleAutoConnectOnStartup(): void {
  const enabledPref = getPreference('startup_autoconnect_enabled')
  const enabled = enabledPref === null ? true : enabledPref === 'true'
  if (!enabled) return

  const minSec = parsePositiveInt(getPreference('startup_autoconnect_min_delay_sec'), 60)
  const maxSec = parsePositiveInt(getPreference('startup_autoconnect_max_delay_sec'), 120)
  const minDelayMs = Math.min(minSec, maxSec) * 1000
  const maxDelayMs = Math.max(minSec, maxSec) * 1000

  const randomAutoConnectDelayMs = (): number => {
    const span = maxDelayMs - minDelayMs
    return minDelayMs + Math.floor(Math.random() * (span + 1))
  }

  const candidates = listProfiles().filter((p) => p.autoconnect && p.enabled)
  if (candidates.length === 0) return

  let accumulatedDelay = 0
  for (const profile of candidates) {
    accumulatedDelay += randomAutoConnectDelayMs()
    setTimeout(async () => {
      try {
        await agentManager.connect(profile.id)
        if (profile.provider && profile.provider !== 'manual' && profile.model) {
          await agentManager.startLLM(profile.id)
        }
        console.log(`[startup] Auto-connected profile "${profile.name}"`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[startup] Auto-connect failed for "${profile.name}": ${msg}`)
      }
    }, accumulatedDelay)
  }
}

scheduleAutoConnectOnStartup()

type RuntimeSnapshot = { connected: boolean; running: boolean }
const lastRuntimeState = new Map<string, RuntimeSnapshot>()

function scheduleStatsSnapshots(): void {
  const intervalSec = parsePositiveInt(getPreference('stats_snapshot_interval_sec'), 60)
  const intervalMs = Math.max(10, intervalSec) * 1000
  let inFlight = false

  const collect = async () => {
    if (inFlight) return
    inFlight = true
    try {
      const profiles = listProfiles().filter(p => p.enabled)
      for (const profile of profiles) {
        try {
          const sample = await agentManager.sampleProfileStats(profile.id)
          addStatsSnapshot({
            profile_id: profile.id,
            connected: sample.connected,
            running: sample.running,
            adaptive_mode: sample.adaptive_mode,
            effective_context_budget_ratio: sample.effective_context_budget_ratio,
            credits: sample.credits,
            ore_mined: sample.ore_mined,
            trades_completed: sample.trades_completed,
            systems_explored: sample.systems_explored,
            source: 'poll',
          })

          const prev = lastRuntimeState.get(profile.id)
          if (prev && prev.connected !== sample.connected) {
            addStatsEvent(profile.id, sample.connected ? 'connected' : 'disconnected')
          }
          if (prev && prev.running !== sample.running) {
            addStatsEvent(profile.id, sample.running ? 'llm_started' : 'llm_stopped')
          }
          lastRuntimeState.set(profile.id, { connected: sample.connected, running: sample.running })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          addStatsEvent(profile.id, 'snapshot_error', msg.slice(0, 500))
        }
      }
    } finally {
      inFlight = false
    }
  }

  setTimeout(() => { collect().catch(() => {}) }, 5_000)
  setInterval(() => { collect().catch(() => {}) }, intervalMs)
}

scheduleStatsSnapshots()
startServerForkServices()

function scheduleRetentionPrune(): void {
  const intervalMs = 15 * 60_000

  const run = () => {
    try {
      pruneOldRows()
      pruneEconomyRows()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[retention] prune failed: ${msg}`)
    }
  }

  setTimeout(run, 30_000)
  setInterval(run, intervalMs)
}

scheduleRetentionPrune()

// Ensure API callers always get JSON (never HTML fallback) for unknown API paths.
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'API route not found' }, 404)
  }
  return c.text('Not found', 404)
})

export default {
  port,
  hostname: '0.0.0.0',
  fetch: app.fetch,
  idleTimeout: 120, // seconds; must exceed SSE heartbeat interval for log streaming
}
