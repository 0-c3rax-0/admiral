import fs from 'fs'
import path from 'path'

type KbPoiKind = 'station' | 'ore' | 'ice' | 'gas'

type KbPoiRecord = {
  systemPage: string
  systemName: string
  poiName: string
  kind: KbPoiKind
}

type KbCacheSnapshot = {
  expiresAt: number
  pois: KbPoiRecord[]
}

const KB_SYSTEMS_INDEX_URL = 'https://rsned.github.io/spacemolt-kb/systems/index.html'
const KB_SYSTEMS_BASE_URL = 'https://rsned.github.io/spacemolt-kb/systems/'
const KB_CACHE_TTL_MS = 6 * 60 * 60_000
const KB_CACHE_PATH = path.join(process.cwd(), 'data', 'system-kb-cache.json')

let kbCache: KbCacheSnapshot | null = null
let kbInFlight: Promise<KbPoiRecord[]> | null = null

function decodeHtml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

function stripTags(text: string): string {
  return decodeHtml(text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '))
}

function normalizeKey(text: string): string {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
}

function classifyKbPoiType(rawType: string): KbPoiKind | null {
  const type = rawType.trim().toLowerCase()
  if (type === 'station') return 'station'
  if (type === 'asteroid belt') return 'ore'
  if (type === 'ice field') return 'ice'
  if (type === 'gas cloud') return 'gas'
  return null
}

function normalizeSystemLink(link: string): string {
  const trimmed = String(link || '').trim()
  if (!trimmed) return ''
  if (trimmed.endsWith('/')) return trimmed
  if (trimmed.endsWith('.html')) return trimmed
  return `${trimmed}/`
}

function extractSystemName(html: string, link: string): string {
  const h2 = stripTags((html.match(/<h2[^>]*>(.*?)<\/h2>/is) || [])[1] || '')
  if (h2) return h2

  const title = stripTags((html.match(/<title>(.*?)<\/title>/is) || [])[1] || '')
  if (title) {
    const cleaned = title.replace(/\s*-\s*Systems\s*-\s*Spacemolt KB\s*$/i, '').trim()
    if (cleaned) return cleaned
  }

  return link.replace(/\.html$/i, '')
}

function parseCachePois(rawPois: unknown): KbPoiRecord[] {
  if (!Array.isArray(rawPois)) return []
  return rawPois
    .filter((entry): entry is KbPoiRecord =>
      Boolean(
        entry &&
        typeof entry === 'object' &&
        typeof (entry as KbPoiRecord).systemPage === 'string' &&
        typeof (entry as KbPoiRecord).systemName === 'string' &&
        typeof (entry as KbPoiRecord).poiName === 'string' &&
        ['station', 'ore', 'ice', 'gas'].includes(String((entry as KbPoiRecord).kind)),
      ))
}

function readRawPersistentCache(): KbCacheSnapshot | null {
  try {
    const raw = fs.readFileSync(KB_CACHE_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as { expiresAt?: unknown; pois?: unknown }
    const expiresAt = typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0
    const pois = parseCachePois(parsed.pois)
    if (expiresAt <= 0 || pois.length === 0) return null
    return { expiresAt, pois }
  } catch {
    return null
  }
}

function readPersistentCache(): KbPoiRecord[] | null {
  const snapshot = readRawPersistentCache()
  if (!snapshot || snapshot.expiresAt <= Date.now()) return null
  kbCache = snapshot
  return snapshot.pois
}

function writePersistentCache(pois: KbPoiRecord[]): void {
  try {
    fs.mkdirSync(path.dirname(KB_CACHE_PATH), { recursive: true })
    fs.writeFileSync(KB_CACHE_PATH, JSON.stringify({
      expiresAt: Date.now() + KB_CACHE_TTL_MS,
      savedAt: Date.now(),
      pois,
    }), 'utf-8')
  } catch {
    // Ignore cache write failures; runtime cache still works.
  }
}

async function fetchKbPois(): Promise<KbPoiRecord[]> {
  const indexResp = await fetch(KB_SYSTEMS_INDEX_URL, {
    headers: { 'User-Agent': 'SpaceMolt-Admiral' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!indexResp.ok) throw new Error(`KB index failed: HTTP ${indexResp.status}`)
  const indexHtml = await indexResp.text()
  const links = Array.from(new Set([
    ...Array.from(indexHtml.matchAll(/<td>\s*<a href="([a-z0-9_-]+(?:\/|\.html))">/gi), (m) => normalizeSystemLink(m[1])),
    ...Array.from(indexHtml.matchAll(/href="([a-z0-9_-]+\.html)"/gi), (m) => normalizeSystemLink(m[1])),
  ]))
    .filter((link) => link && link !== 'index.html')

  const pois: KbPoiRecord[] = []
  for (const link of links) {
    const resp = await fetch(`${KB_SYSTEMS_BASE_URL}${link}`, {
      headers: { 'User-Agent': 'SpaceMolt-Admiral' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!resp.ok) continue
    const html = await resp.text()
    const systemName = extractSystemName(html, link)
    const poiSectionMatch = html.match(
      /<div class="section-label">Points of Interest \(\d+\)<\/div>\s*<table>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i,
    )
    const poiTableHtml = poiSectionMatch?.[1] || ''
    for (const row of poiTableHtml.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
      const cells = Array.from(row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi), (m) => stripTags(m[1] || ''))
      if (cells.length < 3) continue
      const poiName = cells[1] || ''
      const rawType = cells[2] || ''
      const kind = classifyKbPoiType(rawType)
      if (!poiName || !kind) continue
      pois.push({ systemPage: link, systemName, poiName, kind })
    }
  }
  return pois
}

async function loadKbPois(): Promise<KbPoiRecord[]> {
  if (kbCache && kbCache.expiresAt > Date.now()) return kbCache.pois
  const persisted = readPersistentCache()
  if (persisted) return persisted
  if (kbInFlight) return kbInFlight

  kbInFlight = (async () => {
    const pois = await fetchKbPois()
    kbCache = { expiresAt: Date.now() + KB_CACHE_TTL_MS, pois }
    writePersistentCache(pois)
    kbInFlight = null
    return pois
  })().catch((err) => {
    kbInFlight = null
    throw err
  })

  return kbInFlight
}

export async function syncSystemKbCacheOnStartup(): Promise<void> {
  const previous = readRawPersistentCache()
  const previousCount = previous?.pois.length ?? 0
  const nextPois = await fetchKbPois()
  if (nextPois.length === 0) {
    if (previous && previous.pois.length > 0) {
      kbCache = previous
      console.warn(`[startup] System KB sync returned no POIs; keeping cached snapshot with ${previous.pois.length} POIs`)
      return
    }
    console.warn('[startup] System KB sync returned no POIs and no previous cache exists; continuing without KB cache')
    return
  }

  kbCache = { expiresAt: Date.now() + KB_CACHE_TTL_MS, pois: nextPois }
  writePersistentCache(nextPois)

  const delta = nextPois.length - previousCount
  const qualifier = previous ? (delta === 0 ? 'unchanged count' : `delta ${delta >= 0 ? '+' : ''}${delta}`) : 'initialized'
  console.log(`[startup] System KB cache synced: ${nextPois.length} POIs (${qualifier})`)
}

export async function lookupKbPoiKind(target: string): Promise<KbPoiKind | null> {
  const key = normalizeKey(target)
  if (!key) return null

  const pois = await loadKbPois()
  for (const poi of pois) {
    const poiNameKey = normalizeKey(poi.poiName)
    if (poiNameKey === key) return poi.kind
    const slugKey = poiNameKey.replace(/\s+/g, '_')
    if (slugKey === key.replace(/\s+/g, '_')) return poi.kind
  }

  return null
}
