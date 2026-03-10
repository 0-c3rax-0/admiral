import fs from 'fs'
import path from 'path'

type KbPoiKind = 'station' | 'ore' | 'ice' | 'gas'

type KbPoiRecord = {
  systemPage: string
  systemName: string
  poiName: string
  kind: KbPoiKind
}

const KB_SYSTEMS_INDEX_URL = 'https://rsned.github.io/spacemolt-kb/systems/index.html'
const KB_SYSTEMS_BASE_URL = 'https://rsned.github.io/spacemolt-kb/systems/'
const KB_CACHE_TTL_MS = 6 * 60 * 60_000
const KB_CACHE_PATH = path.join(process.cwd(), 'data', 'system-kb-cache.json')

let kbCache: { expiresAt: number; pois: KbPoiRecord[] } | null = null
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

function readPersistentCache(): KbPoiRecord[] | null {
  try {
    const raw = fs.readFileSync(KB_CACHE_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as { expiresAt?: unknown; pois?: unknown }
    const expiresAt = typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0
    if (expiresAt <= Date.now()) return null
    if (!Array.isArray(parsed.pois)) return null

    const pois = parsed.pois
      .filter((entry): entry is KbPoiRecord =>
        Boolean(
          entry &&
          typeof entry === 'object' &&
          typeof (entry as KbPoiRecord).systemPage === 'string' &&
          typeof (entry as KbPoiRecord).systemName === 'string' &&
          typeof (entry as KbPoiRecord).poiName === 'string' &&
          ['station', 'ore', 'ice', 'gas'].includes(String((entry as KbPoiRecord).kind)),
        ))
    if (pois.length === 0) return null
    kbCache = { expiresAt, pois }
    return pois
  } catch {
    return null
  }
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

async function loadKbPois(): Promise<KbPoiRecord[]> {
  if (kbCache && kbCache.expiresAt > Date.now()) return kbCache.pois
  const persisted = readPersistentCache()
  if (persisted) return persisted
  if (kbInFlight) return kbInFlight

  kbInFlight = (async () => {
    const indexResp = await fetch(KB_SYSTEMS_INDEX_URL, {
      headers: { 'User-Agent': 'SpaceMolt-Admiral' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!indexResp.ok) throw new Error(`KB index failed: HTTP ${indexResp.status}`)
    const indexHtml = await indexResp.text()
    const links = Array.from(new Set(Array.from(indexHtml.matchAll(/href="([a-z0-9_-]+\.html)"/gi), (m) => m[1])))
      .filter((link) => link !== 'index.html')

    const pois: KbPoiRecord[] = []
    for (const link of links) {
      const resp = await fetch(`${KB_SYSTEMS_BASE_URL}${link}`, {
        headers: { 'User-Agent': 'SpaceMolt-Admiral' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!resp.ok) continue
      const html = await resp.text()
      const systemName = extractSystemName(html, link)
      for (const row of html.matchAll(/<tr>\s*<td[^>]*>.*?<\/td>\s*<td>(.*?)<\/td>\s*<td>(.*?)<\/td>\s*<td>(.*?)<\/td>\s*<\/tr>/gis)) {
        const poiName = stripTags(row[1] || '')
        const rawType = stripTags(row[2] || '')
        const kind = classifyKbPoiType(rawType)
        if (!poiName || !kind) continue
        pois.push({ systemPage: link, systemName, poiName, kind })
      }
    }

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
