import { Hono } from 'hono'
import { listProfiles, getProfile, createProfile, updateProfile, deleteProfile, getStatsDelta1h, upsertProfileSkills } from '../lib/db'
import { overwriteProfileAgentsFromDirective } from '../lib/agent'
import { agentManager } from '../lib/agent-manager'
import type { CommandResult } from '../lib/connections/interface'
import { is429PredictionEnabled, predict429Risk } from '../lib/loop'
import { addMarketSnapshot, addTradeEvent } from '../lib/economy-db'
import { getAgentRole, setAgentRole } from '../lib/agent-learning'

const profiles = new Hono()

// GET /api/profiles
profiles.get('/', (c) => {
  const all = listProfiles()
  return c.json(all.map(p => ({
    ...p,
    agent_role: getAgentRole(p.id),
    ...agentManager.getStatus(p.id),
    stats_delta_1h: getStatsDelta1h(p.id),
    rate_risk: getRateRiskPayload(p.id),
  })))
})

// POST /api/profiles
profiles.post('/', async (c) => {
  const body = await c.req.json()
  const { name, username, password, empire, provider, model, directive, connection_mode, server_url, context_budget } = body
  if (!name) return c.json({ error: 'Name is required' }, 400)
  try {
    const profile = createProfile({
      id: crypto.randomUUID(),
      name,
      username: username || null,
      password: password || null,
      empire: empire || '',
      player_id: null,
      provider: provider || null,
      model: model || null,
      failover_provider: null,
      failover_model: null,
      directive: directive || '',
      todo: '',
      context_budget: context_budget ?? null,
      connection_mode: connection_mode || 'http',
      server_url: server_url || 'https://game.spacemolt.com',
      autoconnect: true,
      enabled: true,
    })
    return c.json(profile, 201)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('UNIQUE constraint')) return c.json({ error: 'A profile with that name already exists' }, 409)
    return c.json({ error: msg }, 500)
  }
})

// GET /api/profiles/:id
profiles.get('/:id', (c) => {
  const profile = getProfile(c.req.param('id'))
  if (!profile) return c.json({ error: 'Not found' }, 404)
  const status = agentManager.getStatus(c.req.param('id'))
  return c.json({
    ...profile,
    agent_role: getAgentRole(c.req.param('id')),
    ...status,
    stats_delta_1h: getStatsDelta1h(c.req.param('id')),
    rate_risk: getRateRiskPayload(c.req.param('id')),
  })
})

// PUT /api/profiles/:id
profiles.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  if (body.agent_role !== undefined) {
    setAgentRole(id, String(body.agent_role))
  }
  const profile = updateProfile(id, body)
  if (!profile) return c.json({ error: 'Not found' }, 404)
  if (body.directive !== undefined) {
    overwriteProfileAgentsFromDirective(profile)
    const tsUtc = new Date().toISOString()
    console.log(`[profiles] Directive updated for "${profile.name}" (${id}) at ${tsUtc}; length=${(profile.directive || '').length}`)
    agentManager.restartTurn(id)
  }
  return c.json(profile)
})

// DELETE /api/profiles/:id
profiles.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await agentManager.disconnect(id)
  deleteProfile(id)
  return c.json({ ok: true })
})

// POST /api/profiles/:id/connect
profiles.post('/:id/connect', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const action = (body as Record<string, unknown>).action as string || 'connect'
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  try {
    if (action === 'disconnect') {
      await agentManager.disconnect(id)
      return c.json({ connected: false, running: false })
    }
    await agentManager.connect(id)
    if (action === 'connect_llm' && profile.provider && profile.provider !== 'manual' && profile.model) {
      await agentManager.startLLM(id)
    }
    return c.json(agentManager.getStatus(id))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith('CONNECT_THROTTLED:')) {
      return c.json({ error: msg.replace('CONNECT_THROTTLED:', '').trim() }, 429)
    }
    return c.json({ error: msg }, 500)
  }
})

// POST /api/profiles/:id/command
profiles.post('/:id/command', async (c) => {
  const id = c.req.param('id')
  const { command, args } = await c.req.json()
  if (!command) return c.json({ error: 'Missing command' }, 400)
  const agent = agentManager.getAgent(id)
  if (!agent || !agent.isConnected) return c.json({ error: 'Agent not connected' }, 400)
  try {
    const result = await agent.executeCommand(command, args)
    ingestEconomyData(id, command, args, result)
    if (command === 'get_skills') {
      const skills = extractSkillsFromCommandResult(result)
      if (skills) upsertProfileSkills(id, skills)
    }
    return c.json(result)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// POST /api/profiles/batch — batch connect/disconnect multiple agents
profiles.post('/batch', async (c) => {
  const body = await c.req.json()
  const action = body.action as string // 'connect_llm' | 'disconnect'
  const profileIds = body.ids as string[] | undefined
  const group = body.group as string | undefined

  if (!action || !['connect_llm', 'disconnect'].includes(action)) {
    return c.json({ error: 'action must be connect_llm or disconnect' }, 400)
  }

  let targets = listProfiles()
  if (profileIds && profileIds.length > 0) {
    const idSet = new Set(profileIds)
    targets = targets.filter(p => idSet.has(p.id))
  }
  if (group) {
    targets = targets.filter(p => (p as unknown as Record<string, unknown>).group_name === group)
  }

  const results: Array<{ id: string; name: string; ok: boolean; error?: string }> = []

  for (const profile of targets) {
    try {
      if (action === 'disconnect') {
        await agentManager.disconnect(profile.id)
        results.push({ id: profile.id, name: profile.name, ok: true })
      } else {
        await agentManager.connect(profile.id)
        if (profile.provider && profile.provider !== 'manual' && profile.model) {
          await agentManager.startLLM(profile.id)
        }
        results.push({ id: profile.id, name: profile.name, ok: true })
      }
    } catch (err) {
      results.push({ id: profile.id, name: profile.name, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return c.json({ action, count: results.length, results })
})

// POST /api/profiles/:id/nudge
profiles.post('/:id/nudge', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const message = (body as Record<string, unknown>).message as string
  if (!message?.trim()) return c.json({ error: 'message is required' }, 400)
  const status = agentManager.getStatus(id)
  if (!status.running) return c.json({ error: 'Agent is not running' }, 400)
  agentManager.nudge(id, message.trim())
  return c.json({ ok: true })
})

// GET /api/profiles/:id/memory
profiles.get('/:id/memory', (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  const content = agentManager.getMemory(id)
  return c.json({ content })
})

// POST /api/profiles/:id/memory/save
profiles.post('/:id/memory/save', (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  const saved = agentManager.saveMemory(id)
  return c.json({ ok: true, saved })
})

// DELETE /api/profiles/:id/memory
profiles.delete('/:id/memory', (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  agentManager.resetMemory(id)
  return c.json({ ok: true })
})

export default profiles

function getRateRiskPayload(profileId: string) {
  if (!is429PredictionEnabled()) return null
  const risk = predict429Risk(profileId)
  return risk.level === 'LOW' ? null : risk
}

function extractSkillsFromCommandResult(result: CommandResult): Record<string, number> | null {
  const data = result.structuredContent ?? result.result ?? result
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  const candidates = [
    record.skills,
    record.player && typeof record.player === 'object'
      ? (record.player as Record<string, unknown>).skills
      : null,
    record.result && typeof record.result === 'object'
      ? (record.result as Record<string, unknown>).skills
      : null,
  ]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const skills = Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .map(([skill, level]) => {
          const numericLevel = typeof level === 'object' && level && 'level' in level
            ? Number((level as Record<string, unknown>).level)
            : Number(level)
          return [skill, numericLevel] as const
        })
        .filter(([, level]) => Number.isFinite(level))
    )
    if (Object.keys(skills).length > 0) return skills
  }
  return null
}

function ingestEconomyData(profileId: string, command: string, args: Record<string, unknown> | undefined, result: CommandResult): void {
  try {
    if (command === 'view_market') {
      const category = typeof args?.category === 'string' && args.category.trim() ? args.category.trim().toLowerCase() : 'unknown'
      const data = result.structuredContent ?? result.result ?? result
      const entries = extractMarketEntries(data)
      if (entries.length > 0) {
        addMarketSnapshot({
          profile_id: profileId,
          category,
          system_name: extractLocationName(data, 'system'),
          poi_name: extractLocationName(data, 'poi'),
          source: command,
          entries,
        })
      }
      return
    }

    if (command === 'buy' || command === 'sell') {
      const trade = extractTradeEvent(profileId, command, result)
      if (trade) addTradeEvent(trade)
    }
  } catch {
    // Economy ingest is best-effort and must not break gameplay commands.
  }
}

function extractTradeEvent(profileId: string, command: string, result: CommandResult) {
  const data = result.structuredContent ?? result.result ?? result
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  const quantity = toFiniteNumber(
    record.quantity_sold ?? record.quantity_bought ?? record.quantity ?? record.filled_quantity ?? record.amount
  )
  if (quantity === null || quantity <= 0) return null

  const itemName = String(
    record.item_name ?? record.name ?? record.item_id ?? ((record.item as Record<string, unknown> | undefined)?.name) ?? ''
  ).trim()
  if (!itemName) return null

  const unitPrice = toFiniteNumber(record.price_each ?? record.unit_price ?? record.price ?? record.executed_price)
  const totalPrice = toFiniteNumber(record.total_earned ?? record.total_spent ?? record.total_price)

  return {
    profile_id: profileId,
    trade_type: command as 'buy' | 'sell',
    item_id: stringOrNull(record.item_id),
    item_name: itemName,
    quantity,
    unit_price: unitPrice,
    total_price: totalPrice ?? (unitPrice !== null ? unitPrice * quantity : null),
    system_name: extractLocationName(data, 'system'),
    poi_name: extractLocationName(data, 'poi'),
    source_command: command,
    raw_json: JSON.stringify(data),
  }
}

function extractMarketEntries(data: unknown): Array<{
  item_id: string | null
  item_name: string
  best_bid: number | null
  best_ask: number | null
  bid_volume: number | null
  ask_volume: number | null
}> {
  if (!data || typeof data !== 'object') return []
  const record = data as Record<string, unknown>
  const candidates = [
    record.items,
    record.orders,
    record.market,
    record.result && typeof record.result === 'object' ? (record.result as Record<string, unknown>).items : null,
    record.result && typeof record.result === 'object' ? (record.result as Record<string, unknown>).orders : null,
  ]

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const entries = candidate
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const row = item as Record<string, unknown>
        const itemName = String(row.name ?? row.item_name ?? row.item_id ?? '').trim()
        if (!itemName) return null
        return {
          item_id: stringOrNull(row.item_id),
          item_name: itemName,
          best_bid: toFiniteNumber(row.best_bid ?? row.bid_price ?? row.buy_price ?? row.highest_buy ?? row.bid),
          best_ask: toFiniteNumber(row.best_ask ?? row.ask_price ?? row.sell_price ?? row.lowest_sell ?? row.ask),
          bid_volume: toFiniteNumber(row.bid_volume ?? row.buy_volume ?? row.demand ?? row.quantity_buy),
          ask_volume: toFiniteNumber(row.ask_volume ?? row.sell_volume ?? row.supply ?? row.quantity_sell ?? row.quantity),
        }
      })
      .filter((entry): entry is {
        item_id: string | null
        item_name: string
        best_bid: number | null
        best_ask: number | null
        bid_volume: number | null
        ask_volume: number | null
      } => Boolean(entry))
    if (entries.length > 0) return entries
  }

  return []
}

function extractLocationName(data: unknown, type: 'system' | 'poi'): string | null {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  const player = record.player && typeof record.player === 'object' ? record.player as Record<string, unknown> : null
  const location = record.location && typeof record.location === 'object' ? record.location as Record<string, unknown> : null
  if (type === 'system') {
    return stringOrNull(player?.current_system) ?? stringOrNull(location?.system_name)
  }
  return stringOrNull(player?.current_poi) ?? stringOrNull(location?.poi_name)
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
