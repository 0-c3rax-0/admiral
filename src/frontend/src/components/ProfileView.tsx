
import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Square, Plug, PlugZap, Trash2, Pencil, Check, X, PanelLeft, PanelLeftClose, PanelRightClose, MessageSquare, Save, RotateCcw } from 'lucide-react'
import type { Profile, Provider } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { ModelPicker } from '@/components/ModelPicker'
import { PlayerStatus } from './PlayerStatus'
import { CommandPanel } from './CommandPanel'
import { QuickCommands } from './QuickCommands'
import { LogPane } from './LogPane'
import { SidePane } from './SidePane'
import { MarketBrowserModal } from './MarketBrowserModal'

type CatalogPanelData = {
  type: 'ships' | 'modules' | 'items'
  query: string
  rows: Array<{ title: string; meta: string[]; note: string | null }>
}

/**
 * Parse the rendered text from MCP v2 get_status into structured player data.
 * Format: "username [empire] | Ncr | System\nShip: Name (id) | Hull: cur/max | Shield: cur/max ..."
 */
function parseStatusText(text: string): Record<string, unknown> | null {
  if (!text || typeof text !== 'string') return null
  const lines = text.split('\n')
  if (lines.length < 3) return null

  // Line 1: "username [empire] | 3,078cr | SystemName"
  const line1 = lines[0].match(/^(.+?)\s+\[(.+?)\]\s+\|\s+([\d,]+)cr\s+\|\s+(.+)$/)
  if (!line1) return null

  const credits = parseInt(line1[3].replace(/,/g, ''), 10)
  const systemName = line1[4].trim()

  // Line 2: "Ship: Name (id) | Hull: cur/max | Shield: cur/max (+N/tick) | Armor: N | Speed: N"
  const hull = lines[1].match(/Hull:\s*(\d+)\/(\d+)/)
  const shield = lines[1].match(/Shield:\s*(\d+)\/(\d+)/)

  // Line 3: "Fuel: cur/max | Cargo: cur/max | CPU: cur/max | Power: cur/max"
  const fuel = lines[2].match(/Fuel:\s*(\d+)\/(\d+)/)
  const cargo = lines[2].match(/Cargo:\s*(\d+)\/(\d+)/)
  const cpu = lines[2].match(/CPU:\s*(\d+)\/(\d+)/)
  const power = lines[2].match(/Power:\s*(\d+)\/(\d+)/)

  // Line 4: "Docked at: poi_name" or "At: poi_name"
  let poiName = ''
  for (const line of lines.slice(3)) {
    const docked = line.match(/^Docked at:\s*(.+)/)
    const at = line.match(/^At:\s*(.+)/)
    if (docked) { poiName = docked[1].trim(); break }
    if (at) { poiName = at[1].trim(); break }
  }

  return {
    player: { credits, current_system: systemName, current_poi: poiName },
    ship: {
      hull: hull ? parseInt(hull[1]) : 0,
      max_hull: hull ? parseInt(hull[2]) : 0,
      shield: shield ? parseInt(shield[1]) : 0,
      max_shield: shield ? parseInt(shield[2]) : 0,
      fuel: fuel ? parseInt(fuel[1]) : 0,
      max_fuel: fuel ? parseInt(fuel[2]) : 0,
      cargo_used: cargo ? parseInt(cargo[1]) : 0,
      cargo_capacity: cargo ? parseInt(cargo[2]) : 0,
      cpu_used: cpu ? parseInt(cpu[1]) : 0,
      cpu_capacity: cpu ? parseInt(cpu[2]) : 0,
      power_used: power ? parseInt(power[1]) : 0,
      power_capacity: power ? parseInt(power[2]) : 0,
    },
    location: { system_name: systemName, poi_name: poiName },
  }
}

const CONNECTION_MODE_LABELS: Record<string, string> = {
  http: 'HTTP v1',
  http_v2: 'HTTP v2',
  websocket: 'WS',
  websocket_v2: 'WS v2',
  mcp: 'MCP v1',
  mcp_v2: 'MCP v2',
}

const CONNECTION_MODES: { value: string; label: string }[] = [
  { value: 'http', label: 'HTTP API v1' },
  { value: 'http_v2', label: 'HTTP API v2' },
  { value: 'websocket', label: 'WebSocket' },
  { value: 'websocket_v2', label: 'WebSocket v2' },
  { value: 'mcp', label: 'MCP v1' },
  { value: 'mcp_v2', label: 'MCP v2' },
]

type EditingField = 'name' | 'role' | 'mode' | 'provider' | 'credentials' | null

const AGENT_ROLE_OPTIONS = [
  { value: 'miner', label: 'Miner' },
  { value: 'trader', label: 'Trader' },
  { value: 'scout', label: 'Scout' },
  { value: 'pirate', label: 'Pirate' },
  { value: 'industrialist', label: 'Industrialist' },
  { value: 'generalist', label: 'Generalist' },
]

interface Props {
  profile: Profile
  providers: Provider[]
  status: {
    connected: boolean
    running: boolean
    mutation_state?: 'idle' | 'mutation_pending' | 'navigation_pending' | 'local_stall'
    mutation_state_detail?: string | null
    navigation_state?: 'docked' | 'undocked' | 'at_resource_poi' | 'navigation_pending' | 'local_stall' | 'unknown'
    navigation_state_detail?: string | null
    adaptive_mode?: 'normal' | 'soft' | 'high' | 'critical'
    effective_context_budget_ratio?: number | null
  }
  registrationCode?: string
  playerData: Record<string, unknown> | null
  onPlayerData: (data: Record<string, unknown>) => void
  onDelete: () => void
  onRefresh: () => void
  autoEditName?: boolean
  onAutoEditNameDone?: () => void
  showProfileList?: boolean
  onToggleProfileList?: () => void
}

export function ProfileView({ profile, providers, status, playerData, onPlayerData, onDelete, onRefresh, autoEditName, onAutoEditNameDone, showProfileList, onToggleProfileList }: Props) {
  const [showSidePane, setShowSidePane] = useState(() => {
    try { return localStorage.getItem('admiral-sidepane-open') !== 'false' } catch { return true }
  })
  const [sidePaneWidth, setSidePaneWidth] = useState(288)
  const [connecting, setConnecting] = useState(false)
  const [memoryBusy, setMemoryBusy] = useState(false)
  const [showDirectiveModal, setShowDirectiveModal] = useState(false)
  const [directiveValue, setDirectiveValue] = useState(profile.directive || '')
  const [directiveError, setDirectiveError] = useState<string | null>(null)
  const [directiveSaving, setDirectiveSaving] = useState(false)
  const [showNudgeModal, setShowNudgeModal] = useState(false)
  const [showMarketModal, setShowMarketModal] = useState(false)
  const [catalogPanel, setCatalogPanel] = useState<CatalogPanelData | null>(null)
  const [catalogFilter, setCatalogFilter] = useState('')
  const [nudgeValue, setNudgeValue] = useState('')
  const [nudgeHistoryIndex, setNudgeHistoryIndex] = useState(-1)
  const [nudgePending, setNudgePending] = useState('')
  const nudgeInputRef = useRef<HTMLInputElement>(null)
  const commandInputRef = useRef<HTMLInputElement>(null)
  const resizingRef = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Inline edit state
  const [editing, setEditing] = useState<EditingField>(null)
  const [editName, setEditName] = useState('')
  const [editRole, setEditRole] = useState(profile.agent_role || 'miner')
  const [editProvider, setEditProvider] = useState('')
  const [editModel, setEditModel] = useState('')
  const [editFailoverProvider, setEditFailoverProvider] = useState('')
  const [editFailoverModel, setEditFailoverModel] = useState('')
  const [editContextBudget, setEditContextBudget] = useState<number | null>(null)
  const [editUsername, setEditUsername] = useState('')
  const [editPassword, setEditPassword] = useState('')
  const editNameRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const isManual = !profile.provider || profile.provider === 'manual' || !profile.model
  const availableProviders = ['manual', ...providers.filter(p => p.status === 'valid' || p.api_key).map(p => p.id)]
  const adaptiveMode = status.adaptive_mode || 'normal'
  const mutationState = status.mutation_state || 'idle'
  const mutationStateDetail = status.mutation_state_detail || null
  const navigationState = status.navigation_state || 'unknown'
  const navigationStateDetail = status.navigation_state_detail || null
  const effectiveBudget = typeof status.effective_context_budget_ratio === 'number'
    ? `${Math.round(status.effective_context_budget_ratio * 100)}%`
    : null
  const filteredCatalogRows = useMemo(() => {
    if (!catalogPanel) return []
    const query = catalogFilter.trim().toLowerCase()
    if (!query) return catalogPanel.rows
    return catalogPanel.rows.filter((row) => {
      const haystack = [row.title, ...row.meta, row.note || ''].join(' ').toLowerCase()
      return haystack.includes(query)
    })
  }, [catalogPanel, catalogFilter])

  // Auto-open name edit for new profiles
  useEffect(() => {
    if (autoEditName) {
      setEditing('name')
      setEditName(profile.name)
      onAutoEditNameDone?.()
    }
  }, [autoEditName, profile.name, onAutoEditNameDone])

  // Close popover on outside click
  useEffect(() => {
    if (!editing) return
    function handleMouseDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setEditing(null)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [editing])

  // Close popover on Escape
  useEffect(() => {
    if (!editing) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setEditing(null)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [editing])

  // Focus name input when editing name
  useEffect(() => {
    if (editing === 'name' && editNameRef.current) {
      editNameRef.current.focus()
      editNameRef.current.select()
    }
  }, [editing])

  // Sync directive when profile changes (but not if user has an unsaved draft)
  useEffect(() => {
    const draftKey = `admiral-directive-draft-${profile.id}`
    try {
      const draft = localStorage.getItem(draftKey)
      if (draft !== null) {
        setDirectiveValue(draft)
        setShowDirectiveModal(true)
        return
      }
    } catch { /* ignore */ }
    setDirectiveValue(profile.directive || '')
    setDirectiveError(null)
  }, [profile.id, profile.directive])

  function clearDirectiveDraft() {
    try { localStorage.removeItem(`admiral-directive-draft-${profile.id}`) } catch { /* ignore */ }
  }

  function saveDirectiveDraft(value: string) {
    try { localStorage.setItem(`admiral-directive-draft-${profile.id}`, value) } catch { /* ignore */ }
  }

  async function saveDirective() {
    const trimmed = directiveValue.trim()
    if (trimmed === (profile.directive || '')) {
      clearDirectiveDraft()
      setDirectiveError(null)
      setShowDirectiveModal(false)
      return
    }
    setDirectiveSaving(true)
    setDirectiveError(null)
    try {
      const resp = await fetch(`/api/profiles/${profile.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directive: trimmed }),
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        const message = typeof data?.error === 'string' ? data.error : `Failed to save directive (${resp.status})`
        throw new Error(message)
      }
      setShowDirectiveModal(false)
      clearDirectiveDraft()
      onRefresh()
    } catch (err) {
      setDirectiveError(err instanceof Error ? err.message : String(err))
      setShowDirectiveModal(true)
    } finally {
      setDirectiveSaving(false)
    }
  }

  // Nudge history helpers
  const NUDGE_HISTORY_KEY = `admiral-nudge-history-${profile.id}`
  const MAX_NUDGE_HISTORY = 20

  function getNudgeHistory(): string[] {
    try {
      const raw = localStorage.getItem(NUDGE_HISTORY_KEY)
      return raw ? JSON.parse(raw) : []
    } catch { return [] }
  }

  function pushNudgeHistory(msg: string) {
    const history = getNudgeHistory()
    // Remove duplicates of the same message
    const filtered = history.filter(h => h !== msg)
    filtered.unshift(msg)
    try { localStorage.setItem(NUDGE_HISTORY_KEY, JSON.stringify(filtered.slice(0, MAX_NUDGE_HISTORY))) } catch { /* ignore */ }
  }

  function openNudgeModal() {
    setNudgeValue('')
    setNudgePending('')
    setNudgeHistoryIndex(-1)
    setShowNudgeModal(true)
  }

  async function sendNudge() {
    const trimmed = nudgeValue.trim()
    if (!trimmed) return
    setShowNudgeModal(false)
    pushNudgeHistory(trimmed)
    try {
      await fetch(`/api/profiles/${profile.id}/nudge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed }),
      })
    } catch { /* ignore */ }
  }

  function handleNudgeKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setShowNudgeModal(false)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      sendNudge()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const history = getNudgeHistory()
      if (history.length === 0) return
      if (nudgeHistoryIndex === -1) {
        // Save current input as pending before navigating history
        setNudgePending(nudgeValue)
        setNudgeHistoryIndex(0)
        setNudgeValue(history[0])
      } else if (nudgeHistoryIndex < history.length - 1) {
        const next = nudgeHistoryIndex + 1
        setNudgeHistoryIndex(next)
        setNudgeValue(history[next])
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (nudgeHistoryIndex <= 0) {
        // Restore pending input
        setNudgeHistoryIndex(-1)
        setNudgeValue(nudgePending)
      } else {
        const history = getNudgeHistory()
        const next = nudgeHistoryIndex - 1
        setNudgeHistoryIndex(next)
        setNudgeValue(history[next])
      }
      return
    }
  }

  // Save profile field and optionally reconnect
  async function saveProfileField(data: Partial<Profile>, reconnect?: boolean) {
    try {
      if (reconnect && status.connected) {
        await fetch(`/api/profiles/${profile.id}/connect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'disconnect' }),
        })
      }

      await fetch(`/api/profiles/${profile.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (reconnect) {
        const newProvider = data.provider !== undefined ? data.provider : profile.provider
        const newIsManual = !newProvider || newProvider === 'manual'
        const action = newIsManual ? 'connect' : 'connect_llm'
        await fetch(`/api/profiles/${profile.id}/connect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        })
      }

      onRefresh()
    } catch {
      // ignore
    }
  }

  async function handleSaveName() {
    const trimmed = editName.trim()
    if (!trimmed || trimmed === profile.name) {
      setEditing(null)
      return
    }
    setEditing(null)
    await saveProfileField({ name: trimmed })
  }

  async function handleSaveRole() {
    const nextRole = editRole || 'miner'
    setEditing(null)
    await saveProfileField({ agent_role: nextRole })
  }

  async function handleSelectMode(mode: string) {
    if (mode === profile.connection_mode) {
      setEditing(null)
      return
    }
    setEditing(null)
    await saveProfileField({ connection_mode: mode as Profile['connection_mode'] }, true)
  }

  async function handleSaveProvider() {
    const newProvider = editProvider || null
    const newModel = editProvider === 'manual' ? null : (editModel || null)
    const newFailoverProvider = editFailoverProvider && editFailoverProvider !== 'manual' ? editFailoverProvider : null
    const newFailoverModel = newFailoverProvider ? (editFailoverModel || null) : null
    const providerChanged =
      newProvider !== (profile.provider || null) ||
      newModel !== (profile.model || null) ||
      newFailoverProvider !== (profile.failover_provider || null) ||
      newFailoverModel !== (profile.failover_model || null)
    setEditing(null)
    await saveProfileField({
      provider: newProvider,
      model: newModel,
      failover_provider: newFailoverProvider,
      failover_model: newFailoverModel,
      context_budget: editContextBudget,
    }, providerChanged)
  }

  async function handleSaveCredentials() {
    setEditing(null)
    await saveProfileField({
      username: editUsername || null,
      password: editPassword || null,
    })
  }

  // Fetch player status
  const fetchStatus = useCallback(() => {
    fetch(`/api/profiles/${profile.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'get_status' }),
    })
      .then(r => r.json())
      .then(result => {
        // Prefer structuredContent (JSON) over result (may be text-only for MCP v2)
        const data = result.structuredContent ?? result.result
        if (data && typeof data === 'object' && ('player' in data || 'ship' in data || 'location' in data)) {
          onPlayerData(data as Record<string, unknown>)
        } else if (data && typeof data === 'object' && 'text' in data) {
          // MCP v2 returns rendered text for queries — parse it
          const parsed = parseStatusText(data.text as string)
          if (parsed) onPlayerData(parsed)
        }
      })
      .catch(() => {})
  }, [profile.id, onPlayerData])

  // Reset connection tracking when connection mode changes (forces re-fetch)
  const prevConnected = useRef(false)
  useEffect(() => {
    prevConnected.current = false
  }, [profile.connection_mode])

  // Auto-fetch status when connection becomes active + poll every 60s
  useEffect(() => {
    if (status.connected && !prevConnected.current) {
      const timer = setTimeout(fetchStatus, 1500)
      prevConnected.current = status.connected
      return () => clearTimeout(timer)
    }
    prevConnected.current = status.connected
  }, [status.connected, fetchStatus])

  // Poll status every 60s while connected
  useEffect(() => {
    if (!status.connected) return
    const interval = setInterval(fetchStatus, 60000)
    return () => clearInterval(interval)
  }, [status.connected, fetchStatus])

  // Global keyboard shortcuts (when not in an input)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (editing) return
      if (showDirectiveModal || showNudgeModal) return

      // Enter opens nudge modal (only when agent is running)
      if (e.key === 'Enter' && status.running) {
        e.preventDefault()
        openNudgeModal()
        return
      }

      // / focuses the command input
      if (e.key === '/' && commandInputRef.current) {
        e.preventDefault()
        commandInputRef.current.focus()
        return
      }

      if (e.key.length === 1 && commandInputRef.current) {
        commandInputRef.current.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [editing, showDirectiveModal, showNudgeModal, status.running])

  // Resize handling
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
    const startX = e.clientX
    const startWidth = sidePaneWidth

    function onMouseMove(e: MouseEvent) {
      if (!resizingRef.current) return
      const delta = startX - e.clientX
      const newWidth = Math.max(200, Math.min(600, startWidth + delta))
      setSidePaneWidth(newWidth)
    }

    function onMouseUp() {
      resizingRef.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [sidePaneWidth])

  async function handleConnect(e: React.MouseEvent) {
    if (e.shiftKey) {
      await fetch(`/api/profiles/${profile.id}/logs`, { method: 'DELETE' })
    }
    setConnecting(true)
    try {
      const action = isManual ? 'connect' : 'connect_llm'
      await fetch(`/api/profiles/${profile.id}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      onRefresh()
    } finally {
      setConnecting(false)
    }
  }

  async function handleDisconnect() {
    await fetch(`/api/profiles/${profile.id}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'disconnect' }),
    })
    onRefresh()
  }

  async function handleSaveMemory() {
    setMemoryBusy(true)
    try {
      const resp = await fetch(`/api/profiles/${profile.id}/memory/save`, { method: 'POST' })
      const data = await resp.json().catch(() => ({} as Record<string, unknown>))
      if ((data as { saved?: boolean }).saved === false) {
        window.alert('No summary available yet. Let the agent run a bit longer, then try Save Memory again.')
      }
    } finally {
      setMemoryBusy(false)
    }
  }

  async function handleResetMemory() {
    if (!window.confirm('Reset persistent memory for this profile?')) return
    setMemoryBusy(true)
    try {
      await fetch(`/api/profiles/${profile.id}/memory`, { method: 'DELETE' })
    } finally {
      setMemoryBusy(false)
    }
  }

  const handleSendCommand = useCallback(async (command: string, args?: Record<string, unknown>) => {
    try {
      const resp = await fetch(`/api/profiles/${profile.id}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, args }),
      })
      const result = await resp.json()

      if (command === 'catalog') {
        setCatalogPanel(buildCatalogPanelData(result, args))
        setCatalogFilter('')
      } else if (command === 'shipyard_showroom' || command === 'browse_ships') {
        setCatalogPanel(buildCatalogPanelData(result, { type: 'ships' }))
        setCatalogFilter('')
      }

      if (command === 'get_status') {
        const data = result.structuredContent ?? result.result
        if (data && typeof data === 'object' && ('player' in data || 'ship' in data || 'location' in data)) {
          onPlayerData(data as Record<string, unknown>)
        } else if (data && typeof data === 'object' && 'text' in data) {
          const parsed = parseStatusText(data.text as string)
          if (parsed) onPlayerData(parsed)
        }
      } else if (command === 'get_skills') {
        const data = result.structuredContent ?? result.result ?? result
        const skills = extractCommandSkills(data)
        if (skills) onPlayerData({ skills })
      }
    } catch {
      // Error logged by agent
    }
  }, [profile.id, onPlayerData])

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div data-tour="navbar" className="flex items-center gap-3 h-12 px-3.5 bg-card border-b border-border select-none">
        {onToggleProfileList && (
          <button
            onClick={onToggleProfileList}
            className="flex items-center px-2 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
            title={showProfileList ? 'Hide profiles' : 'Show profiles'}
          >
            {showProfileList ? <PanelLeftClose size={14} /> : <PanelLeft size={14} />}
          </button>
        )}
        <div className={`status-dot ${
          status.running ? 'status-dot-green' :
          status.connected ? 'status-dot-orange' :
          'status-dot-grey'
        }`} />

        {/* Editable profile name */}
        <div className="relative" data-tour="profile-name">
          <h2
            className="text-sm font-semibold text-foreground tracking-wide cursor-pointer hover:text-primary transition-colors"
            onClick={() => { setEditing('name'); setEditName(profile.name) }}
          >
            {profile.name}
          </h2>
          {editing === 'name' && (
            <div ref={popoverRef} className="absolute z-50 top-full left-0 mt-1.5 bg-card border border-border shadow-lg p-2.5 min-w-[220px]">
              <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] block mb-1.5">Profile Name</span>
              <div className="flex gap-1.5">
                <Input
                  ref={editNameRef}
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleSaveName()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                  className="h-7 text-xs"
                />
                <Button variant="ghost" size="icon" onClick={handleSaveName} className="h-7 w-7 shrink-0 text-[hsl(var(--smui-green))] hover:bg-[hsl(var(--smui-green)/0.1)]">
                  <Check size={13} />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => setEditing(null)} className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground">
                  <X size={13} />
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="relative">
          <span
            className="text-[10px] text-[hsl(var(--smui-green))] uppercase tracking-[1.5px] px-2 py-0.5 border border-[hsl(var(--smui-green)/0.35)] cursor-pointer hover:bg-[hsl(var(--smui-green)/0.08)] transition-colors"
            onClick={() => {
              setEditing('role')
              setEditRole(profile.agent_role || 'miner')
            }}
          >
            role:{profile.agent_role || 'miner'}
          </span>
          {editing === 'role' && (
            <div ref={popoverRef} className="absolute z-50 top-full left-0 mt-1.5 bg-card border border-border shadow-lg p-2.5 min-w-[180px]">
              <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] block mb-1.5">Agent Role</span>
              <Select value={editRole} onChange={e => setEditRole(e.target.value)} className="h-7 text-xs">
                {AGENT_ROLE_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
              <div className="flex justify-end gap-1.5 pt-2">
                <Button variant="ghost" size="sm" onClick={() => setEditing(null)} className="h-6 text-[10px] px-2">
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSaveRole} className="h-6 text-[10px] px-2 bg-primary text-primary-foreground hover:bg-primary/90">
                  Save
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Player color swatch + Editable @username / credentials */}
        {playerData && (playerData.player as Record<string, unknown>)?.color_primary ? (
          <svg width="12" height="12" viewBox="0 0 12 12" className="shrink-0">
            <polygon points="0,0 12,0 0,12" fill={(playerData.player as Record<string, unknown>).color_primary as string} />
            <polygon points="12,0 12,12 0,12" fill={(playerData.player as Record<string, unknown>).color_secondary as string || (playerData.player as Record<string, unknown>).color_primary as string} />
          </svg>
        ) : null}
        <div className="relative" data-tour="credentials">
          <span
            className={`text-[11px] cursor-pointer transition-colors ${
              profile.username
                ? 'text-muted-foreground hover:text-foreground'
                : 'text-muted-foreground/40 italic hover:text-muted-foreground'
            }`}
            onClick={() => {
              setEditing('credentials')
              setEditUsername(profile.username || '')
              setEditPassword(profile.password || '')
            }}
          >
            {profile.username ? `@${profile.username}` : '@credentials'}
          </span>
          {editing === 'credentials' && (
            <div ref={popoverRef} className="absolute z-50 top-full left-0 mt-1.5 bg-card border border-border shadow-lg p-2.5 min-w-[280px]">
              <span className="text-[10px] text-[hsl(var(--smui-orange))] uppercase tracking-[1.5px] block mb-2">SpaceMolt Credentials</span>
              <div className="space-y-2">
                <div>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] block mb-1">Username</span>
                  <Input
                    value={editUsername}
                    onChange={e => setEditUsername(e.target.value)}
                    placeholder="(new player)"
                    className="h-7 text-xs"
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleSaveCredentials()
                      if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                </div>
                <div>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] block mb-1">Password</span>
                  <Input
                    type="password"
                    value={editPassword}
                    onChange={e => setEditPassword(e.target.value)}
                    placeholder="256-bit hex"
                    className="h-7 text-xs"
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleSaveCredentials()
                      if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                </div>
                <div className="flex justify-end gap-1.5 pt-1 border-t border-border/50">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(null)} className="h-6 text-[10px] px-2">
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleSaveCredentials} className="h-6 text-[10px] px-2 bg-primary text-primary-foreground hover:bg-primary/90">
                    Save
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
        {profile.stats_delta_1h && (
          <div className="flex items-center gap-3 text-[10px] tracking-[1.2px] uppercase">
            <span className={profile.stats_delta_1h.credits >= 0 ? 'text-[hsl(var(--smui-green))]' : 'text-[hsl(var(--smui-red))]'}>
              1h credits {profile.stats_delta_1h.credits >= 0 ? '+' : ''}{Math.round(profile.stats_delta_1h.credits).toLocaleString()}
            </span>
            <span className={profile.stats_delta_1h.ore_mined >= 0 ? 'text-[hsl(var(--smui-green))]' : 'text-[hsl(var(--smui-red))]'}>
              ore {profile.stats_delta_1h.ore_mined >= 0 ? '+' : ''}{Math.round(profile.stats_delta_1h.ore_mined).toLocaleString()}
            </span>
          </div>
        )}

        {/* Editable connection mode */}
        <div className="relative" data-tour="connection-mode">
          <span
            className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] px-2 py-0.5 border border-border cursor-pointer hover:border-primary/40 hover:text-foreground transition-colors"
            onClick={() => setEditing('mode')}
          >
            {CONNECTION_MODE_LABELS[profile.connection_mode] || profile.connection_mode}
          </span>
          {editing === 'mode' && (
            <div ref={popoverRef} className="absolute z-50 top-full left-0 mt-1.5 bg-card border border-border shadow-lg min-w-[180px]">
              <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] block px-3 pt-2 pb-1">Connection Mode</span>
              {CONNECTION_MODES.map(m => (
                <button
                  key={m.value}
                  onClick={() => handleSelectMode(m.value)}
                  className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 ${
                    m.value === profile.connection_mode
                      ? 'text-primary bg-primary/5'
                      : 'text-foreground hover:bg-primary/10'
                  }`}
                >
                  <div className={`w-3 h-3 border flex items-center justify-center shrink-0 ${
                    m.value === profile.connection_mode ? 'border-primary' : 'border-border bg-background'
                  }`}>
                    {m.value === profile.connection_mode && <div className="w-1.5 h-1.5 bg-primary" />}
                  </div>
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Editable provider/model */}
        {!isManual && profile.provider && (
          <div className="relative" data-tour="provider-model">
            <span
              className="text-[10px] text-[hsl(var(--smui-purple))] cursor-pointer hover:text-foreground transition-colors"
              onClick={() => {
                setEditing('provider')
                setEditProvider(profile.provider || '')
                setEditModel(profile.model || '')
                setEditFailoverProvider(profile.failover_provider || '')
                setEditFailoverModel(profile.failover_model || '')
                setEditContextBudget(profile.context_budget ?? null)
              }}
            >
              {profile.provider}/{profile.model}
              {profile.failover_provider && profile.failover_model && (
                <span className="text-muted-foreground/60 ml-1.5">
                  failover:{profile.failover_provider}/{profile.failover_model}
                </span>
              )}
              <span className="text-muted-foreground/60 ml-1.5">
                budget:{profile.context_budget != null && !isNaN(profile.context_budget) ? `${Math.round(profile.context_budget * 100)}%` : '55%'}
              </span>
              {status.running && (
                <span className="text-muted-foreground/60 ml-1.5">
                  mem:{adaptiveMode}{effectiveBudget ? `:${effectiveBudget}` : ''}
                </span>
              )}
              {mutationState !== 'idle' && (
                <span
                  className={`ml-1.5 ${
                    mutationState === 'local_stall'
                      ? 'text-[hsl(var(--smui-orange))]'
                      : 'text-muted-foreground/70'
                  }`}
                  title={mutationStateDetail || mutationState}
                >
                  state:{mutationState}
                </span>
              )}
              {navigationState !== 'unknown' && (
                <span className="text-muted-foreground/60 ml-1.5" title={navigationStateDetail || navigationState}>
                  nav:{navigationState}
                </span>
              )}
            </span>
            {editing === 'provider' && (
              <div ref={popoverRef} className="absolute z-50 top-full left-0 mt-1.5 bg-card border border-border shadow-lg p-2.5 min-w-[300px]">
                <div className="space-y-2">
                  <div>
                    <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] block mb-1">Provider</span>
                    <Select value={editProvider} onChange={e => { setEditProvider(e.target.value); setEditModel('') }} className="h-7 text-xs">
                      <option value="">Choose...</option>
                      {availableProviders.map(p => <option key={p} value={p}>{p === 'manual' ? 'Manual (no LLM)' : p}</option>)}
                    </Select>
                  </div>
                  {editProvider && editProvider !== 'manual' && (
                    <div>
                      <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] block mb-1">Model</span>
                      <ModelPicker provider={editProvider} value={editModel} onChange={setEditModel} />
                    </div>
                  )}
                  {editProvider && editProvider !== 'manual' && (
                    <div>
                      <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] block mb-1">Failover Provider</span>
                      <Select
                        value={editFailoverProvider}
                        onChange={e => { setEditFailoverProvider(e.target.value); setEditFailoverModel('') }}
                        className="h-7 text-xs"
                      >
                        <option value="">None</option>
                        {availableProviders.filter(p => p !== 'manual').map(p => <option key={p} value={p}>{p}</option>)}
                      </Select>
                    </div>
                  )}
                  {editFailoverProvider && (
                    <div>
                      <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] block mb-1">Failover Model</span>
                      <ModelPicker provider={editFailoverProvider} value={editFailoverModel} onChange={setEditFailoverModel} />
                    </div>
                  )}
                  {editProvider && editProvider !== 'manual' && (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px]">Context Budget</span>
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {editContextBudget !== null ? `${Math.round(editContextBudget * 100)}%` : '55% (default)'}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={5}
                        max={90}
                        step={5}
                        value={editContextBudget !== null ? Math.round(editContextBudget * 100) : 55}
                        onChange={e => {
                          const v = parseInt(e.target.value, 10)
                          setEditContextBudget(v === 55 ? null : v / 100)
                        }}
                        className="w-full h-1.5 accent-[hsl(var(--smui-purple))] cursor-pointer"
                      />
                      <div className="flex justify-between text-[9px] text-muted-foreground/50 mt-0.5">
                        <span>5% (small/local)</span>
                        <span>90% (large context)</span>
                      </div>
                    </div>
                  )}
                  <div className="flex justify-end gap-1.5 pt-1 border-t border-border/50">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(null)} className="h-6 text-[10px] px-2">
                      Cancel
                    </Button>
                    <Button size="sm" onClick={handleSaveProvider} className="h-6 text-[10px] px-2 bg-primary text-primary-foreground hover:bg-primary/90">
                      Save
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Show clickable provider/model area when manual or no provider set */}
        {(isManual || !profile.provider) && (
          <div className="relative" data-tour="provider-model">
            <span
              className="text-[10px] text-muted-foreground/50 italic cursor-pointer hover:text-foreground transition-colors"
              onClick={() => {
                setEditing('provider')
                setEditProvider(profile.provider || '')
                setEditModel(profile.model || '')
                setEditFailoverProvider(profile.failover_provider || '')
                setEditFailoverModel(profile.failover_model || '')
                setEditContextBudget(profile.context_budget ?? null)
              }}
            >
              {isManual && profile.provider ? 'manual' : 'no provider'}
            </span>
            {editing === 'provider' && (
              <div ref={popoverRef} className="absolute z-50 top-full left-0 mt-1.5 bg-card border border-border shadow-lg p-2.5 min-w-[300px]">
                <div className="space-y-2">
                  <div>
                    <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] block mb-1">Provider</span>
                    <Select value={editProvider} onChange={e => { setEditProvider(e.target.value); setEditModel('') }} className="h-7 text-xs">
                      <option value="">Choose...</option>
                      {availableProviders.map(p => <option key={p} value={p}>{p === 'manual' ? 'Manual (no LLM)' : p}</option>)}
                    </Select>
                  </div>
                  {editProvider && editProvider !== 'manual' && (
                    <div>
                      <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] block mb-1">Model</span>
                      <ModelPicker provider={editProvider} value={editModel} onChange={setEditModel} />
                    </div>
                  )}
                  {editProvider && editProvider !== 'manual' && (
                    <div>
                      <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] block mb-1">Failover Provider</span>
                      <Select
                        value={editFailoverProvider}
                        onChange={e => { setEditFailoverProvider(e.target.value); setEditFailoverModel('') }}
                        className="h-7 text-xs"
                      >
                        <option value="">None</option>
                        {availableProviders.filter(p => p !== 'manual').map(p => <option key={p} value={p}>{p}</option>)}
                      </Select>
                    </div>
                  )}
                  {editFailoverProvider && (
                    <div>
                      <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] block mb-1">Failover Model</span>
                      <ModelPicker provider={editFailoverProvider} value={editFailoverModel} onChange={setEditFailoverModel} />
                    </div>
                  )}
                  {editProvider && editProvider !== 'manual' && (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px]">Context Budget</span>
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {editContextBudget !== null ? `${Math.round(editContextBudget * 100)}%` : '55% (default)'}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={5}
                        max={90}
                        step={5}
                        value={editContextBudget !== null ? Math.round(editContextBudget * 100) : 55}
                        onChange={e => {
                          const v = parseInt(e.target.value, 10)
                          setEditContextBudget(v === 55 ? null : v / 100)
                        }}
                        className="w-full h-1.5 accent-[hsl(var(--smui-purple))] cursor-pointer"
                      />
                      <div className="flex justify-between text-[9px] text-muted-foreground/50 mt-0.5">
                        <span>5% (small/local)</span>
                        <span>90% (large context)</span>
                      </div>
                    </div>
                  )}
                  <div className="flex justify-end gap-1.5 pt-1 border-t border-border/50">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(null)} className="h-6 text-[10px] px-2">
                      Cancel
                    </Button>
                    <Button size="sm" onClick={handleSaveProvider} className="h-6 text-[10px] px-2 bg-primary text-primary-foreground hover:bg-primary/90">
                      Save
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex-1" />

        <Button
          variant="ghost"
          size="sm"
          onClick={handleSaveMemory}
          disabled={memoryBusy}
          className="gap-1.5 h-7 text-[10px] text-muted-foreground hover:text-foreground"
          title="Save persistent memory"
        >
          <Save size={12} />
          Save Memory
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleResetMemory}
          disabled={memoryBusy}
          className="gap-1.5 h-7 text-[10px] text-muted-foreground hover:text-destructive"
          title="Reset persistent memory"
        >
          <RotateCcw size={12} />
          Reset Memory
        </Button>

        {!status.connected ? (
          <Button
            data-tour="connect-btn"
            variant="outline"
            size="sm"
            onClick={handleConnect}
            disabled={connecting}
            className="gap-1.5 font-semibold text-[hsl(var(--smui-green))] border-[hsl(var(--smui-green)/0.4)] hover:bg-[hsl(var(--smui-green)/0.1)]"
          >
            {connecting ? <PlugZap size={12} className="animate-pulse" /> : <Plug size={12} />}
            {connecting ? 'Connecting...' : (isManual ? 'Connect' : 'Connect + Start')}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={handleDisconnect}
            className="gap-1.5 font-semibold text-destructive border-destructive/40 hover:bg-destructive/10"
          >
            <Square size={12} />
            Disconnect
          </Button>
        )}

        <Button variant="ghost" size="icon" onClick={() => { if (window.confirm('Delete this profile and all its logs?')) onDelete() }} className="h-7 w-7 text-muted-foreground hover:text-destructive ml-1">
          <Trash2 size={14} />
        </Button>
      </div>

      {/* Directive */}
      <div
        data-tour="directive"
        className="flex items-center gap-2 px-3.5 py-1.5 bg-card border-b border-border cursor-pointer group"
        onClick={() => {
          let initial = profile.directive || ''
          try {
            const draft = localStorage.getItem(`admiral-directive-draft-${profile.id}`)
            if (draft !== null) initial = draft
          } catch { /* ignore */ }
          setDirectiveValue(initial)
          setShowDirectiveModal(true)
        }}
      >
        <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] shrink-0">Directive</span>
        <span className={`text-xs truncate flex-1 min-w-0 ${profile.directive ? 'text-foreground/80' : 'text-muted-foreground/50 italic'}`}>
          {profile.directive || 'No directive set -- click to edit'}
        </span>
        <Pencil size={10} className="shrink-0 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors" />
      </div>

      {/* Player status */}
      <PlayerStatus data={playerData} />

      {/* Quick commands + side pane toggle */}
      <QuickCommands
        onSend={handleSendCommand}
        onOpenMarkets={() => setShowMarketModal(true)}
        disabled={!status.connected}
        showSidePane={showSidePane}
        onToggleSidePane={() => setShowSidePane(v => { const next = !v; try { localStorage.setItem('admiral-sidepane-open', String(next)) } catch {}; return next })}
        onNudge={openNudgeModal}
        running={status.running}
      />

      {catalogPanel && (
        <div className="border-b border-border bg-card/70 px-3.5 py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[1.4px] text-muted-foreground">Catalog View</div>
              <div className="text-xs text-foreground">
                {catalogPanel.type}{catalogPanel.query ? ` - ${catalogPanel.query}` : ''}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={catalogFilter}
                onChange={e => setCatalogFilter(e.target.value)}
                placeholder="Filter catalog..."
                className="h-7 w-40 text-[11px]"
              />
              <Button variant="ghost" size="sm" onClick={() => { setCatalogPanel(null); setCatalogFilter('') }} className="h-6 px-2 text-[10px] text-muted-foreground">
                Clear
              </Button>
            </div>
          </div>
          <div className="mb-2 text-[10px] uppercase tracking-[1.1px] text-muted-foreground">
            {filteredCatalogRows.length} shown{catalogPanel.rows.length !== filteredCatalogRows.length ? ` of ${catalogPanel.rows.length}` : ''}
          </div>
          <div className="max-h-[28rem] overflow-y-auto pr-1">
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {filteredCatalogRows.map((row, index) => (
                <div key={`${row.title}-${index}`} className="border border-border bg-background/50 px-3 py-2.5">
                  <div className="text-[12px] text-foreground">{row.title}</div>
                  {row.meta.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {row.meta.map((item, itemIndex) => (
                        <span key={`${item}-${itemIndex}`} className="border border-border bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-[0.8px] text-muted-foreground">
                          {item}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {row.note ? (
                    <div className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{row.note}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
          {filteredCatalogRows.length === 0 && (
            <div className="mt-2 text-[11px] text-muted-foreground">No catalog entries match the current filter.</div>
          )}
        </div>
      )}

      {/* Log pane + side pane */}
      <div ref={containerRef} className="flex flex-1 min-h-0">
        <div data-tour="log-pane" className="flex-1 min-w-0">
          <LogPane profileId={profile.id} profileName={profile.name} connected={status.connected} />
        </div>
        {showSidePane && (
          <>
            {/* Resize handle */}
            <div
              onMouseDown={handleResizeStart}
              className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/40 transition-colors"
            />
            <div data-tour="side-pane" style={{ width: sidePaneWidth }} className="shrink-0">
              <SidePane key={profile.id} profileId={profile.id} todo={profile.todo} connected={status.connected} playerData={playerData} onRefreshStatus={fetchStatus} />
            </div>
          </>
        )}
      </div>

      {/* Manual command input */}
      <CommandPanel profileId={profile.id} onSend={handleSendCommand} disabled={!status.connected} commandInputRef={commandInputRef} serverUrl={profile.server_url} connectionMode={profile.connection_mode} />

      <MarketBrowserModal
        open={showMarketModal}
        connected={status.connected}
        profileId={profile.id}
        onClose={() => setShowMarketModal(false)}
      />

      {/* Directive modal */}
      {showDirectiveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" onClick={() => { clearDirectiveDraft(); setDirectiveValue(profile.directive || ''); setDirectiveError(null); setShowDirectiveModal(false) }}>
          <div className="bg-card border border-border shadow-lg w-full max-w-lg mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <span className="font-jetbrains text-xs font-semibold tracking-[1.5px] text-primary uppercase">Agent Directive</span>
              <button onClick={() => { clearDirectiveDraft(); setDirectiveValue(profile.directive || ''); setDirectiveError(null); setShowDirectiveModal(false) }} className="text-muted-foreground hover:text-foreground transition-colors">
                <X size={14} />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-[11px] text-muted-foreground">
                Tell your AI agent what to do. This directive is sent every turn to guide autonomous behavior.
              </p>
              {directiveError && (
                <div className="border border-[hsl(var(--smui-red))]/40 bg-[hsl(var(--smui-red))]/10 px-3 py-2 text-[11px] text-[hsl(var(--smui-red))]">
                  {directiveError}
                </div>
              )}
              <textarea
                ref={el => {
                  if (el) {
                    el.focus()
                    el.style.height = 'auto'
                    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.7) + 'px'
                  }
                }}
                value={directiveValue}
                onChange={e => {
                  setDirectiveValue(e.target.value)
                  saveDirectiveDraft(e.target.value)
                  const ta = e.target
                  ta.style.height = 'auto'
                  ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.7) + 'px'
                }}
                onKeyDown={e => {
                  if (e.key === 'Escape') { clearDirectiveDraft(); setDirectiveValue(profile.directive || ''); setShowDirectiveModal(false) }
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveDirective() }
                }}
                placeholder={"e.g. Mine ore and sell it until you can buy a better ship.\nExplore unknown systems and record what you find.\nBecome a pirate -- attack traders and loot their cargo."}
                className="w-full bg-background border border-border px-3 py-2 text-xs text-foreground outline-none focus:border-primary/40 resize-y min-h-[80px] max-h-[70vh] placeholder:text-muted-foreground/40 overflow-auto"
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => { clearDirectiveDraft(); setDirectiveValue(profile.directive || ''); setDirectiveError(null); setShowDirectiveModal(false) }} className="h-7 text-[11px] px-3">
                  Cancel
                </Button>
                <Button size="sm" onClick={saveDirective} disabled={directiveSaving} className="h-7 text-[11px] px-3 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                  {directiveSaving ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Nudge modal */}
      {showNudgeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" onClick={() => setShowNudgeModal(false)}>
          <div className="bg-card border border-border shadow-lg w-full max-w-lg mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <MessageSquare size={13} className="text-primary" />
                <span className="font-jetbrains text-xs font-semibold tracking-[1.5px] text-primary uppercase">Nudge Agent</span>
              </div>
              <button onClick={() => setShowNudgeModal(false)} className="text-muted-foreground hover:text-foreground transition-colors">
                <X size={14} />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-[11px] text-muted-foreground">
                Send a one-time hint to your agent. This is injected into the conversation without changing the directive.
              </p>
              <input
                ref={nudgeInputRef}
                autoFocus
                type="text"
                value={nudgeValue}
                onChange={e => {
                  setNudgeValue(e.target.value)
                  // Reset history position when user types
                  if (nudgeHistoryIndex !== -1) {
                    setNudgeHistoryIndex(-1)
                    setNudgePending('')
                  }
                }}
                onKeyDown={handleNudgeKeyDown}
                placeholder="e.g. sell your ore before exploring further"
                className="w-full bg-background border border-border px-3 py-2 text-xs text-foreground outline-none focus:border-primary/40 placeholder:text-muted-foreground/40"
              />
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground/50">
                  {getNudgeHistory().length > 0
                    ? `${nudgeHistoryIndex >= 0 ? `${nudgeHistoryIndex + 1}/` : ''}${getNudgeHistory().length} in history, use \u2191/\u2193 to select`
                    : ''}
                </span>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setShowNudgeModal(false)} className="h-7 text-[11px] px-3">
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={sendNudge}
                    disabled={!nudgeValue.trim()}
                    className="h-7 text-[11px] px-3 bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    Send
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function extractCommandSkills(data: unknown): Record<string, number> | null {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  const candidates = [
    record.skills,
    record.result && typeof record.result === 'object' ? (record.result as Record<string, unknown>).skills : null,
  ]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const skills = Object.entries(candidate as Record<string, unknown>)
      .map(([skill, level]) => {
        const numericLevel = typeof level === 'object' && level && 'level' in level
          ? Number((level as Record<string, unknown>).level)
          : Number(level)
        return [skill, numericLevel] as const
      })
      .filter(([, level]) => Number.isFinite(level))
    if (skills.length > 0) return Object.fromEntries(skills)
  }
  return null
}

function buildCatalogPanelData(result: unknown, args?: Record<string, unknown>): CatalogPanelData | null {
  if (!result || typeof result !== 'object') return null
  const root = result as Record<string, unknown>
  const payload = root.structuredContent ?? root.result ?? root
  if (!payload || typeof payload !== 'object') return null
  const data = payload as Record<string, unknown>
  const nested = (data.result && typeof data.result === 'object') ? data.result as Record<string, unknown> : null

  const query = typeof args?.search === 'string'
    ? args.search.trim()
    : typeof args?.type === 'string'
      ? args.type.trim()
      : ''

  const ships = extractCatalogRows(
    data.ships ?? data.listings ?? data.offers ?? data.items ?? nested?.ships ?? nested?.items
  )
  if (ships.length > 0) {
    return {
      type: 'ships',
      query,
      rows: ships.map((record) => ({
        title: pickCatalogLabel(record.name, record.ship_name, record.class_name, record.ship_class, record.class_id),
        meta: [
          pickCatalogString(record.category, record.ship_category, record.role),
          formatCatalogPrice(record.commission_quote ?? record.quote_price ?? record.price ?? record.cost),
          formatCatalogMaterials(record.build_material_requirements ?? record.material_requirements ?? record.build_materials),
          formatCatalogSkills(record.required_skills ?? record.skill_requirements ?? record.skills_required),
        ].filter(Boolean) as string[],
        note: pickCatalogString(record.lore, record.description, record.flavor_text),
      })),
    }
  }

  const modules = extractCatalogRows(data.modules ?? nested?.modules)
  if (modules.length > 0) {
    return {
      type: 'modules',
      query,
      rows: modules.map((record) => ({
        title: pickCatalogLabel(record.name, record.module_name, record.item_id, record.id),
        meta: [
          formatCatalogStat('reach', record.combat_reach ?? record.range ?? record.weapon_range),
          formatCatalogStat('ammo', record.ammo_type ?? record.ammo ?? record.ammunition_type),
          formatCatalogStat('accuracy', record.accuracy_bonus ?? record.hit_bonus ?? record.precision_bonus),
          formatCatalogStat('survey', record.survey_power ?? record.scan_power),
          formatCatalogSkills(record.required_skills ?? record.skill_requirements ?? record.skills_required),
        ].filter(Boolean) as string[],
        note: pickCatalogString(record.description, record.lore),
      })),
    }
  }

  const items = extractCatalogRows(data.items ?? nested?.items)
  if (items.length > 0) {
    return {
      type: 'items',
      query,
      rows: items
        .map((record) => {
          const warnings = [
            ...catalogArray(record.hazardous_material_warnings),
            ...catalogArray(record.hazard_warnings),
            ...catalogArray(record.warnings),
          ]
            .map((value) => typeof value === 'string' ? value.trim() : '')
            .filter(Boolean)
          const meta = [
            pickCatalogString(record.category, record.type, record.item_type, record.subtype),
            pickCatalogString(record.rarity, record.tier, record.grade),
            warnings.length > 0 ? 'hazardous' : null,
          ].filter(Boolean) as string[]
          return {
            title: pickCatalogLabel(record.name, record.item_name, record.item_id, record.id),
            meta,
            note: warnings.length > 0 ? warnings.join(' | ') : pickCatalogString(record.description),
          }
        })
        .filter((row) => row.title || row.note),
    }
  }

  return null
}

function extractCatalogRows(value: unknown): Array<Record<string, unknown>> {
  return catalogArray(value).filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
}

function catalogArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function pickCatalogString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

function pickCatalogLabel(...values: unknown[]): string {
  return pickCatalogString(...values) || 'Unknown entry'
}

function formatCatalogStat(label: string, value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return `${label} ${value}`
  if (typeof value === 'string' && value.trim()) return `${label} ${value.trim()}`
  return null
}

function formatCatalogPrice(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value} cr`
  if (typeof value === 'string' && value.trim()) return `${value.trim()} cr`
  return null
}

function formatCatalogSkills(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const skills = Object.entries(value as Record<string, unknown>)
    .map(([skill, level]) => {
      const normalized =
        typeof level === 'object' && level && 'level' in (level as Record<string, unknown>)
          ? (level as Record<string, unknown>).level
          : level
      if (typeof normalized !== 'number' && typeof normalized !== 'string') return null
      return `${skill} ${normalized}`
    })
    .filter((entry): entry is string => Boolean(entry))
  return skills.length > 0 ? skills.slice(0, 3).join(', ') : null
}

function formatCatalogMaterials(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const materials = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const record = entry as Record<string, unknown>
      const name = pickCatalogString(record.name, record.item_name, record.material_name, record.item_id, record.id)
      if (!name) return null
      const quantity = pickCatalogString(record.quantity, record.amount, record.count)
      return `${name}${quantity ? ` x${quantity}` : ''}`
    })
    .filter((entry): entry is string => Boolean(entry))
  return materials.length > 0 ? `build ${materials.slice(0, 3).join(', ')}` : null
}
