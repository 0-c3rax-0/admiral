import fs from 'fs'
import path from 'path'

export type ShipKbPurpose =
  | 'mining'
  | 'freighter'
  | 'combat'
  | 'combat_support'
  | 'exploration'
  | 'support'
  | 'industrial'
  | 'civilian'
  | 'covert'
  | 'specialty'
  | 'unknown'

export type ShipKbRecord = {
  name: string
  category: string
  className: string
  purpose: ShipKbPurpose
}

type ShipKbSnapshot = {
  savedAt: number
  ships: ShipKbRecord[]
}

const KB_SHIPS_HTML_PATH = path.join(process.cwd(), 'data', 'spacemolt-kb', 'ships', 'index.html')
const SHIP_KB_CACHE_PATH = path.join(process.cwd(), 'data', 'ship-kb-cache.json')

let shipKbCache: ShipKbRecord[] | null = null

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
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function classifyShipPurpose(category: string, className: string): ShipKbPurpose {
  const categoryKey = normalizeKey(category)
  const classKey = normalizeKey(className)

  if (categoryKey === 'industrial' && classKey.includes('mining')) return 'mining'
  if (categoryKey === 'commercial' && (classKey.includes('freighter') || classKey.includes('hauler'))) return 'freighter'
  if (categoryKey === 'combat') return 'combat'
  if (categoryKey === 'combat_support') return 'combat_support'
  if (categoryKey === 'exploration') return 'exploration'
  if (categoryKey === 'support') return 'support'
  if (categoryKey === 'industrial') return 'industrial'
  if (categoryKey === 'civilian') return 'civilian'
  if (categoryKey === 'covert') return 'covert'
  if (categoryKey === 'specialty') return 'specialty'
  return 'unknown'
}

export function parseShipKbHtml(html: string): ShipKbRecord[] {
  const ships: ShipKbRecord[] = []
  let currentCategory = ''
  let currentClass = ''

  const tokenPattern = /<section class="ship-category mt-3" id="[^"]+">|<h2>(.*?)<span[\s\S]*?<\/h2>|<section class="ship-class mt-3" id="[^"]+">|<h3>(.*?)<\/h3>|<tr>\s*<td>([^<]+)<\/td>/gi
  for (const match of html.matchAll(tokenPattern)) {
    if (match[0].startsWith('<h2>')) {
      currentCategory = stripTags(match[1] || '')
      currentClass = ''
      continue
    }
    if (match[0].startsWith('<h3>')) {
      currentClass = stripTags(match[2] || '')
      continue
    }
    if (match[3]) {
      const name = stripTags(match[3] || '')
      if (!name || name.toLowerCase() === 'name' || !currentCategory || !currentClass) continue
      ships.push({
        name,
        category: currentCategory,
        className: currentClass,
        purpose: classifyShipPurpose(currentCategory, currentClass),
      })
    }
  }

  return dedupeShips(ships)
}

function dedupeShips(ships: ShipKbRecord[]): ShipKbRecord[] {
  const deduped = new Map<string, ShipKbRecord>()
  for (const ship of ships) {
    const key = normalizeKey(ship.name)
    if (!key || deduped.has(key)) continue
    deduped.set(key, ship)
  }
  return [...deduped.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function writePersistentCache(ships: ShipKbRecord[]): void {
  const payload: ShipKbSnapshot = {
    savedAt: Date.now(),
    ships,
  }
  fs.mkdirSync(path.dirname(SHIP_KB_CACHE_PATH), { recursive: true })
  fs.writeFileSync(SHIP_KB_CACHE_PATH, JSON.stringify(payload, null, 2), 'utf8')
}

function readPersistentCache(): ShipKbRecord[] | null {
  try {
    const raw = fs.readFileSync(SHIP_KB_CACHE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as ShipKbSnapshot
    if (!Array.isArray(parsed?.ships) || parsed.ships.length === 0) return null
    return parsed.ships.filter((entry): entry is ShipKbRecord =>
      Boolean(
        entry &&
        typeof entry === 'object' &&
        typeof entry.name === 'string' &&
        typeof entry.category === 'string' &&
        typeof entry.className === 'string' &&
        typeof entry.purpose === 'string',
      ))
  } catch {
    return null
  }
}

export function getCachedShipKb(): ShipKbRecord[] | null {
  if (shipKbCache) return shipKbCache
  shipKbCache = readPersistentCache()
  return shipKbCache
}

export function lookupShipKbRecord(name: string): ShipKbRecord | null {
  const key = normalizeKey(name)
  if (!key) return null
  const ships = getCachedShipKb()
  if (!ships) return null
  return ships.find((ship) => normalizeKey(ship.name) === key) || null
}

export async function syncShipKbCacheOnStartup(): Promise<void> {
  const html = fs.readFileSync(KB_SHIPS_HTML_PATH, 'utf8')
  const previous = readPersistentCache()
  const ships = parseShipKbHtml(html)
  if (ships.length === 0) {
    throw new Error('Ship KB sync returned no ships')
  }

  shipKbCache = ships
  writePersistentCache(ships)

  const delta = ships.length - (previous?.length ?? 0)
  const qualifier = previous ? (delta === 0 ? 'unchanged count' : `delta ${delta >= 0 ? '+' : ''}${delta}`) : 'initialized'
  console.log(`[startup] Ship KB cache synced: ${ships.length} ships (${qualifier})`)
}
