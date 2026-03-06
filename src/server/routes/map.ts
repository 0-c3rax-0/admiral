import { Hono } from 'hono'

const map = new Hono()

type CacheEntry = {
  expiresAt: number
  value: unknown
}

const cache = new Map<string, CacheEntry>()
const MAP_TTL_MS = 15_000
const ACTIVITY_TTL_MS = 10_000
const SYSTEM_TTL_MS = 20_000

function normalizeServerUrl(raw: string | undefined): string {
  const base = (raw || 'https://game.spacemolt.com').trim().replace(/\/$/, '')
  return base || 'https://game.spacemolt.com'
}

async function fetchJsonCached(url: string, ttlMs: number): Promise<unknown> {
  const now = Date.now()
  const hit = cache.get(url)
  if (hit && hit.expiresAt > now) return hit.value

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'SpaceMolt-Admiral' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Map upstream failed: HTTP ${resp.status}${body ? ` - ${body.slice(0, 200)}` : ''}`)
  }
  const data = await resp.json()
  cache.set(url, { expiresAt: now + ttlMs, value: data })
  return data
}

map.get('/', async (c) => {
  try {
    const serverUrl = normalizeServerUrl(c.req.query('server_url'))
    const data = await fetchJsonCached(`${serverUrl}/api/map`, MAP_TTL_MS)
    return c.json(data)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
  }
})

map.get('/activity', async (c) => {
  try {
    const serverUrl = normalizeServerUrl(c.req.query('server_url'))
    const data = await fetchJsonCached(`${serverUrl}/api/map/activity`, ACTIVITY_TTL_MS)
    return c.json(data)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
  }
})

map.get('/system/:id', async (c) => {
  try {
    const id = c.req.param('id')
    if (!id) return c.json({ error: 'system id is required' }, 400)
    const serverUrl = normalizeServerUrl(c.req.query('server_url'))
    const data = await fetchJsonCached(`${serverUrl}/api/map/system/${encodeURIComponent(id)}`, SYSTEM_TTL_MS)
    return c.json(data)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
  }
})

export default map
