import type { Profile } from '../../shared/types'
import { getStatsDelta1h, upsertProfileSkills } from './db'
import { addMarketSnapshot, addTradeEvent } from './economy-db'
import { getAgentRole } from './agent-learning'
import type { CommandResult } from './connections/interface'
import { is429PredictionEnabled, predict429Risk } from './loop'
import { agentManager } from './agent-manager'

export function buildProfileResponse(profile: Profile) {
  return {
    ...profile,
    agent_role: getAgentRole(profile.id),
    ...agentManager.getStatus(profile.id),
    stats_delta_1h: getStatsDelta1h(profile.id),
    rate_risk: getRateRiskPayload(profile.id),
  }
}

export function handleProfileCommandSideEffects(
  profileId: string,
  command: string,
  args: Record<string, unknown> | undefined,
  result: CommandResult,
): void {
  ingestEconomyData(profileId, command, args, result)
  if (command === 'get_skills') {
    const skills = extractSkillsFromCommandResult(result)
    if (skills) upsertProfileSkills(profileId, skills)
  }
}

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
    record.entries,
    record.listings,
    record.result && typeof record.result === 'object' ? (record.result as Record<string, unknown>).items : null,
    record.result && typeof record.result === 'object' ? (record.result as Record<string, unknown>).orders : null,
    record.result && typeof record.result === 'object' ? (record.result as Record<string, unknown>).entries : null,
    record.result && typeof record.result === 'object' ? (record.result as Record<string, unknown>).listings : null,
    record.market && typeof record.market === 'object' ? (record.market as Record<string, unknown>).items : null,
    record.market && typeof record.market === 'object' ? (record.market as Record<string, unknown>).orders : null,
    record.market && typeof record.market === 'object' ? (record.market as Record<string, unknown>).entries : null,
    record.market && typeof record.market === 'object' ? (record.market as Record<string, unknown>).listings : null,
    record.result && typeof record.result === 'object' && (record.result as Record<string, unknown>).market && typeof (record.result as Record<string, unknown>).market === 'object'
      ? ((record.result as Record<string, unknown>).market as Record<string, unknown>).items
      : null,
    record.result && typeof record.result === 'object' && (record.result as Record<string, unknown>).market && typeof (record.result as Record<string, unknown>).market === 'object'
      ? ((record.result as Record<string, unknown>).market as Record<string, unknown>).orders
      : null,
    record.result && typeof record.result === 'object' && (record.result as Record<string, unknown>).market && typeof (record.result as Record<string, unknown>).market === 'object'
      ? ((record.result as Record<string, unknown>).market as Record<string, unknown>).entries
      : null,
    record.result && typeof record.result === 'object' && (record.result as Record<string, unknown>).market && typeof (record.result as Record<string, unknown>).market === 'object'
      ? ((record.result as Record<string, unknown>).market as Record<string, unknown>).listings
      : null,
  ]

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const entries = candidate
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const row = item as Record<string, unknown>
        const itemName = String(row.name ?? row.item_name ?? row.item_id ?? '').trim()
        if (!itemName) return null
        const directPrice = toFiniteNumber(
          row.price ?? row.unit_price ?? row.market_price ?? row.avg_price ?? row.average_price ?? row.value
        )
        const nestedBid = bestOrderPrice(row.buy_orders, 'desc')
        const nestedAsk = bestOrderPrice(row.sell_orders, 'asc')
        const nestedBidVolume = sumOrderVolume(row.buy_orders)
        const nestedAskVolume = sumOrderVolume(row.sell_orders)
        return {
          item_id: stringOrNull(row.item_id),
          item_name: itemName,
          best_bid: toFiniteNumber(
            row.best_bid ?? row.bid_price ?? row.buy_price ?? row.highest_buy ?? row.bid ?? nestedBid ?? directPrice
          ),
          best_ask: toFiniteNumber(
            row.best_ask ?? row.ask_price ?? row.sell_price ?? row.lowest_sell ?? row.ask ?? nestedAsk ?? directPrice
          ),
          bid_volume: toFiniteNumber(row.bid_volume ?? row.buy_volume ?? row.demand ?? row.quantity_buy ?? row.buy_quantity ?? nestedBidVolume),
          ask_volume: toFiniteNumber(row.ask_volume ?? row.sell_volume ?? row.supply ?? row.quantity_sell ?? row.sell_quantity ?? nestedAskVolume ?? row.quantity),
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

function bestOrderPrice(value: unknown, direction: 'asc' | 'desc'): number | null {
  if (!Array.isArray(value)) return null
  const prices = value
    .map((entry) => entry && typeof entry === 'object' ? toFiniteNumber((entry as Record<string, unknown>).price) : null)
    .filter((price): price is number => price !== null)
  if (prices.length === 0) return null
  return direction === 'asc' ? Math.min(...prices) : Math.max(...prices)
}

function sumOrderVolume(value: unknown): number | null {
  if (!Array.isArray(value)) return null
  let total = 0
  let found = false
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const quantity = toFiniteNumber((entry as Record<string, unknown>).quantity)
    if (quantity === null) continue
    total += quantity
    found = true
  }
  return found ? total : null
}
