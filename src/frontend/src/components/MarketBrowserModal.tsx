import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Store, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

type StoredMarketEntry = {
  item_name: string
  best_bid: number | null
  best_ask: number | null
  bid_volume: number | null
  ask_volume: number | null
}

type TradeEvent = {
  id: number
  trade_type: string
  item_name: string
  quantity: number
  unit_price: number | null
  total_price: number | null
  occurred_at: string
  system_name: string | null
  poi_name: string | null
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

type MarketHint = {
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
  connected: boolean
  profileId: string
  onClose: () => void
}

export function MarketBrowserModal({ open, connected, profileId, onClose }: Props) {
  const [category, setCategory] = useState('ore')
  const [filter, setFilter] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [storedEntries, setStoredEntries] = useState<StoredMarketEntry[]>([])
  const [storedAt, setStoredAt] = useState<string | null>(null)
  const [recentTrades, setRecentTrades] = useState<TradeEvent[]>([])
  const [selectedStation, setSelectedStation] = useState('nova_terra_central')
  const [liveTrades, setLiveTrades] = useState<LiveMarketTrade[]>([])
  const [marketHints, setMarketHints] = useState<MarketHint[]>([])
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [tradesOpen, setTradesOpen] = useState(false)
  const [liveTradesOpen, setLiveTradesOpen] = useState(true)
  const [hintsOpen, setHintsOpen] = useState(true)

  async function loadHistory(nextCategory: string, nextStation: string) {
    setHistoryLoading(true)
    try {
      const [snapshotResp, tradesResp, liveTradesResp, marketHintsResp] = await Promise.all([
        fetch(`/api/economy/profiles/${profileId}/market/latest?category=${encodeURIComponent(nextCategory)}`),
        fetch(`/api/economy/profiles/${profileId}/trades?limit=20`),
        fetch(`/api/economy/market/fills?station_id=${encodeURIComponent(nextStation)}&category=${encodeURIComponent(nextCategory)}&limit=100`),
        fetch(`/api/economy/market/hints?station_id=${encodeURIComponent(nextStation)}&category=${encodeURIComponent(nextCategory)}`),
      ])

      if (snapshotResp.ok) {
        const snapshotData = await snapshotResp.json()
        setStoredEntries(Array.isArray(snapshotData.entries) ? snapshotData.entries : [])
        setStoredAt(typeof snapshotData.snapshot?.captured_at === 'string' ? snapshotData.snapshot.captured_at : null)
      } else {
        setStoredEntries([])
        setStoredAt(null)
      }

      if (tradesResp.ok) {
        const tradeData = await tradesResp.json()
        setRecentTrades(Array.isArray(tradeData.trades) ? tradeData.trades : [])
      } else {
        setRecentTrades([])
      }

      if (liveTradesResp.ok) {
        const liveTradeData = await liveTradesResp.json()
        setLiveTrades(Array.isArray(liveTradeData.fills) ? liveTradeData.fills : [])
      } else {
        setLiveTrades([])
      }

      if (marketHintsResp.ok) {
        const hintData = await marketHintsResp.json()
        setMarketHints(Array.isArray(hintData.hints) ? hintData.hints : [])
      } else {
        setMarketHints([])
      }
    } catch {
      setStoredEntries([])
      setStoredAt(null)
      setRecentTrades([])
      setLiveTrades([])
      setMarketHints([])
    } finally {
      setHistoryLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    loadHistory(category, selectedStation)
  }, [open, category, selectedStation])

  const filteredStoredEntries = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const sorted = [...storedEntries].sort((a, b) => {
      if (a.best_ask !== null && b.best_ask !== null) return a.best_ask - b.best_ask
      if (a.best_ask !== null) return -1
      if (b.best_ask !== null) return 1
      return a.item_name.localeCompare(b.item_name)
    })
    if (!needle) return sorted
    return sorted.filter((entry) => entry.item_name.toLowerCase().includes(needle))
  }, [storedEntries, filter])

  const filteredMarketHints = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return marketHints
    return marketHints.filter((hint) => hint.item_name.toLowerCase().includes(needle))
  }, [marketHints, filter])


  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4" onClick={onClose}>
      <div className="bg-card border border-border shadow-lg w-full max-w-5xl max-h-[85vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Store size={14} className="text-primary" />
            <span className="font-jetbrains text-xs font-semibold tracking-[1.5px] text-primary uppercase">Market Browser</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X size={14} />
          </button>
        </div>

        <div className="p-4 border-b border-border bg-background/40">
          <div className="flex flex-wrap items-center gap-2">
            {MARKET_CATEGORIES.map((item) => (
              <Button
                key={item.id}
                variant="outline"
                size="sm"
                onClick={() => setCategory(item.id)}
                className={category === item.id ? 'border-primary/50 text-primary bg-primary/10' : 'text-muted-foreground'}
              >
                {item.label}
              </Button>
            ))}
            <div className="flex-1 min-w-[220px]" />
            <Select
              value={selectedStation}
              onChange={(e) => setSelectedStation(e.target.value)}
              className="h-8 w-full max-w-xs text-xs"
            >
              {MARKET_STATIONS.map((station) => (
                <option key={station.id} value={station.id}>
                  {station.label}
                </option>
              ))}
            </Select>
            <Input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Item filtern..."
              className="h-8 w-full max-w-xs text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                loadHistory(category, selectedStation)
              }}
              disabled={historyLoading || !connected}
              className="gap-1.5"
            >
              {historyLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Neu laden
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            Zeigt gespeicherte Profil-Daten aus der Economy-DB plus die letzten 100 Live-Trades fuer die gewaehlte Station und Kategorie.
          </p>
        </div>

        <div className="overflow-auto max-h-[calc(85vh-125px)]">
          <section className="border-b border-border">
            <button
              onClick={() => setHintsOpen((value) => !value)}
              className="w-full px-4 py-2.5 bg-background/30 flex items-center justify-between hover:bg-background/40 transition-colors"
            >
              <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[1.2px] text-muted-foreground">
                {hintsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                Price Hints
              </span>
              <span className="text-[10px] text-muted-foreground">{filteredMarketHints.length} Items</span>
            </button>
            {hintsOpen && !historyLoading && filteredMarketHints.length === 0 && (
              <div className="px-4 py-4 text-sm text-muted-foreground">
                Keine Preis-Hints fuer diese Station und Kategorie verfuegbar.
              </div>
            )}
            {hintsOpen && filteredMarketHints.length > 0 && (
              <table className="w-full text-xs">
                <thead className="bg-card/70">
                  <tr className="border-b border-border text-muted-foreground uppercase tracking-[1.2px]">
                    <th className="text-left px-4 py-2 font-medium">Item</th>
                    <th className="text-right px-4 py-2 font-medium">Sofort</th>
                    <th className="text-right px-4 py-2 font-medium">Median</th>
                    <th className="text-right px-4 py-2 font-medium">Range</th>
                    <th className="text-right px-4 py-2 font-medium">Ask</th>
                    <th className="text-right px-4 py-2 font-medium">Trades</th>
                    <th className="text-left px-4 py-2 font-medium">Empfehlung</th>
                    <th className="text-left px-4 py-2 font-medium">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMarketHints.map((hint) => (
                    <tr key={hint.item_id} className="border-b border-border/50">
                      <td className="px-4 py-2">{hint.item_name}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-[hsl(var(--smui-green))]">{formatNumber(hint.instant_sell_price)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{formatNumber(hint.recent_fill_median)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{formatRange(hint.recent_fill_low, hint.recent_fill_high)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-[hsl(var(--smui-orange))]">{formatNumber(hint.best_ask)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{hint.recent_trade_count.toLocaleString()}</td>
                      <td className="px-4 py-2">{formatRecommendation(hint.recommendation)}</td>
                      <td className="px-4 py-2">{formatConfidence(hint.confidence)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="border-b border-border">
            <button
              onClick={() => setLiveTradesOpen((value) => !value)}
              className="w-full px-4 py-2.5 bg-background/30 flex items-center justify-between hover:bg-background/40 transition-colors"
            >
              <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[1.2px] text-muted-foreground">
                {liveTradesOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                Live Station Trades
              </span>
              <span className="text-[10px] text-muted-foreground">{liveTrades.length} Eintraege</span>
            </button>
            {liveTradesOpen && !historyLoading && liveTrades.length === 0 && (
              <div className="px-4 py-4 text-sm text-muted-foreground">
                Keine Live-Trades fuer diese Station und Kategorie gefunden.
              </div>
            )}
            {liveTradesOpen && liveTrades.length > 0 && (
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
                    <tr key={trade.id} className="border-b border-border/50">
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
            )}
          </section>

          <section className="border-b border-border">
            <button
              onClick={() => setSnapshotOpen((value) => !value)}
              className="w-full px-4 py-2.5 bg-background/30 flex items-center justify-between hover:bg-background/40 transition-colors"
            >
              <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[1.2px] text-muted-foreground">
                {snapshotOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                Stored Market Snapshot
              </span>
              <span className="text-[10px] text-muted-foreground">
                {storedAt ? formatDateTime(storedAt) : historyLoading ? 'laedt...' : 'keine Daten'}
              </span>
            </button>
            {snapshotOpen && !historyLoading && filteredStoredEntries.length === 0 && (
              <div className="px-4 py-4 text-sm text-muted-foreground">
                Kein gespeicherter Snapshot fuer diese Kategorie vorhanden.
              </div>
            )}
            {snapshotOpen && filteredStoredEntries.length > 0 && (
              <table className="w-full text-xs">
                <thead className="bg-card/70">
                  <tr className="border-b border-border text-muted-foreground uppercase tracking-[1.2px]">
                    <th className="text-left px-4 py-2 font-medium">Item</th>
                    <th className="text-right px-4 py-2 font-medium">Preis</th>
                    <th className="text-right px-4 py-2 font-medium">Best Buy</th>
                    <th className="text-right px-4 py-2 font-medium">Best Sell</th>
                    <th className="text-right px-4 py-2 font-medium">Buy Vol.</th>
                    <th className="text-right px-4 py-2 font-medium">Sell Vol.</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredStoredEntries.map((entry) => (
                    <tr key={entry.item_name} className="border-b border-border/50">
                      <td className="px-4 py-2">{entry.item_name}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-foreground">{formatStoredPrice(entry)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-[hsl(var(--smui-green))]">{formatNumber(entry.best_bid)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-[hsl(var(--smui-orange))]">{formatNumber(entry.best_ask)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{formatNumber(entry.bid_volume)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{formatNumber(entry.ask_volume)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <button
              onClick={() => setTradesOpen((value) => !value)}
              className="w-full px-4 py-2.5 bg-background/30 flex items-center justify-between hover:bg-background/40 transition-colors"
            >
              <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[1.2px] text-muted-foreground">
                {tradesOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                Recent Trades
              </span>
              <span className="text-[10px] text-muted-foreground">{recentTrades.length} Eintraege</span>
            </button>
            {tradesOpen && !historyLoading && recentTrades.length === 0 && (
              <div className="px-4 py-4 text-sm text-muted-foreground">
                Noch keine eigenen Trades in der Economy-DB gespeichert.
              </div>
            )}
            {tradesOpen && recentTrades.length > 0 && (
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
                  {recentTrades.map((trade) => (
                    <tr key={trade.id} className="border-b border-border/50">
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
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function formatNumber(value: number | null): string {
  return value === null ? '-' : value.toLocaleString()
}

function formatSpread(bid: number | null, ask: number | null): string {
  if (bid === null || ask === null) return '-'
  return (ask - bid).toLocaleString()
}

function formatStoredPrice(entry: StoredMarketEntry): string {
  return formatNumber(deriveDisplayPrice(entry.best_bid, entry.best_ask))
}

function formatRange(low: number | null, high: number | null): string {
  if (low === null && high === null) return '-'
  if (low === high) return formatNumber(low)
  return `${formatNumber(low)}-${formatNumber(high)}`
}

function formatDateTime(value: string): string {
  const parsed = Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z')
  if (!Number.isFinite(parsed)) return value
  return new Date(parsed).toLocaleString()
}


function deriveDisplayPrice(bid: number | null, ask: number | null): number | null {
  if (bid !== null && ask !== null) return Math.round((bid + ask) / 2)
  return ask ?? bid
}

function formatRecommendation(value: MarketHint['recommendation']): string {
  if (value === 'sell_now') return 'Jetzt verkaufen'
  if (value === 'list_near_market') return 'Nahe Markt listen'
  return 'Halten'
}

function formatConfidence(value: MarketHint['confidence']): string {
  if (value === 'high') return 'Hoch'
  if (value === 'medium') return 'Mittel'
  return 'Niedrig'
}
