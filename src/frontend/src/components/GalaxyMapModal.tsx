import { useEffect, useMemo, useState } from 'react'
import { X, MapPin, Users, Building2, Pickaxe } from 'lucide-react'
import type { Profile } from '@/types'

type GalaxySystem = {
  id: string
  name: string
  x: number
  y: number
  online: number
  connections: string[]
}

type GalaxyMapResponse = {
  systems: GalaxySystem[]
}

type SystemPoi = {
  id: string
  name: string
  type: string
  station_name?: string
  station_services?: string[]
  [key: string]: unknown
}

type SystemDetail = {
  description?: string
  security_status?: string
  police_level?: number
  empire?: string
  pois: SystemPoi[]
}

interface Props {
  open: boolean
  onClose: () => void
  gameserverUrl: string
  profiles: Profile[]
  playerDataMap: Record<string, Record<string, unknown>>
}

function normalizeKey(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : ''
}

function extractCurrentSystem(playerData: Record<string, unknown> | undefined): string {
  if (!playerData) return ''
  const player = playerData.player as Record<string, unknown> | undefined
  const location = playerData.location as Record<string, unknown> | undefined
  return String(player?.current_system || location?.system_name || '')
}

function extractOreHints(poi: SystemPoi): string[] {
  const candidates = ['ores', 'ore_types', 'resources', 'resource_types', 'materials', 'minerals']
  const out = new Set<string>()
  for (const key of candidates) {
    const value = poi[key]
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item.trim()) out.add(item.trim())
    } else if (typeof value === 'string' && value.trim()) {
      out.add(value.trim())
    }
  }
  return Array.from(out)
}

export function GalaxyMapModal({ open, onClose, gameserverUrl, profiles, playerDataMap }: Props) {
  const [mapData, setMapData] = useState<GalaxyMapResponse | null>(null)
  const [selectedSystemId, setSelectedSystemId] = useState<string>('')
  const [detail, setDetail] = useState<SystemDetail | null>(null)
  const [loadingMap, setLoadingMap] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [error, setError] = useState<string>('')

  useEffect(() => {
    if (!open) return
    setLoadingMap(true)
    setError('')
    fetchMapJson('/api/map', gameserverUrl)
      .then((data) => {
        setMapData(data as GalaxyMapResponse)
        if (!selectedSystemId && data.systems.length > 0) setSelectedSystemId(data.systems[0].id)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoadingMap(false))
  }, [open, gameserverUrl, selectedSystemId])

  useEffect(() => {
    if (!open || !selectedSystemId) return
    setLoadingDetail(true)
    fetchMapJson(`/api/map/system/${encodeURIComponent(selectedSystemId)}`, gameserverUrl)
      .then((data) => setDetail(data as SystemDetail))
      .catch(() => setDetail(null))
      .finally(() => setLoadingDetail(false))
  }, [open, selectedSystemId, gameserverUrl])

  const bounds = useMemo(() => {
    const systems = mapData?.systems || []
    if (systems.length === 0) return { minX: 0, maxX: 1, minY: 0, maxY: 1 }
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const s of systems) {
      minX = Math.min(minX, s.x)
      maxX = Math.max(maxX, s.x)
      minY = Math.min(minY, s.y)
      maxY = Math.max(maxY, s.y)
    }
    return { minX, maxX, minY, maxY }
  }, [mapData])

  const accountPositions = useMemo(() => {
    const bySystem = new Map<string, string[]>()
    for (const p of profiles) {
      const key = normalizeKey(extractCurrentSystem(playerDataMap[p.id]))
      if (!key) continue
      const list = bySystem.get(key) || []
      list.push(p.name)
      bySystem.set(key, list)
    }
    return bySystem
  }, [profiles, playerDataMap])

  const systemsById = useMemo(() => {
    const map = new Map<string, GalaxySystem>()
    for (const s of mapData?.systems || []) map.set(s.id, s)
    return map
  }, [mapData])

  const selectedSystem = selectedSystemId ? systemsById.get(selectedSystemId) : undefined
  const stationPois = (detail?.pois || []).filter((p) => p.type === 'station' || !!p.station_name)
  const miningPois = (detail?.pois || []).filter((p) => ['asteroid', 'asteroid_belt', 'ice_field', 'gas_cloud'].includes(p.type))
  const oreHints = Array.from(new Set(miningPois.flatMap(extractOreHints)))

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-2 sm:p-4" onClick={onClose}>
      <div className="w-full max-w-[1600px] h-[96vh] border border-border bg-card shadow-lg flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <span className="font-jetbrains text-xs font-semibold tracking-[1.5px] text-primary uppercase">Galaxy Map</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="min-h-full grid grid-cols-1 lg:grid-cols-[1fr_340px]">
          <div className="relative h-[58vh] lg:h-auto border-b lg:border-b-0 lg:border-r border-border bg-[#05070a]">
            {loadingMap && <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">Loading map...</div>}
            {error && <div className="absolute inset-0 flex items-center justify-center text-xs text-[hsl(var(--smui-red))]">{error}</div>}
            {!loadingMap && mapData && (
              <svg viewBox="0 0 1000 1000" className="w-full h-full">
                <g>
                  {(mapData.systems || []).flatMap((s) => {
                    const ax = ((s.x - bounds.minX) / Math.max(1, bounds.maxX - bounds.minX)) * 920 + 40
                    const ay = ((s.y - bounds.minY) / Math.max(1, bounds.maxY - bounds.minY)) * 920 + 40
                    return (s.connections || [])
                      .filter((to) => s.id < to)
                      .map((to) => {
                        const t = systemsById.get(to)
                        if (!t) return null
                        const bx = ((t.x - bounds.minX) / Math.max(1, bounds.maxX - bounds.minX)) * 920 + 40
                        const by = ((t.y - bounds.minY) / Math.max(1, bounds.maxY - bounds.minY)) * 920 + 40
                        return <line key={`${s.id}-${to}`} x1={ax} y1={ay} x2={bx} y2={by} stroke="rgba(80,110,145,.35)" strokeWidth="1" />
                      })
                      .filter(Boolean)
                  })}
                </g>
                <g>
                  {(mapData.systems || []).map((s) => {
                    const cx = ((s.x - bounds.minX) / Math.max(1, bounds.maxX - bounds.minX)) * 920 + 40
                    const cy = ((s.y - bounds.minY) / Math.max(1, bounds.maxY - bounds.minY)) * 920 + 40
                    const accountNames = accountPositions.get(normalizeKey(s.name)) || accountPositions.get(normalizeKey(s.id)) || []
                    const hasAccounts = accountNames.length > 0
                    const selected = s.id === selectedSystemId
                    return (
                      <g key={s.id} onClick={() => setSelectedSystemId(s.id)} className="cursor-pointer">
                        {hasAccounts && <circle cx={cx} cy={cy} r={12 + Math.min(8, accountNames.length * 2)} fill="rgba(44, 201, 255, 0.18)" />}
                        <circle
                          cx={cx}
                          cy={cy}
                          r={selected ? 5.5 : 3.5}
                          fill={hasAccounts ? '#2cc9ff' : selected ? '#ffd166' : '#b0b8c5'}
                          stroke={selected ? '#fff3cf' : 'transparent'}
                          strokeWidth={selected ? 1 : 0}
                        />
                      </g>
                    )
                  })}
                </g>
              </svg>
            )}
          </div>

          <div className="h-full overflow-y-auto p-3 text-xs space-y-3">
            <div className="border border-border/70 p-2.5 bg-background/40">
              <div className="text-[10px] uppercase tracking-[1.2px] text-muted-foreground mb-1">Selected System</div>
              <div className="font-medium text-foreground">{selectedSystem?.name || 'None'}</div>
              <div className="mt-1 text-muted-foreground flex items-center gap-2">
                <Users size={12} />
                Online: {selectedSystem?.online ?? 0}
              </div>
              <div className="text-muted-foreground flex items-center gap-2">
                <MapPin size={12} />
                Connections: {selectedSystem?.connections?.length || 0}
              </div>
            </div>

            {selectedSystem && (
              <div className="border border-border/70 p-2.5 bg-background/40">
                <div className="text-[10px] uppercase tracking-[1.2px] text-muted-foreground mb-1">Your Accounts Here</div>
                {(() => {
                  const names = accountPositions.get(normalizeKey(selectedSystem.name)) || accountPositions.get(normalizeKey(selectedSystem.id)) || []
                  if (names.length === 0) return <div className="text-muted-foreground">No tracked account currently in this system.</div>
                  return <div className="text-[hsl(var(--smui-cyan))]">{names.join(', ')}</div>
                })()}
              </div>
            )}

            <div className="border border-border/70 p-2.5 bg-background/40">
              <div className="text-[10px] uppercase tracking-[1.2px] text-muted-foreground mb-1">System Intel</div>
              {loadingDetail && <div className="text-muted-foreground">Loading details...</div>}
              {!loadingDetail && detail && (
                <div className="space-y-2">
                  <div className="text-muted-foreground">{detail.description || 'No description available.'}</div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Security</span>
                    <span className="text-foreground">{detail.security_status || 'unknown'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Police Level</span>
                    <span className="text-foreground">{typeof detail.police_level === 'number' ? detail.police_level : 'unknown'}</span>
                  </div>
                </div>
              )}
            </div>

            <div className="border border-border/70 p-2.5 bg-background/40">
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-[1.2px] text-muted-foreground mb-1">
                <Building2 size={12} /> Stations
              </div>
              {stationPois.length === 0 && <div className="text-muted-foreground">No station data in this system.</div>}
              {stationPois.length > 0 && stationPois.map((p) => (
                <div key={p.id} className="mb-1.5">
                  <div className="text-foreground">{p.station_name || p.name}</div>
                  <div className="text-muted-foreground">{(p.station_services || []).join(', ') || 'No service list'}</div>
                </div>
              ))}
            </div>

            <div className="border border-border/70 p-2.5 bg-background/40">
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-[1.2px] text-muted-foreground mb-1">
                <Pickaxe size={12} /> Mining
              </div>
              {miningPois.length === 0 && <div className="text-muted-foreground">No mineable POIs reported.</div>}
              {miningPois.length > 0 && (
                <>
                  <div className="text-foreground">{miningPois.map((p) => p.name).join(', ')}</div>
                  <div className="text-muted-foreground mt-1">
                    Ores: {oreHints.length > 0 ? oreHints.join(', ') : 'No explicit ore list in map API response'}
                  </div>
                </>
              )}
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  )
}

async function parseJsonResponse(resp: Response): Promise<unknown> {
  const text = await resp.text()
  try {
    return JSON.parse(text)
  } catch {
    const trimmed = text.trim()
    if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
      throw new Error('Received HTML instead of JSON from API route')
    }
    throw new Error('Invalid JSON response from API route')
  }
}

async function fetchMapJson(apiPath: string, gameserverUrl: string): Promise<any> {
  const primary = `${apiPath}?server_url=${encodeURIComponent(gameserverUrl || 'https://game.spacemolt.com')}`
  try {
    const resp = await fetch(primary)
    const data = await parseJsonResponse(resp)
    if (!resp.ok) throw new Error((data as { error?: string })?.error || `Request failed (${resp.status})`)
    return data
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const fallbackBase = (gameserverUrl || 'https://game.spacemolt.com').replace(/\/$/, '')
    if (!msg.includes('HTML instead of JSON')) throw err

    const directPath = apiPath.replace(/^\/api\/map/, '/api/map')
    const fallbackResp = await fetch(`${fallbackBase}${directPath}`)
    const fallbackData = await parseJsonResponse(fallbackResp)
    if (!fallbackResp.ok) {
      throw new Error((fallbackData as { error?: string })?.error || `Direct map request failed (${fallbackResp.status})`)
    }
    return fallbackData
  }
}
