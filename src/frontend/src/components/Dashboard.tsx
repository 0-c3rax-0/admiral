import { useState, useEffect, useCallback, useRef } from 'react'
import { Settings, Sun, Moon, Github, AlertTriangle, CircleHelp, BarChart3, MessageSquare, X } from 'lucide-react'
import { useSearchParams } from 'react-router'
import type { Profile, Provider } from '@/types'
import { ProfileList } from './ProfileList'
import { ProfileView } from './ProfileView'
import { NewProfileWizard } from './NewProfileWizard'
import { AdmiralTour } from './AdmiralTour'
import { GalaxyMapModal } from './GalaxyMapModal'

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
  mutation_state?: 'idle' | 'mutation_pending' | 'navigation_pending' | 'local_stall'
  mutation_state_detail?: string | null
  navigation_state?: 'docked' | 'undocked' | 'at_resource_poi' | 'navigation_pending' | 'local_stall' | 'unknown'
  navigation_state_detail?: string | null
  adaptive_mode?: 'normal' | 'soft' | 'high' | 'critical'
  effective_context_budget_ratio?: number | null
  rate_risk?: {
    level: 'LOW' | 'MEDIUM' | 'HIGH'
    reason: string
    recommendation: string
    callsLast60s: number
    errors429Last60s: number
    errors429Last300s: number
    failoverActivationsLast300s: number
  } | null
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
  const [showMap, setShowMap] = useState(false)
  const [connectingAll, setConnectingAll] = useState(false)
  const [nudgingAll, setNudgingAll] = useState(false)
  const [statusAllLoading, setStatusAllLoading] = useState(false)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsSkillsLoading, setStatsSkillsLoading] = useState(false)
  const [statsDbSummary, setStatsDbSummary] = useState<{
    snapshotCount: number
    profilesWithData: number
    lastSnapshotTs: string | null
    creditsDelta1h: number
    oreDelta1h: number
    tradesDelta1h: number
    systemsDelta1h: number
    events24h: number
  } | null>(null)
  const [statsSkillsByProfile, setStatsSkillsByProfile] = useState<Record<string, Record<string, number> | null>>({})
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return localStorage.getItem('admiral-sidebar-open') !== 'false' } catch { return true }
  })
  const [liveRefreshMs, setLiveRefreshMs] = useState<number>(() => {
    try {
      const raw = localStorage.getItem('admiral-live-refresh-ms')
      const parsed = raw ? parseInt(raw, 10) : 5000
      return parsed === 0 || parsed === 2000 || parsed === 5000 ? parsed : 5000
    } catch {
      return 5000
    }
  })
  const pollSeqRef = useRef(0)
  const appliedPollSeqRef = useRef(0)

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

  // Poll statuses + game state for all profiles in one request
  useEffect(() => {
    let disposed = false
    let inFlight: AbortController | null = null

    async function poll() {
      if (disposed) return
      const seq = ++pollSeqRef.current
      if (inFlight) inFlight.abort()
      const controller = new AbortController()
      inFlight = controller

      try {
        const [profilesResp, statsResp] = await Promise.all([
          fetch('/api/profiles', { signal: controller.signal }),
          fetch('/api/stats/summary', { signal: controller.signal }),
        ])
        if (!profilesResp.ok) return
        const data: Array<Record<string, unknown>> = await profilesResp.json()
        if (disposed) return
        // Ignore out-of-order poll responses to prevent UI status flicker.
        if (seq < appliedPollSeqRef.current) return
        appliedPollSeqRef.current = seq

        const newStatuses: Record<string, RuntimeStatus> = {}
        const newPlayerData: Record<string, Record<string, unknown>> = {}
        for (const p of data) {
          const id = p.id as string
          newStatuses[id] = {
            connected: !!p.connected,
            running: !!p.running,
            adaptive_mode: (p.adaptive_mode as RuntimeStatus['adaptive_mode']) || 'normal',
            mutation_state: (p.mutation_state as RuntimeStatus['mutation_state']) || 'idle',
            mutation_state_detail: typeof p.mutation_state_detail === 'string' ? p.mutation_state_detail : null,
            navigation_state: (p.navigation_state as RuntimeStatus['navigation_state']) || 'unknown',
            navigation_state_detail: typeof p.navigation_state_detail === 'string' ? p.navigation_state_detail : null,
            effective_context_budget_ratio: typeof p.effective_context_budget_ratio === 'number'
              ? p.effective_context_budget_ratio
              : null,
            rate_risk: (p.rate_risk as RuntimeStatus['rate_risk']) || null,
          }
          if (p.gameState && typeof p.gameState === 'object') {
            newPlayerData[id] = p.gameState as Record<string, unknown>
          }
        }
        setProfiles(data as unknown as Profile[])
        setStatuses(newStatuses)
        if (statsResp.ok) {
          const summary = await statsResp.json()
          if (!disposed && seq >= appliedPollSeqRef.current) {
            setStatsDbSummary(summary)
          }
        }
        setPlayerDataMap(prev => {
          const next = { ...prev }
          for (const [id, incoming] of Object.entries(newPlayerData)) {
            const existing = next[id]
            const existingHasFullStatus = !!(existing && typeof existing === 'object' && 'player' in existing)
            const incomingHasFullStatus = !!(incoming && typeof incoming === 'object' && 'player' in incoming)
            // Keep richer get_status payloads instead of replacing them with slim snapshots.
            if (existingHasFullStatus && !incomingHasFullStatus) continue
            next[id] = incoming
          }
          return next
        })
      } catch (err) {
        const isAbort = err instanceof DOMException && err.name === 'AbortError'
        if (!isAbort) {
          // ignore network/parse errors and keep previous status snapshot
        }
      }
    }
    poll()
    if (liveRefreshMs <= 0) {
      return () => {
        disposed = true
        if (inFlight) inFlight.abort()
      }
    }
    const interval = setInterval(poll, liveRefreshMs)
    return () => {
      disposed = true
      if (inFlight) inFlight.abort()
      clearInterval(interval)
    }
  }, [liveRefreshMs])

  const fetchPlayerData = useCallback(async (profileId: string) => {
    try {
      const resp = await fetch(`/api/profiles/${profileId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'get_status' }),
      })
      if (!resp.ok) return
      const result = await resp.json()
      const data = result.structuredContent ?? result.result
      if (data && typeof data === 'object' && ('player' in data || 'ship' in data || 'location' in data)) {
        setPlayerDataMap(prev => ({ ...prev, [profileId]: data as Record<string, unknown> }))
      }
    } catch {
      // ignore
    }
  }, [])

  const refreshProfiles = useCallback(async () => {
    try {
      const resp = await fetch('/api/profiles')
      const data: Array<Record<string, unknown>> = await resp.json()
      const newStatuses: Record<string, RuntimeStatus> = {}
      const newPlayerData: Record<string, Record<string, unknown>> = {}
      for (const p of data) {
        const id = p.id as string
        newStatuses[id] = {
          connected: !!p.connected,
          running: !!p.running,
          adaptive_mode: (p.adaptive_mode as RuntimeStatus['adaptive_mode']) || 'normal',
          effective_context_budget_ratio: typeof p.effective_context_budget_ratio === 'number' ? p.effective_context_budget_ratio : null,
        }
        if (p.gameState && typeof p.gameState === 'object') {
          newPlayerData[id] = p.gameState as Record<string, unknown>
        }
      }
      setProfiles(data as unknown as Profile[])
      setStatuses(newStatuses)
      setPlayerDataMap(prev => {
        const next = { ...prev }
        for (const [id, incoming] of Object.entries(newPlayerData)) {
          const existing = next[id]
          const existingHasFullStatus = !!(existing && typeof existing === 'object' && 'player' in existing)
          const incomingHasFullStatus = !!(incoming && typeof incoming === 'object' && 'player' in incoming)
          if (existingHasFullStatus && !incomingHasFullStatus) continue
          next[id] = incoming
        }
        return next
      })
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
      for (let i = 0; i < targets.length; i++) {
        const p = targets[i]
        const isManual = !p.provider || p.provider === 'manual'
        const action = isManual ? 'connect' : 'connect_llm'
        await fetch(`/api/profiles/${p.id}/connect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        })
        if (i < targets.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 2200))
        }
      }
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

  async function handleGetStatusAll() {
    if (profiles.length === 0) return
    setStatusAllLoading(true)
    try {
      await Promise.allSettled(
        profiles.map(async (p) => {
          if (!statuses[p.id]?.connected) return
          await fetchPlayerData(p.id)
        })
      )
    } finally {
      setStatusAllLoading(false)
    }
  }

  async function handleOpenStats() {
    setShowStats(true)
    setStatsLoading(true)
    setStatsSkillsLoading(true)
    try {
      const [summaryResp, skillsSummaryResp, skillsResults] = await Promise.all([
        fetch('/api/stats/summary'),
        fetch('/api/stats/skills/summary'),
        Promise.allSettled(
          profiles.map(async (profile) => {
            if (!statuses[profile.id]?.connected) return [profile.id, null] as const

            const resp = await fetch(`/api/profiles/${profile.id}/command`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ command: 'get_skills' }),
            })
            if (!resp.ok) return [profile.id, null] as const
            const result = await resp.json()
            return [profile.id, extractSkills(result.structuredContent ?? result.result ?? result)] as const
          })
        ),
      ])

      if (summaryResp.ok) {
        const summary = await summaryResp.json()
        setStatsDbSummary(summary)
      }

      const nextSkillsByProfile: Record<string, Record<string, number> | null> = {}
      if (skillsSummaryResp.ok) {
        const skillsSummary = await skillsSummaryResp.json()
        const rows = Array.isArray(skillsSummary?.profiles) ? skillsSummary.profiles : []
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue
          const profileId = typeof row.profile_id === 'string' ? row.profile_id : null
          const skills = extractSkills(row)
          if (profileId) nextSkillsByProfile[profileId] = skills
        }
      }
      for (const entry of skillsResults) {
        if (entry.status !== 'fulfilled') continue
        nextSkillsByProfile[entry.value[0]] = entry.value[1]
      }
      setStatsSkillsByProfile(nextSkillsByProfile)
      setPlayerDataMap((prev) => {
        const next = { ...prev }
        for (const [profileId, skills] of Object.entries(nextSkillsByProfile)) {
          if (!skills) continue
          next[profileId] = mergeSkillsIntoPlayerData(next[profileId], skills)
        }
        return next
      })
    } finally {
      setStatsLoading(false)
      setStatsSkillsLoading(false)
    }
  }

  async function handleOpenMap() {
    await handleGetStatusAll()
    setShowMap(true)
  }

  const rateRiskProfiles = profiles
    .map((p) => ({ name: p.name, risk: statuses[p.id]?.rate_risk || null }))
    .filter((item) => item.risk && item.risk.level !== 'LOW')
  const highRiskCount = rateRiskProfiles.filter((item) => item.risk?.level === 'HIGH').length
  const mediumRiskCount = rateRiskProfiles.filter((item) => item.risk?.level === 'MEDIUM').length
  const accountSkillOverview = profiles
    .map((profile) => {
      const skills = statsSkillsByProfile[profile.id] || extractSkills(playerDataMap[profile.id]) || null
      const skillEntries = Object.entries(skills || {})
        .filter(([, level]) => typeof level === 'number' && Number.isFinite(level) && level > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      return {
        id: profile.id,
        name: profile.name,
        connected: !!statuses[profile.id]?.connected,
        skillEntries,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  const hasValidProvider = providers.some(p => p.status === 'valid' || p.api_key)

  function handleSetLiveRefresh(ms: number) {
    setLiveRefreshMs(ms)
    try { localStorage.setItem('admiral-live-refresh-ms', String(ms)) } catch { /* ignore */ }
  }

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
          <div className="flex items-center gap-1 border border-border px-1 py-1">
            {([
              { label: 'Live Off', value: 0 },
              { label: 'Live 2s', value: 2000 },
              { label: 'Live 5s', value: 5000 },
            ] as const).map((option) => (
              <button
                key={option.value}
                onClick={() => handleSetLiveRefresh(option.value)}
                className={`px-2 py-1 text-[10px] uppercase tracking-wider transition-colors ${
                  liveRefreshMs === option.value
                    ? 'text-foreground bg-muted'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={`Set live refresh to ${option.label.toLowerCase()}`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            onClick={handleOpenStats}
            className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wider px-2.5 py-1.5 hover:text-foreground transition-colors"
            title="Runtime stats"
          >
            <BarChart3 size={13} />
            Stats
          </button>
          <button
            onClick={handleOpenMap}
            disabled={statusAllLoading}
            className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wider px-2.5 py-1.5 hover:text-foreground transition-colors"
            title="Galaxy map"
          >
            Map
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
            onClick={handleGetStatusAll}
            disabled={statusAllLoading || profiles.length === 0}
            className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wider px-2.5 py-1.5 hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Run get_status for all accounts"
          >
            {statusAllLoading ? 'Loading...' : 'Get Status All'}
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
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-px border-b border-border bg-border">
            <div className="bg-card px-3 py-2">
              <div className="text-[10px] uppercase tracking-[1.2px] text-muted-foreground">Credits 1h</div>
              <div className={`text-sm font-medium ${statsDbSummary && statsDbSummary.creditsDelta1h >= 0 ? 'text-[hsl(var(--smui-green))]' : 'text-[hsl(var(--smui-red))]'}`}>
                {statsDbSummary ? `${statsDbSummary.creditsDelta1h >= 0 ? '+' : ''}${Math.round(statsDbSummary.creditsDelta1h).toLocaleString()}` : '...'}
              </div>
            </div>
            <div className="bg-card px-3 py-2">
              <div className="text-[10px] uppercase tracking-[1.2px] text-muted-foreground">Ore 1h</div>
              <div className={`text-sm font-medium ${statsDbSummary && statsDbSummary.oreDelta1h >= 0 ? 'text-[hsl(var(--smui-green))]' : 'text-[hsl(var(--smui-red))]'}`}>
                {statsDbSummary ? `${statsDbSummary.oreDelta1h >= 0 ? '+' : ''}${Math.round(statsDbSummary.oreDelta1h).toLocaleString()}` : '...'}
              </div>
            </div>
            <div className="bg-card px-3 py-2">
              <div className="text-[10px] uppercase tracking-[1.2px] text-muted-foreground">Trades 1h</div>
              <div className={`text-sm font-medium ${statsDbSummary && statsDbSummary.tradesDelta1h >= 0 ? 'text-[hsl(var(--smui-green))]' : 'text-[hsl(var(--smui-red))]'}`}>
                {statsDbSummary ? `${statsDbSummary.tradesDelta1h >= 0 ? '+' : ''}${Math.round(statsDbSummary.tradesDelta1h).toLocaleString()}` : '...'}
              </div>
            </div>
            <div className="bg-card px-3 py-2">
              <div className="text-[10px] uppercase tracking-[1.2px] text-muted-foreground">429 Risk</div>
              <div className={`text-sm font-medium ${highRiskCount > 0 ? 'text-[hsl(var(--smui-red))]' : mediumRiskCount > 0 ? 'text-[hsl(var(--smui-orange))]' : 'text-[hsl(var(--smui-green))]'}`}>
                {highRiskCount > 0 ? `${highRiskCount} high` : mediumRiskCount > 0 ? `${mediumRiskCount} medium` : 'stable'}
              </div>
            </div>
            <div className="bg-card px-3 py-2">
              <div className="text-[10px] uppercase tracking-[1.2px] text-muted-foreground">Last Snapshot</div>
              <div className="text-sm font-medium text-foreground">
                {statsDbSummary?.lastSnapshotTs ? formatSqliteUtcLocalTime(statsDbSummary.lastSnapshotTs) : 'n/a'}
              </div>
            </div>
          </div>
          {activeProfile ? (
            <div className="flex-1 min-h-0">
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
            </div>
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
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm p-3 sm:p-6" onClick={() => setShowStats(false)}>
          <div className="flex min-h-full items-center justify-center">
          <div className="w-full max-w-6xl max-h-[calc(100vh-1.5rem)] sm:max-h-[calc(100vh-3rem)] overflow-hidden border border-border bg-card shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
              <span className="font-jetbrains text-xs font-semibold tracking-[1.5px] text-primary uppercase">Runtime Stats</span>
              <button onClick={() => setShowStats(false)} className="text-muted-foreground hover:text-foreground transition-colors">
                <X size={14} />
              </button>
            </div>
            <div className="max-h-[calc(100vh-5rem)] overflow-y-auto sm:max-h-[calc(100vh-6.5rem)]">
            <div className="grid gap-0 lg:grid-cols-[320px_minmax(0,1fr)]">
              <div className="px-4 py-3 space-y-2 text-xs border-b border-border lg:border-b-0 lg:border-r">
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
                        <span className="text-muted-foreground">Trades (1h)</span>
                        <span className={statsDbSummary.tradesDelta1h >= 0 ? 'text-[hsl(var(--smui-green))]' : 'text-[hsl(var(--smui-red))]'}>
                          {statsDbSummary.tradesDelta1h >= 0 ? '+' : ''}{Math.round(statsDbSummary.tradesDelta1h).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Systems (1h)</span>
                        <span className={statsDbSummary.systemsDelta1h >= 0 ? 'text-[hsl(var(--smui-green))]' : 'text-[hsl(var(--smui-red))]'}>
                          {statsDbSummary.systemsDelta1h >= 0 ? '+' : ''}{Math.round(statsDbSummary.systemsDelta1h).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Events (24h)</span>
                        <span className="text-foreground">{statsDbSummary.events24h.toLocaleString()}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Last Snapshot</span>
                        <span className="text-foreground">
                          {statsDbSummary.lastSnapshotTs ? formatSqliteUtcLocalDateTime(statsDbSummary.lastSnapshotTs) : 'n/a'}
                        </span>
                      </div>
                    </>
                  )}
                </div>
                <div className="mt-2 border-t border-border/60 pt-2">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-[1.2px] mb-1.5">429 Risk</div>
                  {rateRiskProfiles.length === 0 && (
                    <div className="text-[11px] text-[hsl(var(--smui-green))]">No current elevated risk.</div>
                  )}
                  {rateRiskProfiles.slice(0, 6).map((item) => (
                    <div key={item.name} className="flex items-start justify-between gap-3 py-0.5">
                      <span className="text-muted-foreground">{item.name}</span>
                      <span className={item.risk?.level === 'HIGH' ? 'text-[hsl(var(--smui-red))]' : 'text-[hsl(var(--smui-orange))]'}>
                        {item.risk?.level}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="px-4 py-3">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-[1.2px]">Accounts</div>
                    <div className="text-sm text-foreground">Skills Overview</div>
                  </div>
                  {statsSkillsLoading && (
                    <div className="text-[11px] text-muted-foreground">Loading skills...</div>
                  )}
                </div>
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
                  {accountSkillOverview.map((account) => (
                    <div key={account.id} className="border border-border/80 bg-background/40 px-3 py-3 text-xs">
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <span className="min-w-0 break-words font-medium text-foreground">{account.name}</span>
                        <span className={account.connected ? 'text-[10px] uppercase text-[hsl(var(--smui-green))]' : 'text-[10px] uppercase text-muted-foreground'}>
                          {account.connected ? 'connected' : 'offline'}
                        </span>
                      </div>
                      {account.skillEntries.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {account.skillEntries.map(([skill, level]) => (
                            <span key={skill} className="border border-border bg-card px-2 py-1 text-[10px] uppercase tracking-[1px] text-foreground">
                              {formatSkillLabel(skill)} {level}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="text-[11px] text-muted-foreground">
                          {account.connected ? 'No skill data returned yet.' : 'Skill data only available for connected accounts.'}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          </div>
          </div>
        </div>
      )}

      <GalaxyMapModal
        open={showMap}
        onClose={() => setShowMap(false)}
        gameserverUrl={gameserverUrl}
        profiles={profiles}
        playerDataMap={playerDataMap}
      />

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

function extractSkills(data: unknown): Record<string, number> | null {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  const direct = record.skills
  const nested = record.result && typeof record.result === 'object'
    ? (record.result as Record<string, unknown>).skills
    : null
  const raw = direct && typeof direct === 'object' ? direct : nested && typeof nested === 'object' ? nested : null
  if (!raw) return null

  const skills = Object.entries(raw as Record<string, unknown>)
    .map(([skill, level]) => {
      const numericLevel = typeof level === 'object' && level && 'level' in level
        ? Number((level as Record<string, unknown>).level)
        : Number(level)
      return [skill, numericLevel] as const
    })
    .filter(([, level]) => Number.isFinite(level))
  if (skills.length === 0) return null
  return Object.fromEntries(skills)
}

function formatSkillLabel(skill: string): string {
  return skill
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function mergeSkillsIntoPlayerData(
  existing: Record<string, unknown> | undefined,
  skills: Record<string, number>
): Record<string, unknown> {
  return {
    ...(existing || {}),
    skills: {
      ...((((existing || {}).skills) && typeof (existing || {}).skills === 'object')
        ? ((existing || {}).skills as Record<string, unknown>)
        : {}),
      ...skills,
    },
  }
}

function parseSqliteUtcDate(ts: string): Date {
  const isoLike = ts.includes('T') ? ts : ts.replace(' ', 'T')
  const withZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(isoLike) ? isoLike : `${isoLike}Z`
  return new Date(withZone)
}

function formatSqliteUtcLocalTime(ts: string): string {
  return parseSqliteUtcDate(ts).toLocaleTimeString()
}

function formatSqliteUtcLocalDateTime(ts: string): string {
  return parseSqliteUtcDate(ts).toLocaleString()
}
