import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Coins, RefreshCw, X } from 'lucide-react'
import type { Profile } from '@/types'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Input } from '@/components/ui/input'

type OverviewTrade = {
  id: number
  profile_id: string
  profile_name: string
  trade_type: string
  item_name: string
  quantity: number
  unit_price: number | null
  total_price: number | null
  occurred_at: string
}

type ItemSummary = {
  item_name: string
  buy_quantity: number
  sell_quantity: number
  avg_buy_price: number | null
  avg_sell_price: number | null
  last_trade_at: string
}

type ProfitHint = {
  item_name: string
  avg_buy_price: number | null
  avg_sell_price: number | null
  last_known_bid: number | null
  last_known_ask: number | null
  profit_per_unit_if_sell_now: number | null
  realized_profit_per_unit: number | null
  traded_units: number
}

type RecipeEconomics = {
  recipe_id: string
  recipe_name: string
  output_item_name: string
  output_quantity: number
  inputs: Array<{ item_name: string; quantity: number }>
  estimated_input_cost: number | null
  last_known_output_bid: number | null
  estimated_revenue: number | null
  estimated_profit: number | null
}

type LiveMarketTrade = {
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
  order_type: string
}

const MARKET_CATEGORIES = [
  { id: 'ore', label: 'Ore' },
  { id: 'ice', label: 'Ice' },
  { id: 'gas', label: 'Gas' },
]

const MARKET_STATIONS = [
  { id: 'nova_terra_central', label: 'Nova Terra Central' },
  { id: 'central_nexus', label: 'Central Nexus' },
  { id: 'grand_exchange_station', label: 'Grand Exchange Station' },
  { id: 'confederacy_central_command', label: 'Confederacy Central Command' },
  { id: 'crimson_war_citadel', label: 'Crimson War Citadel' },
  { id: 'node_beta_industrial_station', label: 'Node Beta Industrial Station' },
]

interface Props {
  open: boolean
  onClose: () => void
  profiles: Profile[]
  activeProfileId: string | null
}

export function EconomyOverviewModal({ open, onClose, profiles, activeProfileId }: Props) {
  const [loading, setLoading] = useState(false)
  const [importingRecipes, setImportingRecipes] = useState(false)
  const [overview, setOverview] = useState<{ recent_trades: OverviewTrade[]; item_summaries: ItemSummary[] } | null>(null)
  const [profitHints, setProfitHints] = useState<ProfitHint[]>([])
  const [recipeEconomics, setRecipeEconomics] = useState<RecipeEconomics[]>([])
  const [expandedProfiles, setExpandedProfiles] = useState<Record<string, boolean>>({})
  const [selectedCategory, setSelectedCategory] = useState('ore')
  const [selectedStation, setSelectedStation] = useState('nova_terra_central')
  const [liveTrades, setLiveTrades] = useState<LiveMarketTrade[]>([])
  const [recipeFilter, setRecipeFilter] = useState('')
  const selectedProfileId = activeProfileId || profiles[0]?.id || ''

  async function loadData(profileId: string, stationId = selectedStation, category = selectedCategory) {
    setLoading(true)
    try {
      const [overviewResp, hintsResp, recipesResp, liveTradesResp] = await Promise.all([
        fetch('/api/economy/overview?trade_limit=120&item_limit=40'),
        profileId ? fetch(`/api/economy/profiles/${profileId}/profit-hints?limit=20`) : Promise.resolve(null),
        fetch('/api/economy/recipes?limit=1000'),
        fetch(`/api/economy/market/fills?station_id=${encodeURIComponent(stationId)}&category=${encodeURIComponent(category)}&limit=100`),
      ])

      if (overviewResp.ok) {
        const data = await overviewResp.json()
        setOverview(data)
      } else {
        setOverview({ recent_trades: [], item_summaries: [] })
      }

      if (hintsResp && hintsResp.ok) {
        const data = await hintsResp.json()
        setProfitHints(Array.isArray(data.hints) ? data.hints : [])
      } else {
        setProfitHints([])
      }

      if (recipesResp.ok) {
        const data = await recipesResp.json()
        setRecipeEconomics(Array.isArray(data.economics) ? data.economics : [])
      } else {
        setRecipeEconomics([])
      }

      if (liveTradesResp.ok) {
        const data = await liveTradesResp.json()
        setLiveTrades(Array.isArray(data.fills) ? data.fills : [])
      } else {
        setLiveTrades([])
      }
    } catch {
      setOverview({ recent_trades: [], item_summaries: [] })
      setProfitHints([])
      setRecipeEconomics([])
      setLiveTrades([])
    } finally {
      setLoading(false)
    }
  }

  async function importRecipes() {
    if (!selectedProfileId) return
    setImportingRecipes(true)
    try {
      await fetch(`/api/economy/profiles/${selectedProfileId}/recipes/import`, { method: 'POST' })
      await loadData(selectedProfileId)
    } finally {
      setImportingRecipes(false)
    }
  }

  useEffect(() => {
    if (!open) return
    loadData(selectedProfileId, selectedStation, selectedCategory)
  }, [open, selectedProfileId, selectedStation, selectedCategory])

  const selectedProfileName = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId)?.name || 'Account',
    [profiles, selectedProfileId]
  )
  const tradesByProfile = useMemo(() => {
    const groups = new Map<string, { profileId: string; profileName: string; trades: OverviewTrade[] }>()
    for (const trade of overview?.recent_trades || []) {
      const key = trade.profile_id
      if (!groups.has(key)) {
        groups.set(key, { profileId: trade.profile_id, profileName: trade.profile_name, trades: [] })
      }
      groups.get(key)!.trades.push(trade)
    }
    return [...groups.values()]
  }, [overview])

  const filteredRecipes = useMemo(() => {
    const needle = recipeFilter.trim().toLowerCase()
    if (!needle) return recipeEconomics
    return recipeEconomics.filter((r) =>
      r.recipe_name.toLowerCase().includes(needle) ||
      r.output_item_name.toLowerCase().includes(needle) ||
      r.inputs.some((i) => i.item_name.toLowerCase().includes(needle))
    )
  }, [recipeEconomics, recipeFilter])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm p-3 sm:p-6" onClick={onClose}>
      <div className="flex min-h-full items-center justify-center">
        <div className="w-full max-w-7xl max-h-[calc(100vh-1.5rem)] sm:max-h-[calc(100vh-3rem)] overflow-hidden border border-border bg-card shadow-lg" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <div className="flex items-center gap-2">
              <Coins size={14} className="text-primary" />
              <span className="font-jetbrains text-xs font-semibold tracking-[1.5px] text-primary uppercase">Economy Overview</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => loadData(selectedProfileId, selectedStation, selectedCategory)} disabled={loading} className="gap-1.5">
                <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                Reload
              </Button>
              <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="max-h-[calc(100vh-5rem)] overflow-y-auto sm:max-h-[calc(100vh-6.5rem)] p-4 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <section className="border border-border bg-background/30">
              <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-[1.2px] text-muted-foreground">Recent Trades by Account</span>
                <span className="text-[10px] text-muted-foreground">{tradesByProfile.length} Accounts</span>
              </div>
              <div>
                {tradesByProfile.map((group) => {
                  const isOpen = expandedProfiles[group.profileId] ?? false
                  return (
                    <div key={group.profileId} className="border-b border-border/50 last:border-b-0">
                      <button
                        onClick={() => setExpandedProfiles((prev) => ({ ...prev, [group.profileId]: !isOpen }))}
                        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-background/40 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          {isOpen ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
                          <span className="text-sm text-foreground">{group.profileName}</span>
                        </div>
                        <span className="text-[10px] uppercase tracking-[1.2px] text-muted-foreground">{group.trades.length} Trades</span>
                      </button>
                      {isOpen && (
                        <div className="overflow-auto">
                          <table className="w-full text-xs">
                            <thead className="bg-card/70">
                              <tr className="border-b border-border text-muted-foreground uppercase tracking-[1.2px]">
                                <th className="text-left px-4 py-2 font-medium">Zeit</th>
                                <th className="text-left px-4 py-2 font-medium">Typ</th>
                                <th className="text-left px-4 py-2 font-medium">Item</th>
                                <th className="text-right px-4 py-2 font-medium">Menge</th>
                                <th className="text-right px-4 py-2 font-medium">Preis</th>
                                <th className="text-right px-4 py-2 font-medium">Total</th>
                              </tr>
                            </thead>
                            <tbody>
                              {group.trades.map((trade) => (
                                <tr key={trade.id} className="border-b border-border/50 last:border-b-0">
                                  <td className="px-4 py-2 text-muted-foreground">{formatDateTime(trade.occurred_at)}</td>
                                  <td className={`px-4 py-2 uppercase ${trade.trade_type === 'sell' ? 'text-[hsl(var(--smui-green))]' : 'text-[hsl(var(--smui-frost-2))]'}`}>{trade.trade_type}</td>
                                  <td className="px-4 py-2">{trade.item_name}</td>
                                  <td className="px-4 py-2 text-right tabular-nums">{formatNumber(trade.quantity)}</td>
                                  <td className="px-4 py-2 text-right tabular-nums">{formatNumber(trade.unit_price)}</td>
                                  <td className="px-4 py-2 text-right tabular-nums">{formatNumber(trade.total_price)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>

            <div className="space-y-4">
              <section className="border border-border bg-background/30">
                <div className="px-4 py-2.5 border-b border-border flex flex-wrap items-center justify-between gap-3">
                  <span className="text-[11px] uppercase tracking-[1.2px] text-muted-foreground">Live Station Trades</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-1">
                      {MARKET_CATEGORIES.map((item) => (
                        <Button
                          key={item.id}
                          variant="outline"
                          size="sm"
                          onClick={() => setSelectedCategory(item.id)}
                          className={selectedCategory === item.id ? 'border-primary/50 text-primary bg-primary/10' : 'text-muted-foreground'}
                        >
                          {item.label}
                        </Button>
                      ))}
                    </div>
                    <Select
                      value={selectedStation}
                      onChange={(e) => setSelectedStation(e.target.value)}
                      className="h-8 w-full min-w-[220px] text-xs"
                    >
                      {MARKET_STATIONS.map((station) => (
                        <option key={station.id} value={station.id}>
                          {station.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <div className="overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-card/70">
                      <tr className="border-b border-border text-muted-foreground uppercase tracking-[1.2px]">
                        <th className="text-left px-4 py-2 font-medium">Zeit</th>
                        <th className="text-left px-4 py-2 font-medium">Item</th>
                        <th className="text-right px-4 py-2 font-medium">Menge</th>
                        <th className="text-right px-4 py-2 font-medium">Preis</th>
                        <th className="text-right px-4 py-2 font-medium">Total</th>
                        <th className="text-left px-4 py-2 font-medium">Kaeufer</th>
                        <th className="text-left px-4 py-2 font-medium">Verkaeufer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {liveTrades.map((trade) => (
                        <tr key={trade.id} className="border-b border-border/50 last:border-b-0">
                          <td className="px-4 py-2 text-muted-foreground">{formatDateTime(trade.timestamp)}</td>
                          <td className="px-4 py-2">{trade.item_name}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatNumber(trade.quantity)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatNumber(trade.price_each)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatNumber(trade.total)}</td>
                          <td className="px-4 py-2 text-muted-foreground">{trade.buyer_name}</td>
                          <td className="px-4 py-2 text-muted-foreground">{trade.seller_name}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {liveTrades.length === 0 && (
                    <div className="px-4 py-4 text-sm text-muted-foreground">
                      Keine Live-Trades fuer diese Station und Kategorie gefunden.
                    </div>
                  )}
                </div>
              </section>

              <section className="border border-border bg-background/30">
                <div className="px-4 py-2.5 border-b border-border">
                  <span className="text-[11px] uppercase tracking-[1.2px] text-muted-foreground">Trade Profitability for {selectedProfileName}</span>
                </div>
                <div className="overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-card/70">
                      <tr className="border-b border-border text-muted-foreground uppercase tracking-[1.2px]">
                        <th className="text-left px-4 py-2 font-medium">Item</th>
                        <th className="text-right px-4 py-2 font-medium">Avg Buy</th>
                        <th className="text-right px-4 py-2 font-medium">Sell Now</th>
                        <th className="text-right px-4 py-2 font-medium">Realized</th>
                        <th className="text-right px-4 py-2 font-medium">Units</th>
                      </tr>
                    </thead>
                    <tbody>
                      {profitHints.map((hint) => (
                        <tr key={hint.item_name} className="border-b border-border/50">
                          <td className="px-4 py-2">{hint.item_name}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatNumber(hint.avg_buy_price)}</td>
                          <td className={`px-4 py-2 text-right tabular-nums ${hint.profit_per_unit_if_sell_now !== null && hint.profit_per_unit_if_sell_now >= 0 ? 'text-[hsl(var(--smui-green))]' : 'text-[hsl(var(--smui-red))]'}`}>{formatSigned(hint.profit_per_unit_if_sell_now)}</td>
                          <td className={`px-4 py-2 text-right tabular-nums ${hint.realized_profit_per_unit !== null && hint.realized_profit_per_unit >= 0 ? 'text-[hsl(var(--smui-green))]' : 'text-[hsl(var(--smui-red))]'}`}>{formatSigned(hint.realized_profit_per_unit)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatNumber(hint.traded_units)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {profitHints.length === 0 && (
                    <div className="px-4 py-4 text-sm text-muted-foreground">Noch keine Profit-Hinweise verfuegbar. Es werden zuerst Trades und Markt-Snapshots benoetigt.</div>
                  )}
                </div>
              </section>

              <section className="border border-border bg-background/30">
                <div className="px-4 py-2.5 border-b border-border flex flex-wrap items-center justify-between gap-3">
                  <span className="text-[11px] uppercase tracking-[1.2px] text-muted-foreground">Crafting Economics</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={recipeFilter}
                      onChange={(e) => setRecipeFilter(e.target.value)}
                      placeholder="Rezepte filtern..."
                      className="h-8 w-full max-w-[180px] text-xs"
                    />
                    <Button variant="outline" size="sm" onClick={importRecipes} disabled={importingRecipes || !selectedProfileId} className="gap-1.5">
                      <RefreshCw size={12} className={importingRecipes ? 'animate-spin' : ''} />
                      Import Recipes
                    </Button>
                  </div>
                </div>
                <div className="overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-card/70">
                      <tr className="border-b border-border text-muted-foreground uppercase tracking-[1.2px]">
                        <th className="text-left px-4 py-2 font-medium">Recipe</th>
                        <th className="text-left px-4 py-2 font-medium">Inputs</th>
                        <th className="text-right px-4 py-2 font-medium">Input Cost</th>
                        <th className="text-right px-4 py-2 font-medium">Revenue</th>
                        <th className="text-right px-4 py-2 font-medium">Profit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRecipes.map((recipe) => (
                        <tr key={recipe.recipe_id} className="border-b border-border/50">
                          <td className="px-4 py-2">
                            <div>{recipe.recipe_name}</div>
                            <div className="text-[10px] text-muted-foreground">{recipe.output_item_name} x{recipe.output_quantity}</div>
                          </td>
                          <td className="px-4 py-2 text-[11px] text-muted-foreground">
                            {recipe.inputs.map((input) => `${input.item_name} x${input.quantity}`).join(', ')}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatNumber(recipe.estimated_input_cost)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatNumber(recipe.estimated_revenue)}</td>
                          <td className={`px-4 py-2 text-right tabular-nums ${recipe.estimated_profit !== null && recipe.estimated_profit >= 0 ? 'text-[hsl(var(--smui-green))]' : 'text-[hsl(var(--smui-red))]'}`}>{formatSigned(recipe.estimated_profit)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="px-4 py-3 text-[11px] text-muted-foreground border-t border-border">
                    Import zieht Rezeptdaten aus dem ausgewaehlten verbundenen Account. Profit ist aktuell eine einfache Schaetzung aus bekannten Input-Kosten und letztem bekannten Output-Preis.
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function formatNumber(value: number | null): string {
  return value === null ? '-' : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatSigned(value: number | null): string {
  if (value === null) return '-'
  const formatted = value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  return value > 0 ? `+${formatted}` : formatted
}

function formatDateTime(value: string): string {
  const parsed = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  if (!Number.isFinite(parsed)) return value
  return new Date(parsed).toLocaleString()
}
