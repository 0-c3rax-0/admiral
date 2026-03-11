import { Hono } from 'hono'
import { listProfiles } from '../../../server/lib/db'
import { createGameConnection } from '../../../server/lib/game-connection'
import { HttpConnection } from '../../../server/lib/connections/http'
import { HttpV2Connection } from '../../../server/lib/connections/http_v2'

const fleet = new Hono()
const FLEET_REQUEST_TIMEOUT_MS = 12_000

fleet.get('/ships', async (c) => {
  const enabledOnly = c.req.query('enabled_only') !== 'false'
  const targets = listProfiles().filter((profile) => !enabledOnly || profile.enabled)

  const results = await Promise.all(targets.map(async (profile) => {
    if (!profile.username || !profile.password) {
      return {
        profile_id: profile.id,
        profile_name: profile.name,
        ok: false,
        error: 'Missing username/password for this profile',
        ships: [],
      }
    }

    const connection = createFleetConnection(profile)
    try {
      await withTimeout(connection.connect(), FLEET_REQUEST_TIMEOUT_MS, `${profile.name}: connect timed out`)
      const login = await withTimeout(connection.login(profile.username, profile.password), FLEET_REQUEST_TIMEOUT_MS, `${profile.name}: login timed out`)
      if (!login.success) {
        return {
          profile_id: profile.id,
          profile_name: profile.name,
          ok: false,
          error: login.error || 'Login failed',
          ships: [],
        }
      }

      const [listShipsResp, getShipResp] = await Promise.all([
        withTimeout(connection.execute('list_ships'), FLEET_REQUEST_TIMEOUT_MS, `${profile.name}: list_ships timed out`),
        withTimeout(
          connection.execute('get_ship').catch(() => ({ result: undefined, structuredContent: undefined, error: { code: 'get_ship_failed', message: 'get_ship failed' } })),
          FLEET_REQUEST_TIMEOUT_MS,
          `${profile.name}: get_ship timed out`,
        ),
      ])

      if (listShipsResp.error) {
        return {
          profile_id: profile.id,
          profile_name: profile.name,
          ok: false,
          error: listShipsResp.error.message,
          ships: [],
        }
      }

      const activeFit = extractActiveShipFit((getShipResp.structuredContent ?? getShipResp.result) as Record<string, unknown> | undefined)
      const ships = extractOwnedShips((listShipsResp.structuredContent ?? listShipsResp.result) as Record<string, unknown> | undefined, activeFit)

      return {
        profile_id: profile.id,
        profile_name: profile.name,
        ok: true,
        error: null,
        ships,
      }
    } catch (err) {
      return {
        profile_id: profile.id,
        profile_name: profile.name,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ships: [],
      }
    } finally {
      await connection.disconnect().catch(() => {})
    }
  }))

  return c.json({
    profiles: results,
    generated_at: new Date().toISOString(),
  })
})

export default fleet

function createFleetConnection(profile: { connection_mode: string; server_url: string }) {
  if (profile.connection_mode === 'http_v2' || profile.connection_mode === 'websocket_v2' || profile.connection_mode === 'mcp_v2') {
    return new HttpV2Connection(profile.server_url)
  }
  if (profile.connection_mode === 'http' || profile.connection_mode === 'websocket' || profile.connection_mode === 'mcp') {
    return new HttpConnection(profile.server_url)
  }
  return createGameConnection(profile as Parameters<typeof createGameConnection>[0])
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function pickNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function extractActiveShipFit(data: Record<string, unknown> | undefined): { shipId: string | null; modules: string[] } {
  const record = data || {}
  const ship = asRecord(record.ship)
  const modules = asArray(record.modules)
    .map((entry) => {
      const module = asRecord(entry)
      return pickString(module?.name, module?.item_name, module?.module_id, module?.id)
    })
    .filter((entry): entry is string => Boolean(entry))
  return {
    shipId: pickString(ship?.id, ship?.ship_id, record.current_ship_id),
    modules,
  }
}

function extractOwnedShips(
  data: Record<string, unknown> | undefined,
  activeFit: { shipId: string | null; modules: string[] },
): Array<{
  ship_id: string | null
  name: string
  class_id: string | null
  location: string | null
  is_active: boolean
  hull: string | null
  fuel: string | null
  cargo_used: number | null
  modules_count: number | null
  fitting: string[]
  fitting_source: 'active_get_ship' | 'list_ships_modules_count'
}> {
  const record = data || {}
  const ships = asArray(record.ships)

  return ships.map((entry) => {
    const ship = asRecord(entry) || {}
    const shipId = pickString(ship.ship_id, ship.id)
    const isActive = Boolean(ship.is_active) || (activeFit.shipId !== null && shipId === activeFit.shipId)
    const modulesCount = pickNumber(ship.modules, ship.modules_count)
    return {
      ship_id: shipId,
      name: pickString(ship.custom_name, ship.class_name, ship.name, ship.class_id) || 'Unknown ship',
      class_id: pickString(ship.class_id),
      location: pickString(ship.location, ship.location_base_id),
      is_active: isActive,
      hull: pickString(ship.hull),
      fuel: pickString(ship.fuel),
      cargo_used: pickNumber(ship.cargo_used),
      modules_count: modulesCount,
      fitting: isActive ? activeFit.modules : [],
      fitting_source: isActive ? 'active_get_ship' : 'list_ships_modules_count',
    }
  })
}
