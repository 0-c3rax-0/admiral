import { useState, useEffect, useCallback, useRef } from 'react'
import { Settings, Sun, Moon, Github, AlertTriangle, CircleHelp, BarChart3, MessageSquare, X } from 'lucide-react'
import { useSearchParams } from 'react-router'
import type { Profile, Provider } from '@/types'
import { ProfileList } from './ProfileList'
import { ProfileView } from './ProfileView'
import { NewProfileWizard } from './NewProfileWizard'
import { AdmiralTour } from './AdmiralTour'

interface Props {
  profiles: Profile[]
  providers: Provider[]
  registrationCode: string
  gameserverUrl: string
  onRefresh: () => void
  onShowProviders: () => void
}

type RuntimeStatus = {
  connected: boolean
  running: boolean
  adaptive_mode?: 'normal' | 'soft' | 'high' | 'critical'
  effective_context_budget_ratio?: number | null
}

type StatsSnapshot = {
  ts: string
  credits: number | null
  ore_mined: number | null
  trades_completed: number | null
  systems_explored: number | null
}

type StatsEvent = {
  ts: string
  type: string
}

const MODE_RANK: Record<'normal' | 'soft' | 'high' | 'critical', number> = {
  normal: 0,
  soft: 1,
  high: 2,
  critical: 3,
}

export function Dashboard({ profiles: initialProfiles, providers, registrationCode, gameserverUrl, onRefresh, onShowProviders }: Props) {
  const [profiles, setProfiles] = useState(initialProfiles)
  const [searchParams, setSearchParams] = useSearchParams()
  const activeId = searchParams.get('profile') || initialProfiles[0]?.id || ''
  const setActiveId = (id: string | null) => {
    const params = new URLSearchParams(searchParams)
    if (id) { params.set('profile', id) } else { params.delete('profile') }
    setSearchParams(params)
  }
  const [autoEditName, setAutoEditName] = useState(false)
  const [statuses, setStatuses] = useState<Record<string, RuntimeStatus>>({})
  const [playerDataMap, setPlayerDataMap] = useState<Record<string, Record<string, unknown>>>({})
  const [showWizard, setShowWizard] = useState(false)
  const [showTour, setShowTour] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [connectingAll, setConnectingAll] = useState(false)
  const [nudgingAll, setNudgingAll] = useState(false)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsDbSummary, setStatsDbSummary] = useState<{
    snapshotCount: number
    profilesWithData: number
    lastSnapshotTs: string | null
    creditsDelta1h: number
    oreDelta1h: number
    events24h: number
  } | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return localStorage.getItem('admiral-sidebar-open') !== 'false' } catch { return true }
  })

  const activeProfile = profiles.find(p => p.id === activeId)
  const runningProfiles = profiles.filter(p => statuses[p.id]?.running).length
  const connectedProfiles = profiles.filter(p => statuses[p.id]?.connected).length
  const globalMode = profiles.reduce<'normal' | 'soft' | 'high' | 'critical'>((worst, p) => {
    const m = statuses[p.id]?.adaptive_mode || 'normal'
    return MODE_RANK[m] > MODE_RANK[worst] ? m : worst
  }, 'normal')
  const modeClass =
    globalMode === 'critical' ? 'text-[hsl(var(--smui-red))]' :
    globalMode === 'high' ? 'text-[hsl(var(--smui-orange))]' :
    globalMode === 'soft' ? 'text-[hsl(var(--smui-yellow))]' :
    'text-[hsl(var(--smui-green))]'
  const gameTotals = profiles.reduce((acc, p) => {
    const pd = playerDataMap[p.id]
    const player = pd?.player as Record<string, unknown> | undefined
    const stats = (player?.stats as Record<string, unknown> | undefined) || {}
    acc.credits += Number(player?.credits || 0)
    acc.oreMined += Number(stats.ore_mined || 0)
    acc.trades += Number(stats.trades_completed || 0)
    acc.systemsExplored += Number(stats.systems_explored || 0)
    return acc
  }, { credits: 0, oreMined: 0, trades: 0, systemsExplored: 0 })

  // Auto-show tour for new users who haven't seen it
  useEffect(() => {
    if (profiles.length > 0 && activeProfile && !showTour) {
      try {
        const seen = localStorage.getItem('admiral-tour-seen')
        if (!seen) setShowTour(true)
      } catch { /* ignore */ }
    }
  }, [profiles.length, !!activeProfile]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch player data for a connected profile
  const fetchPlayerData = useCallback(async (profileId: string) => {
    try {
      const resp = await fetch(`/api/profiles/${profileId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'get_status' }),
      })
      const result = await resp.json()
      const data = result.structuredContent ?? result.result
      if (data && typeof data === 'object') {
        if ('player' in data || 'ship' in data || 'location' in data) {
          setPlayerDataMap(prev => ({ ...prev, [profileId]: data }))
        }
      }
    } catch { /* ignore */ }
  }, [])

  // Poll statuses + fetch player data for connected profiles on mount
  const initialFetchDone = useRef(false)
  useEffect(() => {
    async function poll() {
      const connected: string[] = []
      for (const p of profiles) {
        try {
          const resp = await fetch(`/api/profiles/${p.id}`)
          const data = await resp.json()
          const isConnected = !!data.connected
          setStatuses(prev => ({
            ...prev,
            [p.id]: {
              connected: isConnected,
              running: !!data.running,
              adaptive_mode: data.adaptive_mode || 'normal',
              effective_context_budget_ratio: typeof data.effective_context_budget_ratio === 'number' ? data.effective_context_budget_ratio : null,
            },
          }))
          if (isConnected) connected.push(p.id)
        } catch {
          // ignore
        }
      }
      // On first poll, fetch player data for all connected profiles
      if (!initialFetchDone.current && connected.length > 0) {
        initialFetchDone.current = true
        for (const id of connected) fetchPlayerData(id)
      }
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  }, [profiles, fetchPlayerData])

  const refreshProfiles = useCallback(async () => {
    try {
      const resp = await fetch('/api/profiles')
      const data = await resp.json()
      setProfiles(data)
    } catch {
      // ignore
    }
  }, [])

  function handleNewProfile() {
    setShowWizard(true)
  }

  async function handleWizardCreate(data: Partial<Profile>) {
    setShowWizard(false)
    try {
      const resp = await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (resp.ok) {
        const profile = await resp.json()
        setProfiles(prev => [...prev, profile])
        setActiveId(profile.id)
      }
    } catch {
      // ignore
    }
  }

  async function handleDeleteProfile(id: string) {
    try {
      await fetch(`/api/profiles/${id}`, { method: 'DELETE' })
      setProfiles(prev => prev.filter(p => p.id !== id))
      if (activeId === id) setActiveId(profiles.find(p => p.id !== id)?.id || '')
    } catch {
      // ignore
    }
  }

  async function handleConnectAll() {
    const targets = profiles.filter(p => !statuses[p.id]?.connected)
    if (targets.length === 0) return
    setConnectingAll(true)
    try {
      await Promise.allSettled(
        targets.map(async (p) => {
          const isManual = !p.provider || p.provider === 'manual'
          const action = isManual ? 'connect' : 'connect_llm'
          await fetch(`/api/profiles/${p.id}/connect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action }),
          })
        })
      )
      await refreshProfiles()
      onRefresh()
    } finally {
      setConnectingAll(false)
    }
  }

  async function handleNudgeAll() {
    const runningTargets = profiles.filter(p => statuses[p.id]?.running)
    if (runningTargets.length === 0) return

    const message = window.prompt('Nudge message for all running agents:')
    if (!message?.trim()) return

    setNudgingAll(true)
    try {
      await Promise.allSettled(
        runningTargets.map(async (p) => {
          await fetch(`/api/profiles/${p.id}/nudge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: message.trim() }),
          })
        })
      )
    } finally {
      setNudgingAll(false)
    }
  }

  async function handleOpenStats() {
    setShowStats(true)
    setStatsLoading(true)
    try {
      const now = Date.now()
      const oneHourAgo = now - (60 * 60 * 1000)
      const dayAgo = now - (24 * 60 * 60 * 1000)

      const byProfile = await Promise.allSettled(
        profiles.map(async (p) => {
          const [snapResp, eventResp] = await Promise.all([
            fetch(`/api/stats/${p.id}/snapshots?limit=240`),
            fetch(`/api/stats/${p.id}/events?limit=200`),
          ])
          const snapJson = await snapResp.json().catch(() => ({ snapshots: [] as StatsSnapshot[] }))
          const eventJson = await eventResp.json().catch(() => ({ events: [] as StatsEvent[] }))
          return {
            snapshots: (snapJson.snapshots || []) as StatsSnapshot[],
            events: (eventJson.events || []) as StatsEvent[],
          }
        })
      )

      let snapshotCount = 0
      let profilesWithData = 0
      let lastSnapshotTs: string | null = null
      let creditsDelta1h = 0
      let oreDelta1h = 0
      let events24h = 0

      const num = (v: number | null | undefined): number => typeof v === 'number' && Number.isFinite(v) ? v : 0

      for (const item of byProfile) {
        if (item.status !== 'fulfilled') continue
        const snapshots = item.value.snapshots
        const events = item.value.events
        snapshotCount += snapshots.length
        if (snapshots.length > 0) profilesWithData++

        const newest = snapshots[0]
        if (newest?.ts && (!lastSnapshotTs || new Date(newest.ts).getTime() > new Date(lastSnapshotTs).getTime())) {
          lastSnapshotTs = newest.ts
        }

        if (snapshots.length > 0) {
          const anchor = snapshots.find(s => new Date(s.ts).getTime() <= oneHourAgo) || snapshots[snapshots.length - 1]
          creditsDelta1h += num(newest?.credits) - num(anchor?.credits)
          oreDelta1h += num(newest?.ore_mined) - num(anchor?.ore_mined)
        }

        events24h += events.filter(e => new Date(e.ts).getTime() >= dayAgo).length
      }

      setStatsDbSummary({
        snapshotCount,
        profilesWithData,
        lastSnapshotTs,
        creditsDelta1h,
        oreDelta1h,
        events24h,
      })
    } finally {
      setStatsLoading(false)
    }
  }

  const hasValidProvider = providers.some(p => p.status === 'valid' || p.api_key)

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <div className="sticky top-0 z-50 flex items-center justify-between h-12 px-3.5 bg-card border-b border-border">
        <div className="flex items-baseline gap-3">
          <h1 className="font-jetbrains text-sm font-bold tracking-[1.5px] text-primary uppercase">
            ADMIRAL
          </h1>
          <span className="text-[11px] text-muted-foreground tracking-[1.5px] uppercase">SpaceMolt Agent Manager</span>
          <span className={`text-[10px] tracking-[1.2px] uppercase ${modeClass}`}>
            Global Mem: {globalMode} | {runningProfiles}/{connectedProfiles} running
          </span>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="https://github.com/SpaceMolt/admiral"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center w-7 h-7 text-muted-foreground hover:text-foreground transition-colors border border-border"
            title="GitHub"
          >
            <Github size={13} />
          </a>
          <ThemeToggle />
          <button
            onClick={() => {
              try { localStorage.removeItem('admiral-tour-seen') } catch {}
              setShowTour(true)
            }}
            className="flex items-center justify-center w-7 h-7 text-muted-foreground hover:text-foreground transition-colors border border-border"
            title="Take a tour"
          >
            <CircleHelp size={13} />
          </button>
          <button
            onClick={handleOpenStats}
            className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wider px-2.5 py-1.5 hover:text-foreground transition-colors"
            title="Runtime stats"
          >
            <BarChart3 size={13} />
            Stats
          </button>
          <button
            onClick={handleConnectAll}
            disabled={connectingAll || profiles.length === 0 || connectedProfiles >= profiles.length}
            className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wider px-2.5 py-1.5 hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Connect all disconnected profiles"
          >
            {connectingAll ? 'Connecting...' : 'Connect All'}
          </button>
          <button
            onClick={handleNudgeAll}
            disabled={nudgingAll || runningProfiles === 0}
            className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wider px-2.5 py-1.5 hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Send a nudge to all running agents"
          >
            <MessageSquare size={13} />
            {nudgingAll ? 'Nudging...' : 'Nudge All'}
          </button>
          <button
            onClick={onShowProviders}
            className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wider px-2.5 py-1.5 hover:text-foreground transition-colors"
          >
            <Settings size={13} />
            Settings
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        {sidebarOpen && (
          <div data-tour="sidebar" className="border-r border-border bg-card flex flex-col h-full">
            <ProfileList
              profiles={profiles}
              activeId={activeId}
              statuses={statuses}
              playerDataMap={playerDataMap}
              onSelect={setActiveId}
              onNew={handleNewProfile}
            />
          </div>
        )}

        {/* Content area */}
        <div className="flex-1 min-w-0">
          {activeProfile ? (
            <ProfileView
              profile={activeProfile}
              providers={providers}
              status={statuses[activeProfile.id] || { connected: false, running: false, adaptive_mode: 'normal', effective_context_budget_ratio: null }}
              registrationCode={registrationCode}
              playerData={playerDataMap[activeProfile.id] || null}
              onPlayerData={(data) => setPlayerDataMap(prev => ({ ...prev, [activeProfile.id]: data }))}
              onDelete={() => handleDeleteProfile(activeProfile.id)}
              onRefresh={() => {
                refreshProfiles()
              }}
              autoEditName={autoEditName}
              onAutoEditNameDone={() => setAutoEditName(false)}
              showProfileList={sidebarOpen}
              onToggleProfileList={() => setSidebarOpen(v => { const next = !v; try { localStorage.setItem('admiral-sidebar-open', String(next)) } catch {}; return next })}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-md px-6">
                <h2 className="font-jetbrains text-xl font-bold tracking-[1.5px] text-primary uppercase mb-3">
                  ADMIRAL
                </h2>
                <p className="text-[11px] text-muted-foreground uppercase tracking-[1.5px] mb-6">
                  SpaceMolt Agent Manager
                </p>

                {/* Warnings */}
                <div className="space-y-2.5 mb-6 text-left">
                  {!hasValidProvider && (
                    <div className="flex items-start gap-2.5 px-3 py-2.5 border border-[hsl(var(--smui-orange)/0.4)] bg-[hsl(var(--smui-orange)/0.05)]">
                      <AlertTriangle size={14} className="text-[hsl(var(--smui-orange))] shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs text-[hsl(var(--smui-orange))] font-medium">No model providers configured</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          At least one LLM provider API key or local model is required for AI agents.{' '}
                          <button onClick={onShowProviders} className="text-primary hover:underline">Open Settings</button>
                        </p>
                      </div>
                    </div>
                  )}
                  {!registrationCode && (
                    <div className="flex items-start gap-2.5 px-3 py-2.5 border border-[hsl(var(--smui-yellow)/0.4)] bg-[hsl(var(--smui-yellow)/0.05)]">
                      <AlertTriangle size={14} className="text-[hsl(var(--smui-yellow))] shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs text-[hsl(var(--smui-yellow))] font-medium">No registration code</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          Needed to register new players. Get one from{' '}
                          <a href="https://spacemolt.com/dashboard" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">spacemolt.com/dashboard</a>
                          {' '}and set it in{' '}
                          <button onClick={onShowProviders} className="text-primary hover:underline">Settings</button>.
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                <button
                  onClick={handleNewProfile}
                  className="inline-flex items-center gap-2 px-5 py-2 text-xs font-medium uppercase tracking-[1.5px] text-primary-foreground bg-primary hover:bg-primary/90 transition-colors"
                >
                  Create Profile
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Wizard modal */}
      {showWizard && (
        <NewProfileWizard
          providers={providers}
          registrationCode={registrationCode}
          gameserverUrl={gameserverUrl}
          onClose={() => setShowWizard(false)}
          onCreate={handleWizardCreate}
          onShowSettings={() => {
            setShowWizard(false)
            onShowProviders()
          }}
        />
      )}

      {showStats && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowStats(false)}>
          <div className="w-full max-w-md border border-border bg-card shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
              <span className="font-jetbrains text-xs font-semibold tracking-[1.5px] text-primary uppercase">Runtime Stats</span>
              <button onClick={() => setShowStats(false)} className="text-muted-foreground hover:text-foreground transition-colors">
                <X size={14} />
              </button>
            </div>
            <div className="px-4 py-3 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Profiles</span>
                <span className="text-foreground">{profiles.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Connected</span>
                <span className="text-foreground">{connectedProfiles}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Running</span>
                <span className="text-foreground">{runningProfiles}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Global Mem Mode</span>
                <span className={`uppercase ${modeClass}`}>{globalMode}</span>
              </div>
              <div className="mt-2 border-t border-border/60 pt-2">
                <div className="text-[10px] text-muted-foreground uppercase tracking-[1.2px] mb-1.5">Game Totals</div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Credits</span>
                  <span className="text-foreground">{gameTotals.credits.toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Ore Mined</span>
                  <span className="text-foreground">{gameTotals.oreMined.toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Trades</span>
                  <span className="text-foreground">{gameTotals.trades.toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Systems Explored</span>
                  <span className="text-foreground">{gameTotals.systemsExplored.toLocaleString()}</span>
                </div>
              </div>
              <div className="mt-2 border-t border-border/60 pt-2">
                <div className="text-[10px] text-muted-foreground uppercase tracking-[1.2px] mb-1.5">DB Telemetry</div>
                {statsLoading && (
                  <div className="text-[11px] text-muted-foreground">Loading snapshot metrics...</div>
                )}
                {!statsLoading && statsDbSummary && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Snapshots</span>
                      <span className="text-foreground">{statsDbSummary.snapshotCount.toLocaleString()}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Profiles With Data</span>
                      <span className="text-foreground">{statsDbSummary.profilesWithData}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Credits (1h)</span>
                      <span className={statsDbSummary.creditsDelta1h >= 0 ? 'text-[hsl(var(--smui-green))]' : 'text-[hsl(var(--smui-red))]'}>
                        {statsDbSummary.creditsDelta1h >= 0 ? '+' : ''}{Math.round(statsDbSummary.creditsDelta1h).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Ore Mined (1h)</span>
                      <span className={statsDbSummary.oreDelta1h >= 0 ? 'text-[hsl(var(--smui-green))]' : 'text-[hsl(var(--smui-red))]'}>
                        {statsDbSummary.oreDelta1h >= 0 ? '+' : ''}{Math.round(statsDbSummary.oreDelta1h).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Events (24h)</span>
                      <span className="text-foreground">{statsDbSummary.events24h.toLocaleString()}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Last Snapshot</span>
                      <span className="text-foreground">
                        {statsDbSummary.lastSnapshotTs ? new Date(statsDbSummary.lastSnapshotTs).toLocaleString() : 'n/a'}
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tour */}
      {showTour && activeProfile && (
        <AdmiralTour
          onComplete={() => {
            setShowTour(false)
            try { localStorage.setItem('admiral-tour-seen', '1') } catch {}
          }}
        />
      )}
    </div>
  )
}

function ThemeToggle() {
  const [dark, setDark] = useState(true)

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'))
  }, [])

  function toggle() {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    try { localStorage.setItem('admiral-theme', next ? 'dark' : 'light') } catch {}
  }

  return (
    <button
      onClick={toggle}
      className="flex items-center justify-center w-7 h-7 text-muted-foreground hover:text-foreground transition-colors border border-border"
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {dark ? <Sun size={13} /> : <Moon size={13} />}
    </button>
  )
}
