import { Hono } from 'hono'
import { getProfile, listProfiles } from '../../../server/lib/db'
import {
  getKnownPrice,
  getLatestMarketSnapshot,
  listItemTradeSummaries,
  listProfileProfitHints,
  listRecentTradesAllProfiles,
  listRecipeEconomics,
  listRecipes,
  listTradeEvents,
  type RecipeRow,
  upsertRecipes,
  extractRecipesFromCatalog,
  listShipPrices,
} from '../../../server/lib/economy-db'
import { agentManager } from '../../../server/lib/agent-manager'

const economy = new Hono()
const GAME_SERVER_URL = process.env.NEXT_PUBLIC_GAMESERVER_URL || 'https://game.spacemolt.com'

type LiveMarketFill = {
  id: string
  timestamp: string
  item_id: string
  item_name: string
  station_id: string
  station_name: string
  quantity: number
  price_each: number
  total: number
  buyer_name: string
  seller_name: string
  is_npc: boolean
  order_type: string
}

type UpstreamStationItem = {
  item_id?: string | null
  item_name?: string | null
  best_bid?: number | null
  best_ask?: number | null
  bid_volume?: number | null
  ask_volume?: number | null
}

const CATEGORY_MATCHERS: Record<string, (itemId: string) => boolean> = {
  ore: (itemId) => itemId.endsWith('_ore'),
  ice: (itemId) => itemId.includes('ice'),
  gas: (itemId) => itemId.endsWith('_gas') || itemId.includes('gas'),
}

economy.get('/profiles/:id/trades', (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  const limit = Math.max(1, Math.min(500, parseInt(c.req.query('limit') || '100', 10) || 100))
  return c.json({ profile_id: id, trades: listTradeEvents(id, limit) })
})

economy.get('/profiles/:id/profit-hints', (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  const limit = Math.max(1, Math.min(100, parseInt(c.req.query('limit') || '25', 10) || 25))
  return c.json({ profile_id: id, hints: listProfileProfitHints(id, limit) })
})

economy.get('/profiles/:id/market/latest', (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  const category = (c.req.query('category') || 'ore').trim().toLowerCase()
  const snapshot = getLatestMarketSnapshot(id, category)
  if (!snapshot) return c.json({ error: 'No market snapshot found' }, 404)
  return c.json({ profile_id: id, category, ...snapshot })
})

economy.get('/market/fills', async (c) => {
  const stationId = (c.req.query('station_id') || '').trim().toLowerCase()
  const category = (c.req.query('category') || 'ore').trim().toLowerCase()
  const limit = Math.max(1, Math.min(100, parseInt(c.req.query('limit') || '100', 10) || 100))
  const hours = Math.max(1, Math.min(72, parseInt(c.req.query('hours') || '24', 10) || 24))
  const matcher = CATEGORY_MATCHERS[category] ?? CATEGORY_MATCHERS.ore

  try {
    const upstream = await fetch(`${GAME_SERVER_URL}/api/market/fills?hours=${hours}&limit=2000`)
    if (!upstream.ok) {
      return c.json({ error: `Upstream market fills request failed with HTTP ${upstream.status}` }, 502)
    }

    const payload = await upstream.json() as { fills?: LiveMarketFill[] }
    const fills = Array.isArray(payload.fills) ? payload.fills : []
    const filtered = fills
      .filter((fill) => {
        if (!fill || typeof fill !== 'object') return false
        if (stationId && String(fill.station_id || '').trim().toLowerCase() !== stationId) return false
        return matcher(String(fill.item_id || '').trim().toLowerCase())
      })
      .slice(0, limit)

    return c.json({
      station_id: stationId || null,
      category,
      count: filtered.length,
      fills: filtered,
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

economy.get('/market/hints', async (c) => {
  const stationId = (c.req.query('station_id') || '').trim().toLowerCase()
  const category = (c.req.query('category') || 'ore').trim().toLowerCase()
  const hours = Math.max(1, Math.min(72, parseInt(c.req.query('hours') || '24', 10) || 24))

  if (!stationId) {
    return c.json({ error: 'station_id is required' }, 400)
  }

  try {
    const { stationName, hints } = await buildMarketHints(stationId, category, hours)

    return c.json({
      station_id: stationId,
      station_name: stationName,
      category,
      count: hints.length,
      hints,
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

economy.get('/market/best-sell', async (c) => {
  const stationId = (c.req.query('station_id') || '').trim().toLowerCase()
  const category = (c.req.query('category') || 'ore').trim().toLowerCase()
  const hours = Math.max(1, Math.min(72, parseInt(c.req.query('hours') || '24', 10) || 24))
  const limit = Math.max(1, Math.min(20, parseInt(c.req.query('limit') || '5', 10) || 5))

  if (!stationId) {
    return c.json({ error: 'station_id is required' }, 400)
  }

  try {
    const { stationName, hints } = await buildMarketHints(stationId, category, hours)
    const ranked = hints
      .map((hint) => ({
        ...hint,
        score: rankHint(hint),
      }))
      .filter((hint) => hint.score > 0)
      .sort((a, b) => b.score - a.score || b.recent_trade_count - a.recent_trade_count || a.item_name.localeCompare(b.item_name))
      .slice(0, limit)

    return c.json({
      station_id: stationId,
      station_name: stationName,
      category,
      count: ranked.length,
      best: ranked.map(({ score, ...hint }) => ({
        ...hint,
        score,
        summary: buildHintSummary(hint),
      })),
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

economy.get('/prices/:itemName', (c) => {
  const itemName = c.req.param('itemName')
  const profileId = c.req.query('profile_id') || undefined
  const price = getKnownPrice(itemName, profileId)
  if (!price) return c.json({ error: 'No known price found' }, 404)
  return c.json({ item_name: itemName, price })
})

economy.get('/overview', (c) => {
  const tradeLimit = Math.max(1, Math.min(500, parseInt(c.req.query('trade_limit') || '100', 10) || 100))
  const itemLimit = Math.max(1, Math.min(100, parseInt(c.req.query('item_limit') || '30', 10) || 30))
  const profilesById = new Map(listProfiles().map((profile) => [profile.id, profile]))

  const trades = listRecentTradesAllProfiles(tradeLimit).map((trade) => ({
    ...trade,
    profile_name: profilesById.get(trade.profile_id)?.name ?? trade.profile_id,
  }))
  const itemSummaries = listItemTradeSummaries(itemLimit)

  return c.json({
    totals: {
      trades: trades.length,
      buy_trades: trades.filter((trade) => trade.trade_type === 'buy').length,
      sell_trades: trades.filter((trade) => trade.trade_type === 'sell').length,
      distinct_items: itemSummaries.length,
    },
    recent_trades: trades,
    item_summaries: itemSummaries,
  })
})

economy.get('/recipes', (c) => {
  const limit = Math.max(1, Math.min(1000, parseInt(c.req.query('limit') || '500', 10) || 500))
  return c.json({
    recipes: listRecipes(limit),
    economics: listRecipeEconomics(limit),
  })
})

economy.post('/profiles/:id/recipes/import', async (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  const agent = agentManager.getAgent(id)
  if (!agent || !agent.isConnected) return c.json({ error: 'Agent not connected' }, 400)

  try {
    let page = 1
    let totalPages = 1
    let totalImported = 0
    const allRecipes: RecipeRow[] = []

    do {
      const result = await agent.executeCommand('catalog', { type: 'recipes', page, page_size: 50 })
      const data = (result.structuredContent ?? result.result ?? result) as Record<string, unknown>
      const recipes = extractRecipesFromCatalog(data)
      if (recipes.length > 0) {
        totalImported += upsertRecipes(recipes, id)
        allRecipes.push(...recipes)
      }
      const innerData = (data.result && typeof data.result === 'object' ? data.result : data) as Record<string, unknown>
      totalPages = typeof innerData.total_pages === 'number' ? innerData.total_pages : 1
      page++
    } while (page <= totalPages && page <= 50)

    return c.json({ profile_id: id, imported: totalImported, recipes: allRecipes.slice(0, 10) })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

economy.get('/ships/prices', (c) => {
  return c.json({ prices: listShipPrices() })
})

export default economy

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

async function buildMarketHints(stationId: string, category: string, hours: number): Promise<{
  stationName: string
  hints: Array<{
    item_id: string
    item_name: string
    station_id: string
    station_name: string
    instant_sell_price: number | null
    best_ask: number | null
    recent_fill_median: number | null
    recent_fill_low: number | null
    recent_fill_high: number | null
    recent_trade_count: number
    confidence: 'low' | 'medium' | 'high'
    recommendation: 'sell_now' | 'list_near_market' | 'hold'
  }>
}> {
  const matcher = CATEGORY_MATCHERS[category] ?? CATEGORY_MATCHERS.ore
  const [fillsResp, stationResp] = await Promise.all([
    fetch(`${GAME_SERVER_URL}/api/market/fills?hours=${hours}&limit=2000`),
    fetch(`${GAME_SERVER_URL}/api/market/station/${encodeURIComponent(stationId)}`),
  ])

  if (!fillsResp.ok) {
    throw new Error(`Upstream market fills request failed with HTTP ${fillsResp.status}`)
  }
  if (!stationResp.ok) {
    throw new Error(`Upstream station market request failed with HTTP ${stationResp.status}`)
  }

  const fillsPayload = await fillsResp.json() as { fills?: LiveMarketFill[] }
  const stationPayload = await stationResp.json() as { base_name?: string; items?: UpstreamStationItem[] }
  const fills = Array.isArray(fillsPayload.fills) ? fillsPayload.fills : []
  const stationItems = Array.isArray(stationPayload.items) ? stationPayload.items : []

  const relevantFills = fills.filter((fill) => {
    if (!fill || typeof fill !== 'object') return false
    if (String(fill.station_id || '').trim().toLowerCase() !== stationId) return false
    return matcher(String(fill.item_id || '').trim().toLowerCase())
  })

  const fillsByItem = new Map<string, LiveMarketFill[]>()
  for (const fill of relevantFills) {
    const itemId = String(fill.item_id || '').trim().toLowerCase()
    const list = fillsByItem.get(itemId) ?? []
    list.push(fill)
    fillsByItem.set(itemId, list)
  }

  const stationName = stationPayload.base_name ?? stationId
  const hints = stationItems
    .filter((item) => matcher(String(item.item_id || '').trim().toLowerCase()))
    .map((item) => {
      const itemId = String(item.item_id || '').trim().toLowerCase()
      const itemName = String(item.item_name || item.item_id || '').trim()
      const itemFills = (fillsByItem.get(itemId) ?? []).slice(0, 100)
      const prices = itemFills
        .map((fill) => (typeof fill.price_each === 'number' && Number.isFinite(fill.price_each) ? fill.price_each : null))
        .filter((value): value is number => value !== null)
        .sort((a, b) => a - b)
      const instantSellPrice = positiveNumberOrNull(item.best_bid)
      const bestAsk = positiveNumberOrNull(item.best_ask)
      const recentFillMedian = median(prices)
      const recentLow = prices.length > 0 ? prices[0] : null
      const recentHigh = prices.length > 0 ? prices[prices.length - 1] : null
      const tradeCount = itemFills.length
      const confidence = deriveConfidence(tradeCount, instantSellPrice, recentFillMedian, bestAsk)
      const recommendation = deriveRecommendation(tradeCount, instantSellPrice, recentFillMedian, bestAsk)

      return {
        item_id: itemId,
        item_name: itemName,
        station_id: stationId,
        station_name: stationName,
        instant_sell_price: instantSellPrice,
        best_ask: bestAsk,
        recent_fill_median: recentFillMedian,
        recent_fill_low: recentLow,
        recent_fill_high: recentHigh,
        recent_trade_count: tradeCount,
        confidence,
        recommendation,
      }
    })
    .filter((hint) => hint.instant_sell_price !== null || hint.recent_fill_median !== null || hint.best_ask !== null)
    .sort((a, b) => {
      const scoreA = a.instant_sell_price ?? a.recent_fill_median ?? 0
      const scoreB = b.instant_sell_price ?? b.recent_fill_median ?? 0
      return scoreB - scoreA || a.item_name.localeCompare(b.item_name)
    })

  return { stationName, hints }
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function positiveNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const middle = Math.floor(values.length / 2)
  if (values.length % 2 === 1) return values[middle] ?? null
  const left = values[middle - 1]
  const right = values[middle]
  if (left === undefined || right === undefined) return null
  return Math.round((left + right) / 2)
}

function deriveConfidence(
  tradeCount: number,
  instantSellPrice: number | null,
  recentFillMedian: number | null,
  bestAsk: number | null,
): 'low' | 'medium' | 'high' {
  if (
    tradeCount >= 8
    && recentFillMedian !== null
    && (
      (instantSellPrice !== null && instantSellPrice >= recentFillMedian * 0.85)
      || (bestAsk !== null && bestAsk >= recentFillMedian * 0.85)
    )
  ) {
    return 'high'
  }
  if (tradeCount >= 3 || recentFillMedian !== null || instantSellPrice !== null || bestAsk !== null) return 'medium'
  return 'low'
}

function deriveRecommendation(
  tradeCount: number,
  instantSellPrice: number | null,
  recentFillMedian: number | null,
  bestAsk: number | null,
): 'sell_now' | 'list_near_market' | 'hold' {
  if (instantSellPrice !== null) {
    if (recentFillMedian !== null) {
      if (tradeCount >= 5 && instantSellPrice >= recentFillMedian * 0.9) return 'sell_now'
      if (instantSellPrice >= recentFillMedian * 0.75) return 'list_near_market'
      return 'hold'
    }

    if (bestAsk !== null) {
      if (instantSellPrice >= bestAsk * 0.95) return 'sell_now'
      if (instantSellPrice >= bestAsk * 0.8) return 'list_near_market'
      return 'hold'
    }

    if (tradeCount >= 3) return 'sell_now'
    return instantSellPrice >= 10 ? 'sell_now' : 'hold'
  }

  if (recentFillMedian !== null || bestAsk !== null) return 'list_near_market'
  return 'hold'
}

function rankHint(hint: {
  instant_sell_price: number | null
  recent_fill_median: number | null
  recent_trade_count: number
  confidence: 'low' | 'medium' | 'high'
  recommendation: 'sell_now' | 'list_near_market' | 'hold'
}): number {
  const basePrice = hint.instant_sell_price ?? hint.recent_fill_median ?? 0
  const tradeWeight = Math.min(hint.recent_trade_count, 20) * 2
  const confidenceWeight = hint.confidence === 'high' ? 20 : hint.confidence === 'medium' ? 10 : 0
  const recommendationWeight = hint.recommendation === 'sell_now' ? 30 : hint.recommendation === 'list_near_market' ? 10 : 0
  return basePrice + tradeWeight + confidenceWeight + recommendationWeight
}

function buildHintSummary(hint: {
  item_name: string
  instant_sell_price: number | null
  recent_fill_median: number | null
  best_ask?: number | null
  recent_trade_count: number
  recommendation: 'sell_now' | 'list_near_market' | 'hold'
}): string {
  const price = hint.instant_sell_price ?? hint.recent_fill_median ?? hint.best_ask ?? null
  if (hint.recommendation === 'sell_now' && price !== null) {
    return `${hint.item_name}: sell now around ${price} (${hint.recent_trade_count} recent trades)`
  }
  if (hint.recommendation === 'list_near_market' && price !== null) {
    return `${hint.item_name}: list near ${price} (${hint.recent_trade_count} recent trades)`
  }
  return `${hint.item_name}: hold`
}
