import { Hono } from 'hono'
import { fetchGameCommands, type GameCommandInfo } from '../lib/schema'

const commands = new Hono()

const cache = new Map<string, { cmds: GameCommandInfo[]; time: number }>()
const CACHE_TTL = 5 * 60 * 1000

commands.get('/', async (c) => {
  const serverUrl = c.req.query('server_url') || 'https://game.spacemolt.com'
  const apiVersion = c.req.query('api_version') === 'v2' ? 'v2' : 'v1'
  const apiBase = serverUrl.replace(/\/$/, '') + `/api/${apiVersion}`
  const cacheKey = `${apiBase}`
  const now = Date.now()
  const cached = cache.get(cacheKey)
  if (cached && now - cached.time < CACHE_TTL) return c.json(cached.cmds)
  const cmds = canonicalizeCommands(await fetchGameCommands(apiBase))
  if (cmds.length > 0) cache.set(cacheKey, { cmds, time: now })
  return c.json(cmds)
})

export default commands

function canonicalizeCommands(commands: GameCommandInfo[]): GameCommandInfo[] {
  const preferred = new Map<string, GameCommandInfo>()

  for (const command of commands) {
    const shortName = stripNamespacedAlias(command.name)
    const next: GameCommandInfo = { ...command, name: shortName }
    const existing = preferred.get(shortName)
    if (!existing) {
      preferred.set(shortName, next)
      continue
    }
    if (existing.name !== shortName && command.name === shortName) {
      preferred.set(shortName, next)
    }
  }

  return [...preferred.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function stripNamespacedAlias(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[\s-]+/g, '_')
  const segments = normalized.split('_').filter(Boolean)
  if (segments.length < 3) return normalized
  const knownPrefixes = new Set([
    'auth',
    'combat',
    'faction',
    'market',
    'salvage',
    'ship',
    'social',
  ])
  if (!knownPrefixes.has(segments[0])) return normalized
  return segments.slice(1).join('_')
}
