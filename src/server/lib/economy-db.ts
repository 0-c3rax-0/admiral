import { Database } from 'bun:sqlite'
import fs from 'fs'
import path from 'path'

const DB_DIR = path.join(process.cwd(), 'data')
const DB_PATH = path.join(DB_DIR, 'economy.db')
const ECONOMY_RETENTION_DAYS = 3

let db: Database | null = null

export interface TradeEventInput {
  profile_id: string
  trade_type: 'buy' | 'sell'
  item_id: string | null
  item_name: string
  quantity: number
  unit_price: number | null
  total_price: number | null
  system_name?: string | null
  poi_name?: string | null
  source_command?: string | null
  raw_json?: string | null
}

export interface MarketSnapshotInput {
  profile_id: string
  category: string
  system_name?: string | null
  poi_name?: string | null
  source?: string | null
  entries: MarketSnapshotEntryInput[]
}

export interface MarketSnapshotEntryInput {
  item_id: string | null
  item_name: string
  best_bid: number | null
  best_ask: number | null
  bid_volume: number | null
  ask_volume: number | null
}

export interface TradeEventRow {
  id: number
  profile_id: string
  trade_type: string
  item_id: string | null
  item_name: string
  quantity: number
  unit_price: number | null
  total_price: number | null
  system_name: string | null
  poi_name: string | null
  source_command: string | null
  occurred_at: string
}

export interface MarketSnapshotRow {
  id: number
  profile_id: string
  category: string
  system_name: string | null
  poi_name: string | null
  source: string | null
  captured_at: string
}

export interface MarketSnapshotEntryRow {
  snapshot_id: number
  item_id: string | null
  item_name: string
  best_bid: number | null
  best_ask: number | null
  bid_volume: number | null
  ask_volume: number | null
}

export interface KnownPriceRow {
  item_name: string
  item_id: string | null
  best_bid: number | null
  best_ask: number | null
  bid_volume: number | null
  ask_volume: number | null
  captured_at: string
  source: string
}

export interface RecipeInputRow {
  item_name: string
  quantity: number
}

export interface RecipeRow {
  recipe_id: string
  recipe_name: string
  output_item_name: string
  output_quantity: number
  inputs: RecipeInputRow[]
}

export interface RecipeEconomicsRow extends RecipeRow {
  estimated_input_cost: number | null
  last_known_output_bid: number | null
  estimated_revenue: number | null
  estimated_profit: number | null
}

export interface ItemTradeSummaryRow {
  item_name: string
  buy_quantity: number
  sell_quantity: number
  avg_buy_price: number | null
  avg_sell_price: number | null
  last_trade_at: string
}

export interface ProfileProfitHintRow {
  item_name: string
  avg_buy_price: number | null
  avg_sell_price: number | null
  last_known_bid: number | null
  last_known_ask: number | null
  profit_per_unit_if_sell_now: number | null
  realized_profit_per_unit: number | null
  traded_units: number
}

export function getEconomyDb(): Database {
  if (db) return db
  fs.mkdirSync(DB_DIR, { recursive: true })
  db = new Database(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      trade_type TEXT NOT NULL,
      item_id TEXT,
      item_name TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit_price REAL,
      total_price REAL,
      system_name TEXT,
      poi_name TEXT,
      source_command TEXT,
      raw_json TEXT,
      occurred_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_trade_events_profile_time ON trade_events(profile_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trade_events_item_time ON trade_events(item_name, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS market_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      category TEXT NOT NULL,
      system_name TEXT,
      poi_name TEXT,
      source TEXT,
      captured_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_market_snapshots_profile_time ON market_snapshots(profile_id, captured_at DESC);

    CREATE TABLE IF NOT EXISTS market_snapshot_entries (
      snapshot_id INTEGER NOT NULL,
      item_id TEXT,
      item_name TEXT NOT NULL,
      best_bid REAL,
      best_ask REAL,
      bid_volume REAL,
      ask_volume REAL,
      FOREIGN KEY (snapshot_id) REFERENCES market_snapshots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_market_snapshot_entries_snapshot ON market_snapshot_entries(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_market_snapshot_entries_item ON market_snapshot_entries(item_name);

    CREATE TABLE IF NOT EXISTS recipes (
      recipe_id TEXT PRIMARY KEY,
      recipe_name TEXT NOT NULL,
      output_item_name TEXT NOT NULL,
      output_quantity REAL NOT NULL DEFAULT 1,
      source_profile_id TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS recipe_inputs (
      recipe_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      quantity REAL NOT NULL,
      PRIMARY KEY (recipe_id, item_name),
      FOREIGN KEY (recipe_id) REFERENCES recipes(recipe_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_recipes_output_item ON recipes(output_item_name);
  `)
}

export function addTradeEvent(input: TradeEventInput): number {
  const result = getEconomyDb().query(
    `INSERT INTO trade_events (
      profile_id, trade_type, item_id, item_name, quantity, unit_price, total_price,
      system_name, poi_name, source_command, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.profile_id,
    input.trade_type,
    input.item_id ?? null,
    input.item_name,
    input.quantity,
    input.unit_price ?? null,
    input.total_price ?? null,
    input.system_name ?? null,
    input.poi_name ?? null,
    input.source_command ?? null,
    input.raw_json ?? null,
  )
  return Number(result.lastInsertRowid)
}

export function addMarketSnapshot(input: MarketSnapshotInput): number {
  const database = getEconomyDb()
  database.exec('BEGIN')
  try {
    const result = database.query(
      `INSERT INTO market_snapshots (profile_id, category, system_name, poi_name, source)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      input.profile_id,
      input.category,
      input.system_name ?? null,
      input.poi_name ?? null,
      input.source ?? null,
    )
    const snapshotId = Number(result.lastInsertRowid)
    const insertEntry = database.query(
      `INSERT INTO market_snapshot_entries (
        snapshot_id, item_id, item_name, best_bid, best_ask, bid_volume, ask_volume
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    for (const entry of input.entries) {
      insertEntry.run(
        snapshotId,
        entry.item_id ?? null,
        entry.item_name,
        entry.best_bid ?? null,
        entry.best_ask ?? null,
        entry.bid_volume ?? null,
        entry.ask_volume ?? null,
      )
    }
    database.exec('COMMIT')
    return snapshotId
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
}

export function listTradeEvents(profileId: string, limit: number = 100): TradeEventRow[] {
  return getEconomyDb().query(
    `SELECT id, profile_id, trade_type, item_id, item_name, quantity, unit_price, total_price,
            system_name, poi_name, source_command, occurred_at
     FROM trade_events
     WHERE profile_id = ?
     ORDER BY occurred_at DESC, id DESC
     LIMIT ?`
  ).all(profileId, limit) as TradeEventRow[]
}

export function getLatestMarketSnapshot(profileId: string, category: string): { snapshot: MarketSnapshotRow; entries: MarketSnapshotEntryRow[] } | null {
  const snapshot = getEconomyDb().query(
    `SELECT id, profile_id, category, system_name, poi_name, source, captured_at
     FROM market_snapshots
     WHERE profile_id = ? AND category = ?
     ORDER BY captured_at DESC, id DESC
     LIMIT 1`
  ).get(profileId, category) as MarketSnapshotRow | null
  if (!snapshot) return null
  const entries = getEconomyDb().query(
    `SELECT snapshot_id, item_id, item_name, best_bid, best_ask, bid_volume, ask_volume
     FROM market_snapshot_entries
     WHERE snapshot_id = ?
     ORDER BY item_name ASC`
  ).all(snapshot.id) as MarketSnapshotEntryRow[]
  return { snapshot, entries }
}

export function getKnownPrice(itemName: string, profileId?: string): KnownPriceRow | null {
  const trimmed = itemName.trim()
  if (!trimmed) return null

  const marketScoped = profileId
    ? getEconomyDb().query(
      `SELECT item_name, item_id, best_bid, best_ask, bid_volume, ask_volume, captured_at, 'market_snapshot' AS source
       FROM market_snapshot_entries mse
       JOIN market_snapshots ms ON ms.id = mse.snapshot_id
       WHERE ms.profile_id = ? AND lower(mse.item_name) = lower(?)
       ORDER BY ms.captured_at DESC, ms.id DESC
       LIMIT 1`
    ).get(profileId, trimmed) as KnownPriceRow | null
    : null
  if (marketScoped) return marketScoped

  const globalMarket = getEconomyDb().query(
    `SELECT item_name, item_id, best_bid, best_ask, bid_volume, ask_volume, captured_at, 'market_snapshot' AS source
     FROM market_snapshot_entries mse
     JOIN market_snapshots ms ON ms.id = mse.snapshot_id
     WHERE lower(mse.item_name) = lower(?)
     ORDER BY ms.captured_at DESC, ms.id DESC
     LIMIT 1`
  ).get(trimmed) as KnownPriceRow | null
  if (globalMarket) return globalMarket

  return getEconomyDb().query(
    `SELECT item_name, item_id, unit_price AS best_bid, unit_price AS best_ask, NULL AS bid_volume, NULL AS ask_volume,
            occurred_at AS captured_at, 'trade_event' AS source
     FROM trade_events
     WHERE lower(item_name) = lower(?) AND unit_price IS NOT NULL
     ORDER BY occurred_at DESC, id DESC
     LIMIT 1`
  ).get(trimmed) as KnownPriceRow | null
}

export function listRecentTradesAllProfiles(limit: number = 200): TradeEventRow[] {
  return getEconomyDb().query(
    `SELECT id, profile_id, trade_type, item_id, item_name, quantity, unit_price, total_price,
            system_name, poi_name, source_command, occurred_at
     FROM trade_events
     ORDER BY occurred_at DESC, id DESC
     LIMIT ?`
  ).all(limit) as TradeEventRow[]
}

export function listItemTradeSummaries(limit: number = 50): ItemTradeSummaryRow[] {
  return getEconomyDb().query(
    `SELECT
       item_name,
       SUM(CASE WHEN trade_type = 'buy' THEN quantity ELSE 0 END) AS buy_quantity,
       SUM(CASE WHEN trade_type = 'sell' THEN quantity ELSE 0 END) AS sell_quantity,
       CASE
         WHEN SUM(CASE WHEN trade_type = 'buy' AND unit_price IS NOT NULL THEN quantity ELSE 0 END) > 0
         THEN SUM(CASE WHEN trade_type = 'buy' AND unit_price IS NOT NULL THEN quantity * unit_price ELSE 0 END)
              / SUM(CASE WHEN trade_type = 'buy' AND unit_price IS NOT NULL THEN quantity ELSE 0 END)
         ELSE NULL
       END AS avg_buy_price,
       CASE
         WHEN SUM(CASE WHEN trade_type = 'sell' AND unit_price IS NOT NULL THEN quantity ELSE 0 END) > 0
         THEN SUM(CASE WHEN trade_type = 'sell' AND unit_price IS NOT NULL THEN quantity * unit_price ELSE 0 END)
              / SUM(CASE WHEN trade_type = 'sell' AND unit_price IS NOT NULL THEN quantity ELSE 0 END)
         ELSE NULL
       END AS avg_sell_price,
       MAX(occurred_at) AS last_trade_at
     FROM trade_events
     GROUP BY lower(item_name), item_name
     ORDER BY last_trade_at DESC
     LIMIT ?`
  ).all(limit) as ItemTradeSummaryRow[]
}

export function listProfileProfitHints(profileId: string, limit: number = 25): ProfileProfitHintRow[] {
  return getEconomyDb().query(
    `WITH trade_rollup AS (
       SELECT
         item_name,
         SUM(quantity) AS traded_units,
         CASE
           WHEN SUM(CASE WHEN trade_type = 'buy' AND unit_price IS NOT NULL THEN quantity ELSE 0 END) > 0
           THEN SUM(CASE WHEN trade_type = 'buy' AND unit_price IS NOT NULL THEN quantity * unit_price ELSE 0 END)
                / SUM(CASE WHEN trade_type = 'buy' AND unit_price IS NOT NULL THEN quantity ELSE 0 END)
           ELSE NULL
         END AS avg_buy_price,
         CASE
           WHEN SUM(CASE WHEN trade_type = 'sell' AND unit_price IS NOT NULL THEN quantity ELSE 0 END) > 0
           THEN SUM(CASE WHEN trade_type = 'sell' AND unit_price IS NOT NULL THEN quantity * unit_price ELSE 0 END)
                / SUM(CASE WHEN trade_type = 'sell' AND unit_price IS NOT NULL THEN quantity ELSE 0 END)
           ELSE NULL
         END AS avg_sell_price
       FROM trade_events
       WHERE profile_id = ?
       GROUP BY lower(item_name), item_name
     ),
     latest_market AS (
       SELECT mse.item_name, mse.best_bid, mse.best_ask
       FROM market_snapshot_entries mse
       JOIN market_snapshots ms ON ms.id = mse.snapshot_id
       WHERE ms.profile_id = ?
         AND ms.id IN (
           SELECT MAX(id)
           FROM market_snapshots ms2
           WHERE ms2.profile_id = ms.profile_id
           GROUP BY ms2.category
         )
     )
     SELECT
       tr.item_name,
       tr.avg_buy_price,
       tr.avg_sell_price,
       lm.best_bid AS last_known_bid,
       lm.best_ask AS last_known_ask,
       CASE
         WHEN tr.avg_buy_price IS NOT NULL AND lm.best_bid IS NOT NULL THEN lm.best_bid - tr.avg_buy_price
         ELSE NULL
       END AS profit_per_unit_if_sell_now,
       CASE
         WHEN tr.avg_buy_price IS NOT NULL AND tr.avg_sell_price IS NOT NULL THEN tr.avg_sell_price - tr.avg_buy_price
         ELSE NULL
       END AS realized_profit_per_unit,
       tr.traded_units
     FROM trade_rollup tr
     LEFT JOIN latest_market lm ON lower(lm.item_name) = lower(tr.item_name)
     ORDER BY COALESCE(profit_per_unit_if_sell_now, realized_profit_per_unit, -999999) DESC, tr.traded_units DESC
     LIMIT ?`
  ).all(profileId, profileId, limit) as ProfileProfitHintRow[]
}

export function upsertRecipes(recipes: RecipeRow[], sourceProfileId?: string): number {
  if (recipes.length === 0) return 0
  const database = getEconomyDb()
  database.exec('BEGIN')
  try {
    const upsertRecipe = database.query(
      `INSERT INTO recipes (recipe_id, recipe_name, output_item_name, output_quantity, source_profile_id, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(recipe_id) DO UPDATE SET
         recipe_name = excluded.recipe_name,
         output_item_name = excluded.output_item_name,
         output_quantity = excluded.output_quantity,
         source_profile_id = excluded.source_profile_id,
         updated_at = datetime('now')`
    )
    const deleteInputs = database.query('DELETE FROM recipe_inputs WHERE recipe_id = ?')
    const deleteMissingRecipes = sourceProfileId
      ? database.query(
        `DELETE FROM recipes
         WHERE source_profile_id = ?
           AND recipe_id NOT IN (${recipes.map(() => '?').join(', ')})`
      )
      : null
    const insertInput = database.query(
      `INSERT INTO recipe_inputs (recipe_id, item_name, quantity) VALUES (?, ?, ?)`
    )
    for (const recipe of recipes) {
      upsertRecipe.run(
        recipe.recipe_id,
        recipe.recipe_name,
        recipe.output_item_name,
        recipe.output_quantity,
        sourceProfileId ?? null,
      )
      deleteInputs.run(recipe.recipe_id)
      for (const input of recipe.inputs) {
        insertInput.run(recipe.recipe_id, input.item_name, input.quantity)
      }
    }
    if (deleteMissingRecipes && sourceProfileId) {
      deleteMissingRecipes.run(sourceProfileId, ...recipes.map((recipe) => recipe.recipe_id))
    }
    database.exec('COMMIT')
    return recipes.length
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
}

export function listRecipes(limit: number = 100): RecipeRow[] {
  const recipes = getEconomyDb().query(
    `SELECT recipe_id, recipe_name, output_item_name, output_quantity
     FROM recipes
     ORDER BY recipe_name ASC
     LIMIT ?`
  ).all(limit) as Array<{
    recipe_id: string
    recipe_name: string
    output_item_name: string
    output_quantity: number
  }>

  const loadInputs = getEconomyDb().query(
    `SELECT item_name, quantity
     FROM recipe_inputs
     WHERE recipe_id = ?
     ORDER BY item_name ASC`
  )

  return recipes.map((recipe) => ({
    ...recipe,
    inputs: loadInputs.all(recipe.recipe_id) as RecipeInputRow[],
  }))
}

export function listRecipeEconomics(limit: number = 50): RecipeEconomicsRow[] {
  const recipes = listRecipes(limit)
  return recipes.map((recipe) => {
    const inputCost = recipe.inputs.reduce<number | null>((sum, input) => {
      const price = getKnownPrice(input.item_name)
      const unitCost = price?.best_ask ?? price?.best_bid ?? null
      if (unitCost === null) return sum
      return (sum ?? 0) + unitCost * input.quantity
    }, 0)
    const outputPrice = getKnownPrice(recipe.output_item_name)
    const outputBid = outputPrice?.best_bid ?? outputPrice?.best_ask ?? null
    const revenue = outputBid !== null ? outputBid * recipe.output_quantity : null
    const profit = revenue !== null && inputCost !== null ? revenue - inputCost : null
    return {
      ...recipe,
      estimated_input_cost: inputCost,
      last_known_output_bid: outputBid,
      estimated_revenue: revenue,
      estimated_profit: profit,
    }
  }).sort((a, b) => (b.estimated_profit ?? -Infinity) - (a.estimated_profit ?? -Infinity))
}

export function pruneEconomyRows(): void {
  const database = getEconomyDb()
  const cutoffModifier = `-${ECONOMY_RETENTION_DAYS} days`

  database.query(
    `DELETE FROM trade_events
     WHERE occurred_at < datetime('now', ?)`
  ).run(cutoffModifier)

  database.query(
    `DELETE FROM market_snapshots
     WHERE captured_at < datetime('now', ?)`
  ).run(cutoffModifier)
}
