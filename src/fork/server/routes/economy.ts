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
} from '../../../server/lib/economy-db'
import { agentManager } from '../../../server/lib/agent-manager'

const economy = new Hono()

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
  const limit = Math.max(1, Math.min(200, parseInt(c.req.query('limit') || '100', 10) || 100))
  return c.json({
    recipes: listRecipes(limit),
    economics: listRecipeEconomics(Math.min(limit, 50)),
  })
})

economy.post('/profiles/:id/recipes/import', async (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  const agent = agentManager.getAgent(id)
  if (!agent || !agent.isConnected) return c.json({ error: 'Agent not connected' }, 400)

  try {
    const result = await agent.executeCommand('catalog', { type: 'recipes' })
    const recipes = extractRecipesFromCatalog(result.structuredContent ?? result.result ?? result)
    const imported = upsertRecipes(recipes, id)
    return c.json({ profile_id: id, imported, recipes: imported > 0 ? recipes.slice(0, 10) : [] })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

export default economy

function extractRecipesFromCatalog(data: unknown): RecipeRow[] {
  if (!data || typeof data !== 'object') return []
  const record = data as Record<string, unknown>
  const candidates = [
    record.items,
    record.recipes,
    record.entries,
    record.result && typeof record.result === 'object' ? (record.result as Record<string, unknown>).items : null,
    record.result && typeof record.result === 'object' ? (record.result as Record<string, unknown>).recipes : null,
  ]

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const recipes = candidate
      .map((entry, index) => toRecipeRow(entry, index))
      .filter((recipe): recipe is RecipeRow => Boolean(recipe))
    if (recipes.length > 0) return recipes
  }
  return []
}

function toRecipeRow(value: unknown, index: number): RecipeRow | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const recipeId = stringOrNull(record.recipe_id) ?? stringOrNull(record.id) ?? stringOrNull(record.name) ?? `recipe-${index}`
  const recipeName = stringOrNull(record.name) ?? recipeId
  const outputItemName = stringOrNull(record.output_item_name)
    ?? stringOrNull(record.item_name)
    ?? stringOrNull(record.output)
    ?? recipeName
  const outputQuantity = toFiniteNumber(record.output_quantity ?? record.quantity ?? 1) ?? 1
  const inputsRaw = record.inputs ?? record.ingredients ?? record.components
  if (!Array.isArray(inputsRaw)) return null

  const inputs = inputsRaw
    .map((input) => {
      if (!input || typeof input !== 'object') return null
      const row = input as Record<string, unknown>
      const itemName = stringOrNull(row.item_name) ?? stringOrNull(row.name) ?? stringOrNull(row.item_id)
      const quantity = toFiniteNumber(row.quantity ?? row.qty ?? row.amount)
      if (!itemName || quantity === null || quantity <= 0) return null
      return { item_name: itemName, quantity }
    })
    .filter((input): input is { item_name: string; quantity: number } => Boolean(input))

  if (inputs.length === 0) return null

  return {
    recipe_id: recipeId,
    recipe_name: recipeName,
    output_item_name: outputItemName,
    output_quantity: outputQuantity,
    inputs,
  }
}

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
