import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Ship, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

type FleetShipRow = {
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
}

type FleetProfile = {
  profile_id: string
  profile_name: string
  ok: boolean
  error: string | null
  ships: FleetShipRow[]
}

interface Props {
  open: boolean
  onClose: () => void
}

export function FleetShipsModal({ open, onClose }: Props) {
  const [loading, setLoading] = useState(false)
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<FleetProfile[]>([])
  const [error, setError] = useState<string | null>(null)
  const [statusNotice, setStatusNotice] = useState<string | null>(null)
  const [expandedProfiles, setExpandedProfiles] = useState<Record<string, boolean>>({})

  async function loadFleet() {
    setLoading(true)
    setError(null)
    setStatusNotice('Loading fleet snapshot...')
    try {
      const resp = await fetch('/api/fleet/ships')
      const text = await resp.text()
      let data: Record<string, unknown> = {}
      try {
        data = text ? JSON.parse(text) as Record<string, unknown> : {}
      } catch {
        data = {}
      }
      if (!resp.ok) {
        setProfiles([])
        setGeneratedAt(null)
        setExpandedProfiles({})
        const message = typeof data.error === 'string' ? data.error : text || `Fleet request failed (${resp.status})`
        setError(message)
        setStatusNotice(`Fleet load failed: ${message}`)
        return
      }
      setProfiles(Array.isArray(data.profiles) ? data.profiles : [])
      setGeneratedAt(typeof data.generated_at === 'string' ? data.generated_at : null)
      const nextProfiles = Array.isArray(data.profiles) ? data.profiles as FleetProfile[] : []
      setExpandedProfiles(Object.fromEntries(nextProfiles.map((profile) => [profile.profile_id, profile.ships.length > 0 || !profile.ok])))
      const failedCount = nextProfiles.filter((profile) => !profile.ok).length
      const shipCount = nextProfiles.reduce((sum, profile) => sum + profile.ships.length, 0)
      setStatusNotice(
        failedCount > 0
          ? `Fleet loaded: ${shipCount} ships across ${nextProfiles.length} accounts, ${failedCount} with errors`
          : `Fleet loaded: ${shipCount} ships across ${nextProfiles.length} accounts`,
      )
    } catch {
      setProfiles([])
      setGeneratedAt(null)
      setExpandedProfiles({})
      setError('Fleet request failed')
      setStatusNotice('Fleet load failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    loadFleet()
  }, [open])

  useEffect(() => {
    if (!statusNotice || loading) return
    const timer = setTimeout(() => setStatusNotice(null), 3000)
    return () => clearTimeout(timer)
  }, [statusNotice, loading])

  const groupedProfiles = useMemo(() => {
    return [...profiles]
      .map((profile) => ({
        ...profile,
        ships: [...profile.ships].sort((a, b) => {
          if (a.is_active !== b.is_active) return a.is_active ? -1 : 1
          return a.name.localeCompare(b.name)
        }),
      }))
      .sort((a, b) => a.profile_name.localeCompare(b.profile_name))
  }, [profiles])

  const failedProfiles = profiles.filter((profile) => !profile.ok)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm p-3 sm:p-6" onClick={onClose}>
      <div className="flex min-h-full items-center justify-center">
        <div className="w-full max-w-7xl max-h-[calc(100vh-1.5rem)] sm:max-h-[calc(100vh-3rem)] overflow-hidden border border-border bg-card shadow-lg" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <div className="flex items-center gap-2">
              <Ship size={14} className="text-primary" />
              <span className="font-jetbrains text-xs font-semibold tracking-[1.5px] text-primary uppercase">Fleet</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={loadFleet} disabled={loading} className="gap-1.5">
                <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                Reload
              </Button>
              <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="px-4 py-3 border-b border-border bg-background/30 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{profiles.reduce((sum, profile) => sum + profile.ships.length, 0)} ships across {profiles.length} accounts</span>
              <span>{generatedAt ? `snapshot ${formatDateTime(generatedAt)}` : loading ? 'loading...' : 'no data'}</span>
            </div>
            <div className="mt-1 text-[11px]">
              Full fitting names are only guaranteed for the active ship of each account. Stored ships usually expose only module count via `list_ships`.
            </div>
            {statusNotice && (
              <div className="mt-2 text-[11px] text-foreground">
                {statusNotice}
              </div>
            )}
          </div>

          <div className="max-h-[calc(100vh-8rem)] overflow-auto">
            {failedProfiles.length > 0 && (
              <div className="border-b border-border px-4 py-3 text-xs text-[hsl(var(--smui-orange))]">
                {failedProfiles.map((profile) => `${profile.profile_name}: ${profile.error || 'request failed'}`).join(' | ')}
              </div>
            )}

            {error && (
              <div className="border-b border-border px-4 py-3 text-xs text-[hsl(var(--smui-orange))]">
                {error}
              </div>
            )}

            {loading && groupedProfiles.length === 0 ? (
              <div className="px-4 py-8 text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" />
                Fleet data loading...
              </div>
            ) : groupedProfiles.length === 0 ? (
              <div className="px-4 py-8 text-sm text-muted-foreground">
                No fleet ship data available.
              </div>
            ) : (
              <div>
                {groupedProfiles.map((profile) => {
                  const isOpen = expandedProfiles[profile.profile_id] ?? false
                  return (
                    <section key={profile.profile_id} className="border-b border-border/50 last:border-b-0">
                      <button
                        onClick={() => setExpandedProfiles((prev) => ({ ...prev, [profile.profile_id]: !isOpen }))}
                        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-background/40 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          {isOpen ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
                          <span className="text-sm text-foreground">{profile.profile_name}</span>
                          {!profile.ok && <span className="text-[10px] uppercase text-[hsl(var(--smui-orange))]">error</span>}
                        </div>
                        <span className="text-[10px] uppercase tracking-[1.2px] text-muted-foreground">{profile.ships.length} ships</span>
                      </button>
                      {isOpen && (
                        profile.ships.length > 0 ? (
                          <table className="w-full text-xs">
                            <thead className="bg-card/80">
                              <tr className="border-b border-border text-muted-foreground uppercase tracking-[1.2px]">
                                <th className="text-left px-4 py-2 font-medium">Ship</th>
                                <th className="text-left px-4 py-2 font-medium">Class</th>
                                <th className="text-left px-4 py-2 font-medium">State</th>
                                <th className="text-left px-4 py-2 font-medium">Location</th>
                                <th className="text-right px-4 py-2 font-medium">Hull</th>
                                <th className="text-right px-4 py-2 font-medium">Fuel</th>
                                <th className="text-right px-4 py-2 font-medium">Cargo</th>
                                <th className="text-left px-4 py-2 font-medium">Fitting</th>
                              </tr>
                            </thead>
                            <tbody>
                              {profile.ships.map((ship) => (
                                <tr key={`${profile.profile_id}:${ship.ship_id || ship.name}`} className="border-b border-border/50 align-top last:border-b-0">
                                  <td className="px-4 py-2 text-foreground">{ship.name}</td>
                                  <td className="px-4 py-2 text-muted-foreground">{ship.class_id || '-'}</td>
                                  <td className="px-4 py-2">
                                    <span className={ship.is_active ? 'text-[hsl(var(--smui-green))]' : 'text-muted-foreground'}>
                                      {ship.is_active ? 'active' : 'stored'}
                                    </span>
                                  </td>
                                  <td className="px-4 py-2 text-muted-foreground">{ship.location || '-'}</td>
                                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{ship.hull || '-'}</td>
                                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{ship.fuel || '-'}</td>
                                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{ship.cargo_used ?? '-'}</td>
                                  <td className="px-4 py-2">
                                    {ship.fitting.length > 0 ? (
                                      <div className="flex flex-wrap gap-1">
                                        {ship.fitting.map((module, index) => (
                                          <span key={`${module}:${index}`} className="border border-border bg-background/50 px-2 py-0.5 text-[10px] text-foreground">
                                            {module}
                                          </span>
                                        ))}
                                      </div>
                                    ) : ship.modules_count !== null ? (
                                      <span className="text-muted-foreground">{ship.modules_count} modules</span>
                                    ) : (
                                      <span className="text-muted-foreground">-</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <div className="px-4 py-4 text-sm text-muted-foreground">
                            No ships returned for this account.
                          </div>
                        )
                      )}
                    </section>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function formatDateTime(value: string): string {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return value
  return new Date(parsed).toLocaleString()
}
