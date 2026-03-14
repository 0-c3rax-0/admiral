import type { Profile } from '../../shared/types'
import { getStatsDelta1h, upsertProfileSkills } from './db'
import { addLedgerEvent, addMarketSnapshot, addTradeEvent } from './economy-db'
import { getAgentRole } from './agent-learning'
import { getLatestStorageSnapshot } from './agent-learning'
import type { CommandResult } from './connections/interface'
import { is429PredictionEnabled, predict429Risk } from './loop'
import { agentManager } from './agent-manager'

export function buildProfileResponse(profile: Profile) {
  return {
    ...profile,
    agent_role: getAgentRole(profile.id),
    last_storage_snapshot: getLatestStorageSnapshot(profile.id),
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
      return
    }

    if (command === 'get_action_log') {
      const data = result.structuredContent ?? result.result ?? result
      const { trades, ledger } = extractActionLogEconomyEvents(profileId, data)
      for (const trade of trades) addTradeEvent(trade)
      for (const entry of ledger) addLedgerEvent(entry)
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

function extractActionLogEconomyEvents(profileId: string, data: unknown): {
  trades: Array<Parameters<typeof addTradeEvent>[0]>
  ledger: Array<Parameters<typeof addLedgerEvent>[0]>
} {
  const entries = extractActionLogEntries(data)
  const trades: Array<Parameters<typeof addTradeEvent>[0]> = []
  const ledger: Array<Parameters<typeof addLedgerEvent>[0]> = []

  for (const entry of entries) {
    const trade = extractTradeEventFromActionLog(profileId, entry)
    if (trade) trades.push(trade)

    const ledgerEvent = extractLedgerEventFromActionLog(profileId, entry)
    if (ledgerEvent) ledger.push(ledgerEvent)
  }

  return { trades, ledger }
}

type ActionLogEntry = {
  id: number | null
  category: string
  eventType: string
  summary: string
  createdAt: string | null
  data: Record<string, unknown>
}

function extractActionLogEntries(data: unknown): ActionLogEntry[] {
  if (!data || typeof data !== 'object') return []
  const record = data as Record<string, unknown>
  const entries = Array.isArray(record.entries)
    ? record.entries
    : Array.isArray((record.result as Record<string, unknown> | undefined)?.entries)
      ? (record.result as Record<string, unknown>).entries as unknown[]
      : []

  return entries
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const row = entry as Record<string, unknown>
      return {
        id: toFiniteNumber(row.id),
        category: String(row.category ?? '').trim().toLowerCase(),
        eventType: String(row.event_type ?? row.type ?? '').trim().toLowerCase(),
        summary: String(row.summary ?? '').trim(),
        createdAt: stringOrNull(row.created_at),
        data: row.data && typeof row.data === 'object' ? row.data as Record<string, unknown> : {},
      }
    })
    .filter((entry): entry is ActionLogEntry => entry !== null && Boolean(entry.eventType))
}

function extractTradeEventFromActionLog(profileId: string, entry: ActionLogEntry) {
  const lowerType = entry.eventType
  const lowerSummary = entry.summary.toLowerCase()
  const side = inferTradeSide(entry.data, lowerType, lowerSummary)
  if (!side) return null

  const quantity = toFiniteNumber(
    entry.data.quantity ?? entry.data.filled_quantity ?? entry.data.amount ?? entry.data.units ?? entry.data.order_quantity
  )
  if (quantity === null || quantity <= 0) return null

  const itemName = String(
    entry.data.item_name ?? entry.data.item ?? entry.data.resource_name ?? entry.data.good ?? entry.data.market_item_name ?? entry.data.item_id ?? ''
  ).trim()
  if (!itemName) return null

  const unitPrice = toFiniteNumber(
    entry.data.unit_price ?? entry.data.price_each ?? entry.data.price ?? entry.data.executed_price ?? entry.data.avg_fill_price
  )
  const totalPrice = toFiniteNumber(
    entry.data.total_price ?? entry.data.total_earned ?? entry.data.total_spent ?? entry.data.value ?? entry.data.filled_total
  )

  return {
    profile_id: profileId,
    trade_type: side,
    item_id: stringOrNull(entry.data.item_id),
    item_name: itemName,
    quantity,
    unit_price: unitPrice,
    total_price: totalPrice ?? (unitPrice !== null ? unitPrice * quantity : null),
    system_name: stringOrNull(entry.data.system_name),
    poi_name: stringOrNull(entry.data.poi_name ?? entry.data.station_name),
    source_command: 'get_action_log',
    source_event_id: entry.id,
    source_event_type: entry.eventType,
    raw_json: JSON.stringify(entry),
  }
}

function extractLedgerEventFromActionLog(profileId: string, entry: ActionLogEntry) {
  const eventType = entry.eventType
  let amount: number | null = null

  if (eventType === 'mission.rescue_payment_received') {
    amount = toFiniteNumber(entry.data.amount ?? entry.data.credits ?? entry.data.payment)
  } else if (eventType === 'mission.rescue_payment_sent') {
    const value = toFiniteNumber(entry.data.amount ?? entry.data.credits ?? entry.data.payment)
    amount = value === null ? null : -Math.abs(value)
  } else if (eventType === 'combat.ship_destroyed') {
    const fee = toFiniteNumber(entry.data.self_destruct_fee)
    if (fee === null) return null
    amount = -Math.abs(fee)
  } else if (eventType === 'faction.mission_escrowed') {
    const value = toFiniteNumber(entry.data.amount ?? entry.data.credits ?? entry.data.escrow_amount)
    amount = value === null ? null : -Math.abs(value)
  } else if (eventType === 'faction.mission_escrow_refunded') {
    amount = toFiniteNumber(entry.data.amount ?? entry.data.credits ?? entry.data.escrow_amount)
  } else {
    return null
  }

  return {
    profile_id: profileId,
    category: entry.category || inferLedgerCategory(eventType),
    event_type: eventType,
    amount,
    system_name: stringOrNull(entry.data.system_name),
    poi_name: stringOrNull(entry.data.poi_name ?? entry.data.station_name),
    source_command: 'get_action_log',
    source_event_id: entry.id,
    summary: entry.summary || null,
    raw_json: JSON.stringify(entry),
  }
}

function inferTradeSide(data: Record<string, unknown>, eventType: string, summary: string): 'buy' | 'sell' | null {
  const explicit = String(data.trade_type ?? data.side ?? data.order_side ?? '').trim().toLowerCase()
  if (explicit === 'buy' || explicit === 'sell') return explicit
  if (eventType.includes('buy')) return 'buy'
  if (eventType.includes('sell')) return 'sell'
  if (summary.includes(' bought ') || summary.startsWith('bought ')) return 'buy'
  if (summary.includes(' sold ') || summary.startsWith('sold ')) return 'sell'
  return null
}

function inferLedgerCategory(eventType: string): string {
  if (eventType.startsWith('mission.')) return 'mission'
  if (eventType.startsWith('faction.')) return 'faction'
  if (eventType.startsWith('combat.')) return 'combat'
  return 'other'
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
