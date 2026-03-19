type TickHealthSnapshot = {
  serverUrl: string
  healthUrl: string
  status: string | null
  version: string | null
  tick: number | null
  estimatedNextTickUtc: string | null
  updatedAt: number
  error: string | null
}

export type TickTiming = {
  current_tick: number | null
  estimated_next_tick_utc: string | null
  estimated_next_tick_local: string | null
  next_mutation_at_utc: string | null
  next_mutation_at_local: string | null
  arrival_tick: number | null
  ticks_until_arrival: number | null
  arrival_at_utc: string | null
  arrival_at_local: string | null
  health_updated_at_utc: string | null
  health_error: string | null
  source_timezone: 'UTC'
  display_timezone: 'Europe/Berlin'
}

type CacheEntry = {
  snapshot: TickHealthSnapshot
  inFlight: Promise<void> | null
}

const DEFAULT_SERVER_URL = 'https://game.spacemolt.com'
const POLL_INTERVAL_MS = 5_000
const REQUEST_TIMEOUT_MS = 4_000
const cache = new Map<string, CacheEntry>()
let pollTimer: ReturnType<typeof setInterval> | null = null

function normalizeServerUrl(serverUrl: string | null | undefined): string {
  const trimmed = (serverUrl || DEFAULT_SERVER_URL).trim()
  return (trimmed || DEFAULT_SERVER_URL).replace(/\/+$/, '')
}

function buildHealthUrl(serverUrl: string): string {
  return `${serverUrl}/health`
}

function getEntry(serverUrl: string | null | undefined): CacheEntry {
  const normalized = normalizeServerUrl(serverUrl)
  const existing = cache.get(normalized)
  if (existing) return existing
  const snapshot: TickHealthSnapshot = {
    serverUrl: normalized,
    healthUrl: buildHealthUrl(normalized),
    status: null,
    version: null,
    tick: null,
    estimatedNextTickUtc: null,
    updatedAt: 0,
    error: null,
  }
  const entry: CacheEntry = { snapshot, inFlight: null }
  cache.set(normalized, entry)
  return entry
}

async function refreshEntry(entry: CacheEntry): Promise<void> {
  if (entry.inFlight) return entry.inFlight
  entry.inFlight = (async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const resp = await fetch(entry.snapshot.healthUrl, { signal: controller.signal })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json() as Record<string, unknown>
      entry.snapshot = {
        ...entry.snapshot,
        status: typeof data.status === 'string' ? data.status : null,
        version: typeof data.version === 'string' ? data.version : null,
        tick: toFiniteNumber(data.tick),
        estimatedNextTickUtc: typeof data.estimated_next_tick === 'string' ? data.estimated_next_tick : null,
        updatedAt: Date.now(),
        error: null,
      }
    } catch (err) {
      entry.snapshot = {
        ...entry.snapshot,
        updatedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      }
    } finally {
      clearTimeout(timeout)
      entry.inFlight = null
    }
  })()
  return entry.inFlight
}

export function ensureTickHealthPolling(serverUrls: Array<string | null | undefined>): void {
  for (const serverUrl of serverUrls) {
    void refreshEntry(getEntry(serverUrl))
  }
  if (pollTimer) return
  pollTimer = setInterval(() => {
    for (const entry of cache.values()) {
      void refreshEntry(entry)
    }
  }, POLL_INTERVAL_MS)
}

export function getTickHealthSnapshot(serverUrl: string | null | undefined): TickHealthSnapshot {
  const entry = getEntry(serverUrl)
  if (entry.snapshot.updatedAt === 0) {
    void refreshEntry(entry)
  }
  return entry.snapshot
}

export function buildTickTiming(serverUrl: string | null | undefined, gameState: Record<string, unknown> | null | undefined): TickTiming {
  const health = getTickHealthSnapshot(serverUrl)
  const arrivalTick = extractArrivalTick(gameState)
  const ticksUntilArrival = health.tick !== null && arrivalTick !== null
    ? Math.max(0, arrivalTick - health.tick)
    : null
  const nextTickDate = parseIsoDate(health.estimatedNextTickUtc)
  const arrivalDate = nextTickDate && ticksUntilArrival !== null
    ? new Date(nextTickDate.getTime() + Math.max(0, ticksUntilArrival - 1) * 10_000)
    : null

  return {
    current_tick: health.tick,
    estimated_next_tick_utc: health.estimatedNextTickUtc,
    estimated_next_tick_local: formatBerlin(health.estimatedNextTickUtc),
    next_mutation_at_utc: health.estimatedNextTickUtc,
    next_mutation_at_local: formatBerlin(health.estimatedNextTickUtc),
    arrival_tick: arrivalTick,
    ticks_until_arrival: ticksUntilArrival,
    arrival_at_utc: arrivalDate ? arrivalDate.toISOString() : null,
    arrival_at_local: arrivalDate ? formatBerlin(arrivalDate.toISOString()) : null,
    health_updated_at_utc: health.updatedAt > 0 ? new Date(health.updatedAt).toISOString() : null,
    health_error: health.error,
    source_timezone: 'UTC',
    display_timezone: 'Europe/Berlin',
  }
}

function extractArrivalTick(gameState: Record<string, unknown> | null | undefined): number | null {
  if (!gameState || typeof gameState !== 'object') return null
  const location = (gameState.location as Record<string, unknown> | undefined) || {}
  return toFiniteNumber(
    location.transit_arrival_tick ??
    gameState.transit_arrival_tick ??
    location.arrival_tick ??
    gameState.arrival_tick,
  )
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function parseIsoDate(value: string | null): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatBerlin(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}
