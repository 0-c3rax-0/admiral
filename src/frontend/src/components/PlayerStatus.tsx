import { useState } from 'react'
import { Shield, Heart, Fuel, Package, Cpu, Zap, MapPin, DollarSign, Crosshair, ScrollText, Gem } from 'lucide-react'

const LS_KEY = 'admiral-status-compact'

interface Props {
  data: Record<string, unknown> | null
  storage?: {
    ts: string
    station_id: string | null
    station_name: string | null
    wallet_credits: number | null
    storage_credits: number | null
    items: Array<{
      item_id: string
      quantity: number | null
    }>
  } | null
}

export function PlayerStatus({ data, storage = null }: Props) {
  const [compact, setCompact] = useState(() => {
    try { return localStorage.getItem(LS_KEY) === '1' } catch { return false }
  })

  function toggle() {
    setCompact(v => {
      const next = !v
      try { localStorage.setItem(LS_KEY, next ? '1' : '0') } catch {}
      return next
    })
  }

  if (!data) {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
        <span className="text-[11px] text-muted-foreground italic">No player data -- connect and send get_status to fetch.</span>
      </div>
    )
  }

  const player = (data.player || {}) as Record<string, unknown>
  const ship = (data.ship || {}) as Record<string, unknown>
  const location = (data.location || {}) as Record<string, unknown>
  const rawStats = (player.stats || {}) as Record<string, unknown>
  const completedMissions = (player.completed_missions || {}) as Record<string, unknown>
  const cargo = Array.isArray(ship.cargo) ? ship.cargo as Array<Record<string, unknown>> : []

  // v1 puts system/poi in player, v2 puts them in location
  const systemName = player.current_system || location.system_name || '?'
  const poiName = player.current_poi || location.poi_name || '?'
  const piratesDestroyed = toNum(rawStats.pirates_destroyed)
  const shipsDestroyed = toNum(rawStats.ships_destroyed)
  const basesDestroyed = toNum(rawStats.bases_destroyed)
  const totalKills = piratesDestroyed + shipsDestroyed + basesDestroyed
  const missionCount = Object.keys(completedMissions).length
  const lootUnits = cargo
    .filter((item) => {
      const itemId = String(item.item_id || '').toLowerCase()
      return itemId !== '' && !itemId.includes('ore') && !itemId.includes('ice') && !itemId.includes('gas')
    })
    .reduce((sum, item) => sum + toNum(item.quantity), 0)
  const topStoredItem = storage?.items
    ?.filter((item) => (item.quantity ?? 0) > 0)
    .sort((a, b) => (b.quantity ?? 0) - (a.quantity ?? 0))[0] || null
  const storedUnits = storage?.items.reduce((sum, item) => sum + toNum(item.quantity), 0) || 0
  const hasStorageSnapshot = Boolean(
    storage && (
      storage.station_name ||
      storage.station_id ||
      storage.storage_credits !== null ||
      storedUnits > 0
    )
  )

  const stats: { icon: React.ReactNode; label: string; value: string; sub?: string; color?: string }[] = [
    { icon: <MapPin size={12} />, label: 'Location', value: `${systemName}`, sub: String(poiName) },
    { icon: <DollarSign size={12} />, label: 'Credits', value: Number(player.credits || 0).toLocaleString(), color: 'var(--smui-yellow)' },
    {
      icon: <Package size={12} />,
      label: 'Storage',
      value: hasStorageSnapshot ? storedUnits.toLocaleString() : '-',
      sub: hasStorageSnapshot
        ? `${storage?.station_name || storage?.station_id || 'unknown'}${topStoredItem ? ` | ${topStoredItem.item_id} x${toNum(topStoredItem.quantity)}` : ''}`
        : 'no snapshot',
      color: 'var(--smui-frost-2)',
    },
    { icon: <Heart size={12} />, label: 'Hull', value: `${ship.hull || 0}/${ship.max_hull || 0}`, color: 'var(--destructive)' },
    { icon: <Shield size={12} />, label: 'Shield', value: `${ship.shield || 0}/${ship.max_shield || 0}`, color: 'var(--primary)' },
    { icon: <Fuel size={12} />, label: 'Fuel', value: `${ship.fuel || 0}/${ship.max_fuel || 0}`, color: 'var(--smui-orange)' },
    { icon: <Package size={12} />, label: 'Cargo', value: `${ship.cargo_used || 0}/${ship.cargo_capacity || 0}`, color: 'var(--smui-green)' },
    { icon: <Cpu size={12} />, label: 'CPU', value: `${ship.cpu_used || 0}/${ship.cpu_capacity || 0}`, color: 'var(--smui-purple)' },
    { icon: <Zap size={12} />, label: 'Power', value: `${ship.power_used || 0}/${ship.power_capacity || 0}`, color: 'var(--smui-frost-3)' },
    { icon: <Crosshair size={12} />, label: 'Kills', value: totalKills.toLocaleString(), sub: `NPC ${piratesDestroyed} | PvP ${shipsDestroyed}`, color: 'var(--smui-red)' },
    { icon: <ScrollText size={12} />, label: 'Missions', value: missionCount.toLocaleString(), sub: 'completed', color: 'var(--smui-frost-2)' },
    { icon: <Gem size={12} />, label: 'Loot', value: lootUnits.toLocaleString(), sub: lootUnits > 0 ? 'non-resource cargo' : 'none onboard', color: 'var(--smui-green)' },
  ]

  if (compact) {
    return (
      <div
        className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-px bg-border border-b border-border cursor-pointer hover:opacity-80 transition-opacity"
        onClick={toggle}
      >
        {stats.map(s => (
          <span key={s.label} className="flex min-w-0 items-center gap-1 bg-card px-3 py-1.5">
            <span style={s.color ? { color: `hsl(${s.color})` } : undefined} className={`shrink-0 ${s.color ? '' : 'text-muted-foreground'}`}>{s.icon}</span>
            <span className="truncate text-[11px] text-foreground/80">{s.label === 'Location' ? `${s.value}${s.sub && s.sub !== '?' ? ` / ${s.sub}` : ''}` : s.value}</span>
          </span>
        ))}
      </div>
    )
  }

  return (
    <div
      className="group/status grid w-full grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-px bg-border border-b border-border cursor-pointer hover:opacity-80 transition-opacity"
      onClick={toggle}
    >
      {stats.map(s => <StatCard key={s.label} wide={s.label === 'Location' || s.label === 'Storage'} {...s} />)}
    </div>
  )
}

function StatCard({ icon, label, value, sub, color, wide = false }: { icon: React.ReactNode; label: string; value: string; sub?: string; color?: string; wide?: boolean }) {
  return (
    <div className={`min-w-0 bg-card p-2 px-2.5 ${wide ? 'md:col-span-2' : ''}`}>
      <div className="flex items-center gap-1 mb-0.5">
        <span style={color ? { color: `hsl(${color})` } : undefined} className={color ? '' : 'text-muted-foreground'}>{icon}</span>
        <span className="text-[10px] text-muted-foreground tracking-[1.2px] uppercase">{label}</span>
      </div>
      <span
        className="block truncate text-[15px] leading-tight font-medium tracking-tight"
        style={color ? { color: `hsl(${color})` } : undefined}
      >
        {value}
      </span>
      {sub && <span className="mt-0.5 block truncate text-[9px] text-muted-foreground">{sub}</span>}
    </div>
  )
}

function toNum(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}
