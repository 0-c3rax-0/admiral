import { complete } from '@mariozechner/pi-ai'
import type { Context } from '@mariozechner/pi-ai'
import {
  addLogEntry,
  createSupervisorRun,
  getLogEntries,
  getPreference,
  listProfiles,
  markSupervisorRunFailed,
  recordSupervisorRunResponse,
  markSupervisorRunSucceeded,
} from './db'
import { agentManager } from './agent-manager'
import { resolveModel } from './model'
import type { MutationState, NavigationState } from './agent'
import { createGameConnection } from './game-connection'
import { fetchGameCommands, parseRuntimeCommandResult, type GameCommandInfo } from './schema'
import type { Profile } from '../../shared/types'
import {
  applyCommissionQuotes,
  dedupeShipOffers,
  extractShipOffers,
  extractModuleDetails,
  formatRequiredSkills,
  normalizeCatalogKey,
  type ShipOffer as CatalogShipOffer,
  type SkillMap,
} from './catalog'
import { lookupShipKbRecord } from './ship-kb'
import { getDecisionPressureSnapshot, getAgentRole } from './agent-learning'

const DEFAULT_INTERVAL_SEC = 45
const MAX_CANDIDATES = 5
const NUDGE_COOLDOWN_MS = 10 * 60_000
const KB_CACHE_TTL_MS = 6 * 60 * 60_000
const SHIP_UPGRADE_CACHE_TTL_MS = 20 * 60_000
const MIN_FITTING_RESERVE_CREDITS = 10_000
const MIN_FITTING_RESERVE_RATIO = 0.2
const SHIP_KB_URL = 'https://rsned.github.io/spacemolt-kb/ships/'

type Candidate = {
  profileId: string
  profileName: string
  role: string
  mutationState: string
  mutationDetail: string | null
  navigationState: string
  navigationDetail: string | null
  gameState: unknown
  decisionPressure: {
    queryStreak: number
    sameQueryStreak: number
    noProgressStreak: number
    lastQueryCommand: string | null
    recommendation: string | null
  }
  recentSignals: string[]
  routeSignals: string[]
  shipUpgradeSignals: string[]
  ownedShipSignals: string[]
  fleetCleanupSignals: string[]
  moduleUpgradeSignals: string[]
  adviceSignals: AdviceSignal[]
}

type AdviceSignal = {
  kind: string
  priority: number
  summary: string
  evidence: string[]
  recommendedChecks: string[]
  recommendedActions: string[]
  whyNow?: string
}

type LoopSignal = {
  detected: boolean
  summary: string
  evidence: string[]
  recommendedChecks: string[]
  recommendedActions: string[]
}

type VerifiedCommands = {
  names: Set<string>
  infos: Map<string, GameCommandInfo>
  loadedFrom: string
}

type CommandHintSignal = {
  attempted: string
  suggestions: string[]
  usageHints: string[]
  source: string
}

type MapSystem = {
  id: string
  name: string
  connections?: string[]
}

type MapResponse = {
  systems?: MapSystem[]
}

type RouteGraph = {
  byId: Map<string, MapSystem>
  byName: Map<string, MapSystem>
}

type GraphCacheEntry = {
  expiresAt: number
  graph: RouteGraph
}

const GRAPH_TTL_MS = 5 * 60_000
const graphCache = new Map<string, GraphCacheEntry>()
let shipCatalogCache: { expiresAt: number; ships: Map<string, ShipCatalogEntry> } | null = null

type ShipCatalogEntry = {
  name: string
  tier: number
  hull: number
  shield: number
  cargo: number
  weaponSlots: number
  defenseSlots: number
  utilitySlots: number
}

type ShipOffer = {
  name: string
  classId: string
  price: number
  requiredSkills: SkillMap
  skillEligible: boolean
}

type ShipUpgradeContext = {
  offers: ShipOffer[]
  skills: SkillMap
}

class FleetSupervisor {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private lastNudgeAtByProfile = new Map<string, number>()
  private lastNudgeTextByProfile = new Map<string, string>()
  private shipUpgradeSignalsCache = new Map<string, { expiresAt: number; signals: string[] }>()
  private ownedShipSignalsCache = new Map<string, { expiresAt: number; signals: string[] }>()
  private fleetCleanupSignalsCache = new Map<string, { expiresAt: number; signals: string[] }>()
  private moduleUpgradeSignalsCache = new Map<string, { expiresAt: number; signals: string[] }>()
  private verifiedCommandsCache = new Map<string, { expiresAt: number; commands: VerifiedCommands | null }>()

  start(): void {
    if (this.timer) clearTimeout(this.timer)
    setTimeout(() => {
      this.runOnce().catch((err) => {
        console.error(`[supervisor] initial pass failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }, 15_000)
    this.scheduleNext()
  }

  async runOnce(): Promise<void> {
    if (this.running) return

    const provider = (getPreference('supervisor_provider') || '').trim()
    const modelId = (getPreference('supervisor_model') || '').trim()
    if (!isSupervisorEnabled() || !provider || !modelId) {
      this.scheduleNext()
      return
    }

    this.running = true
    let runId: number | null = null
    try {
      const candidates = await this.collectCandidates()
      if (candidates.length === 0) return

      runId = createSupervisorRun({
        providerName: provider,
        modelName: modelId,
        candidateCount: candidates.length,
        candidatesJson: JSON.stringify(candidates),
      })

      const { model, apiKey, failoverApiKey } = await resolveModel(`${provider}/${modelId}`)
      const context: Context = {
        systemPrompt: [
          'You are Admiral Fleet Supervisor.',
          'Your job is to send gentle, non-destructive nudges to game agents when recent evidence suggests confusion, local stalls, or incorrect next-step planning.',
          'Do not issue commands. Do not recommend self-destruct, account reset, logout/login recovery, or any irreversible action.',
          'Use only the supplied adviceSignals when composing a nudge. Do not invent diagnoses or recommendations that are not supported by adviceSignals.',
          'Prefer the single highest-priority actionable signal for each profile.',
          'Preserve specific checks and actions from the selected signal. Do not replace a specific check like get_cargo, market, dock, or find_route with generic get_status unless the signal itself only recommends get_status.',
          'If adviceSignals is empty, omit that profile.',
          'Return strict JSON only: {"nudges":[{"profile":"name","message":"short hint"}]}.',
          'Each message should be one short sentence or two short clauses, grounded in the chosen advice signal evidence.',
          'At most 3 nudges. Omit profiles that do not need intervention.',
        ].join(' '),
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              now: new Date().toISOString(),
              candidates,
            }, null, 2),
            timestamp: Date.now(),
          },
        ],
      }

      const response = await complete(model, context, {
        apiKey: apiKey || failoverApiKey || undefined,
        timeout: 60_000,
      })

      const text = response.content
        .filter((block: any) => block.type === 'text' && typeof block.text === 'string')
        .map((block: any) => block.text.trim())
        .join('\n')
        .trim()

      if (runId !== null && text) {
        recordSupervisorRunResponse(runId, text)
      }

      if (!text) return

      const parsed = parseSupervisorOutput(text)
      if (!parsed) {
        if (runId !== null) markSupervisorRunFailed(runId, 'Supervisor returned no parseable JSON')
        return
      }

      let nudgesSent = 0
      for (const nudge of parsed.nudges.slice(0, 3)) {
        const profile = listProfiles().find((entry) => entry.name === nudge.profile)
        if (!profile) continue

        const status = agentManager.getStatus(profile.id)
        if (!status.running) continue
        if (!shouldSendNudge(this.lastNudgeAtByProfile.get(profile.id), this.lastNudgeTextByProfile.get(profile.id), nudge.message)) continue

        agentManager.nudge(profile.id, nudge.message)
        addLogEntry(profile.id, 'system', `Supervisor nudge: ${nudge.message}`)
        this.lastNudgeAtByProfile.set(profile.id, Date.now())
        this.lastNudgeTextByProfile.set(profile.id, nudge.message)
        nudgesSent++
      }

      if (runId !== null) {
        markSupervisorRunSucceeded(runId, nudgesSent, JSON.stringify(parsed.nudges.slice(0, 3)))
      }
    } catch (err) {
      if (runId !== null) {
        markSupervisorRunFailed(runId, err instanceof Error ? err.message : String(err))
      }
      throw err
    } finally {
      this.running = false
      this.scheduleNext()
    }
  }

  private async collectCandidates(): Promise<Candidate[]> {
    const candidates: Candidate[] = []

    for (const profile of listProfiles().filter((entry) => entry.enabled)) {
      const status = agentManager.getStatus(profile.id)
      if (!status.running) continue

      const logs = getLogEntries(profile.id, undefined, 18)
      const recentSignals = buildRecentSignals(logs.map((entry) => entry.summary))
      const decisionPressure = getDecisionPressureSnapshot(profile.id)
      const loopSignal = detectReplanningLoop(logs, status)
      const routeSignals = await this.buildRouteSignals(profile.server_url, status)
      const shipUpgradeSignals = await this.buildShipUpgradeSignals(profile, status)
      const ownedShipSignals = await this.buildOwnedShipSignals(profile, status)
      const fleetCleanupSignals = await this.buildFleetCleanupSignals(profile, status)
      const moduleUpgradeSignals = await this.buildModuleUpgradeSignals(profile, status)
      const forceCommandRefresh = logs.some((entry) => mentionsUnsupportedCommand(entry.summary || ''))
      const verifiedCommands = await this.getVerifiedCommands(profile, forceCommandRefresh)
      const commandHintSignals = buildCommandHintSignals(logs, verifiedCommands)
      const adviceSignals = buildAdviceSignals(status, recentSignals, routeSignals, shipUpgradeSignals, ownedShipSignals, fleetCleanupSignals, moduleUpgradeSignals, verifiedCommands, loopSignal, commandHintSignals, decisionPressure)
      const noisyState =
        status.mutation_state !== 'idle' ||
        recentSignals.length > 0 ||
        loopSignal.detected ||
        routeSignals.length > 0 ||
        shipUpgradeSignals.length > 0 ||
        ownedShipSignals.length > 0 ||
        fleetCleanupSignals.length > 0 ||
        moduleUpgradeSignals.length > 0 ||
        adviceSignals.length > 0
      if (!noisyState) continue

      candidates.push({
        profileId: profile.id,
        profileName: profile.name,
        role: getAgentRole(profile.id),
        mutationState: status.mutation_state as MutationState,
        mutationDetail: status.mutation_state_detail,
        navigationState: status.navigation_state as NavigationState,
        navigationDetail: status.navigation_state_detail,
        gameState: status.gameState,
        decisionPressure,
        recentSignals,
        routeSignals,
        shipUpgradeSignals,
        ownedShipSignals,
        fleetCleanupSignals,
        moduleUpgradeSignals,
        adviceSignals,
      })

      if (candidates.length >= MAX_CANDIDATES) break
    }

    return candidates
  }

  private async buildShipUpgradeSignals(
    profile: Profile,
    status: ReturnType<typeof agentManager.getStatus>,
  ): Promise<string[]> {
    const cached = this.shipUpgradeSignalsCache.get(profile.id)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.signals
    }

    const signals = await computeShipUpgradeSignals(profile, status)
    this.shipUpgradeSignalsCache.set(profile.id, {
      expiresAt: Date.now() + SHIP_UPGRADE_CACHE_TTL_MS,
      signals,
    })
    return signals
  }

  private async buildOwnedShipSignals(
    profile: Profile,
    status: ReturnType<typeof agentManager.getStatus>,
  ): Promise<string[]> {
    const cached = this.ownedShipSignalsCache.get(profile.id)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.signals
    }

    const signals = await computeOwnedShipSignals(profile, status)
    this.ownedShipSignalsCache.set(profile.id, {
      expiresAt: Date.now() + SHIP_UPGRADE_CACHE_TTL_MS,
      signals,
    })
    return signals
  }

  private async buildFleetCleanupSignals(
    profile: Profile,
    status: ReturnType<typeof agentManager.getStatus>,
  ): Promise<string[]> {
    const cached = this.fleetCleanupSignalsCache.get(profile.id)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.signals
    }

    const signals = await computeFleetCleanupSignals(profile, status)
    this.fleetCleanupSignalsCache.set(profile.id, {
      expiresAt: Date.now() + SHIP_UPGRADE_CACHE_TTL_MS,
      signals,
    })
    return signals
  }

  private async buildModuleUpgradeSignals(
    profile: Profile,
    status: ReturnType<typeof agentManager.getStatus>,
  ): Promise<string[]> {
    const cached = this.moduleUpgradeSignalsCache.get(profile.id)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.signals
    }
    const signals = await computeModuleUpgradeSignals(profile, status)
    this.moduleUpgradeSignalsCache.set(profile.id, {
      expiresAt: Date.now() + SHIP_UPGRADE_CACHE_TTL_MS,
      signals,
    })
    return signals
  }

  private async buildRouteSignals(
    serverUrl: string | undefined,
    status: ReturnType<typeof agentManager.getStatus>,
  ): Promise<string[]> {
    const signals: string[] = []
    const destinationRaw = extractPendingDestination(status.mutation_state_detail || status.navigation_state_detail)
    if (!destinationRaw) return signals

    const currentSystemRaw = status.gameState?.system
    if (typeof currentSystemRaw !== 'string' || !currentSystemRaw.trim()) return signals

    const graph = await getRouteGraph(serverUrl)
    if (!graph) return signals

    const current = resolveSystem(graph, currentSystemRaw)
    const target = resolveSystem(graph, destinationRaw)
    if (!current || !target) {
      signals.push(`pending navigation target '${destinationRaw}' could not be validated against the system graph`)
      return signals
    }

    const currentConnections = new Set((current.connections || []).map(normalizeSystemKey))
    if (!currentConnections.has(normalizeSystemKey(target.id))) {
      const hops = estimateHopCount(graph, current.id, target.id)
      if (hops !== null && hops > 1) {
        signals.push(`current system '${current.name}' is not directly connected to '${target.name}'; direct jump should not be possible and the route needs about ${hops} jumps`)
      } else {
        signals.push(`current system '${current.name}' is not directly connected to '${target.name}'; direct jump should not be possible`)
      }
    }

    return signals
  }

  private async getVerifiedCommands(profile: Profile, forceRefresh = false): Promise<VerifiedCommands | null> {
    const cacheKey = `${profile.connection_mode}:${profile.server_url}`
    const cached = this.verifiedCommandsCache.get(cacheKey)
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.commands
    }

    const runtimeCommands = await this.fetchRuntimeCommands(profile)
    if (runtimeCommands.length > 0) {
      const verified = {
        names: new Set(runtimeCommands.map((command) => command.name.trim()).filter(Boolean)),
        infos: new Map(runtimeCommands.map((command) => [command.name.trim(), command])),
        loadedFrom: 'runtime:get_commands',
      }
      this.verifiedCommandsCache.set(cacheKey, {
        expiresAt: Date.now() + 10 * 60_000,
        commands: verified,
      })
      return verified
    }

    const apiVersion = profile.connection_mode === 'http_v2' || profile.connection_mode === 'websocket_v2' || profile.connection_mode === 'mcp_v2'
      ? 'v2'
      : 'v1'
    const baseUrl = profile.server_url.replace(/\/$/, '')
    const commands = await fetchGameCommands(`${baseUrl}/api/${apiVersion}`).catch(() => [])
    const verified = commands.length > 0
      ? {
        names: new Set(commands.map((command) => command.name.trim()).filter(Boolean)),
        infos: new Map(commands.map((command) => [command.name.trim(), command])),
        loadedFrom: `${baseUrl}/api/${apiVersion}/openapi.json`,
      }
      : null
    this.verifiedCommandsCache.set(cacheKey, {
      expiresAt: Date.now() + 10 * 60_000,
      commands: verified,
    })
    return verified
  }

  private async fetchRuntimeCommands(profile: Profile): Promise<GameCommandInfo[]> {
    if (!profile.username || !profile.password) return []

    const connection = createGameConnection(profile)
    try {
      await connection.connect()
      const login = await connection.login(profile.username, profile.password)
      if (!login.success) return []
      const response = await connection.execute('get_commands', {})
      if (response.error) return []
      return parseRuntimeCommandResult(response.result)
    } catch {
      return []
    } finally {
      await connection.disconnect().catch(() => {})
    }
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer)
    const delayMs = getSupervisorIntervalSec() * 1000
    this.timer = setTimeout(() => {
      this.runOnce().catch((err) => {
        console.error(`[supervisor] pass failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }, delayMs)
  }
}

export function buildRecentSignals(summaries: string[]): string[] {
  const signals: string[] = []
  const add = (label: string) => {
    if (!signals.includes(label)) signals.push(label)
  }

  for (const summary of summaries) {
    const lower = summary.toLowerCase()
    if (lower.includes('blocked duplicate navigation command')) add('duplicate navigation was blocked recently')
    if (lower.includes('navigation deadlock')) add('agent described a navigation deadlock recently')
    if (lower.includes('server freeze')) add('agent described a server freeze recently')
    if (lower.includes('error: [not_docked]')) add('not_docked error observed recently')
    if (lower.includes('error: [no_base]')) add('no_base error observed recently')
    if (lower.includes('error: [already_in_system]')) add('already_in_system error observed recently')
    if (lower.includes('error: [invalid_scope]') && lower.includes('use "personal" (default) or "faction"')) {
      add('view_orders scope options clarified recently')
    }
    if (lower.includes('error: [not_enough_fuel]')) add('not_enough_fuel error observed recently')
    if (lower.includes('error: [no_resources]') && lower.includes('nothing to mine here')) add('mine location mismatch observed recently')
    if (lower.includes('error: [no_equipment]') && lower.includes('ice harvester')) add('mine equipment mismatch observed recently')
    if (lower.includes('error: [invalid_payload]') && lower.includes('quantity must be greater than 0')) add('sell quantity zero error observed recently')
    if (
      lower.includes('error: [invalid_payload]')
      && lower.includes('view_market only accepts item_id or category')
      && lower.includes('cannot target a remote `station_id`')
    ) {
      add('remote view_market misuse observed recently')
    }
    if (
      lower.includes('build_failed')
      && lower.includes('already have a')
      && lower.includes(`use action 'upgrade'`)
    ) {
      add('facility upgrade suggested by server recently')
    }
    if (lower.includes('produced zero fill') || (lower.includes('"command":"sell"') && lower.includes('"quantity_sold":0'))) {
      add('sell zero fill observed recently')
    }
    if (lower.includes('"command":"facility"') || lower.includes('facility pending;') || lower.includes('facility(action=')) {
      add('facility action observed recently')
    }
    if (lower.includes('[action_result]')) add('recent action_result observed')
    if (lower.includes('"action":"jumped"')) add('recent jumped confirmation observed')
    if (lower.includes('pending action accepted')) add('recent mutation accepted as pending')
  }

  return signals.slice(0, 8)
}

function detectReplanningLoop(
  logs: ReturnType<typeof getLogEntries>,
  status: ReturnType<typeof agentManager.getStatus>,
): LoopSignal {
  if (logs.length < 8) {
    return emptyLoopSignal()
  }

  const recent = [...logs].reverse()
  const toolCalls = recent
    .filter((entry) => entry.type === 'tool_call')
    .map((entry) => extractCommandNameFromSummary(entry.summary))
    .filter((command): command is string => Boolean(command))

  if (toolCalls.length < 5) return emptyLoopSignal()

  const repeatedQueryCalls = toolCalls.filter((command) => isLoopProneQuery(command))
  const progressSignals = recent.filter((entry) => {
    const lower = entry.summary.toLowerCase()
    return lower.includes('[action_result]') || lower.includes('pending action accepted')
  })
  const dominantCommands = summarizeDominantCommands(toolCalls)

  const stableButStuck =
    status.connected &&
    status.running &&
    status.mutation_state !== 'mutation_pending' &&
    status.mutation_state !== 'navigation_pending'

  if (!stableButStuck || repeatedQueryCalls.length < 5 || progressSignals.length > 0 || dominantCommands.length === 0) {
    return emptyLoopSignal()
  }

  const ship = status.gameState?.ship
  const modules = Array.isArray((status.gameState as Record<string, unknown> | undefined)?.modules)
    ? ((status.gameState as Record<string, unknown>).modules as unknown[])
    : []
  const cargo = parseUsagePair(ship?.cargo)
  const cargoFull = !!cargo && cargo.capacity > 0 && cargo.used >= cargo.capacity
  const poi = typeof status.gameState?.poi === 'string' ? status.gameState.poi.trim() : ''
  const system = typeof status.gameState?.system === 'string' ? status.gameState.system.trim() : ''
  const recommendedChecks = ['get_status']
  const recommendedActions: string[] = []

  if (cargoFull) {
    recommendedChecks.push('get_cargo')
    if (looksDocked(poi) || status.navigation_state === 'docked') {
      recommendedChecks.push('market')
      recommendedActions.push('sell')
    } else {
      recommendedChecks.push('get_system')
      recommendedActions.push('travel', 'dock')
    }
  }

  return {
    detected: true,
    summary: 'The agent appears stuck in a re-planning loop: repeated query/recovery commands without state progress.',
    evidence: [
      `recent_commands=${dominantCommands.join(', ')}`,
      ...(system ? [`system=${system}`] : []),
      ...(poi ? [`poi=${poi}`] : []),
      ...(cargoFull && cargo ? [`cargo=${cargo.used}/${cargo.capacity}`] : []),
      `recent_progress_events=${progressSignals.length}`,
    ],
    recommendedChecks,
    recommendedActions,
  }
}

function emptyLoopSignal(): LoopSignal {
  return {
    detected: false,
    summary: '',
    evidence: [],
    recommendedChecks: [],
    recommendedActions: [],
  }
}

function extractCommandNameFromSummary(summary: string): string | null {
  const trimmed = summary.trim()
  const gameMatch = trimmed.match(/^game\(([\w_]+)/)
  if (gameMatch) return gameMatch[1]
  const manualMatch = trimmed.match(/^manual:\s*([\w_]+)\(/)
  if (manualMatch) return manualMatch[1]
  return null
}

function summarizeDominantCommands(commands: string[]): string[] {
  const counts = new Map<string, number>()
  for (const command of commands) {
    counts.set(command, (counts.get(command) || 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([command, count]) => `${command}x${count}`)
}

function isLoopProneQuery(command: string): boolean {
  return ['get_status', 'get_system', 'get_poi', 'get_location', 'view_orders', 'view_market', 'get_base'].includes(command)
}

function buildAdviceSignals(
  status: ReturnType<typeof agentManager.getStatus>,
  recentSignals: string[],
  routeSignals: string[],
  shipUpgradeSignals: string[],
  ownedShipSignals: string[],
  fleetCleanupSignals: string[],
  moduleUpgradeSignals: string[],
  verifiedCommands: VerifiedCommands | null,
  loopSignal: LoopSignal,
  commandHintSignals: CommandHintSignal[],
  decisionPressure: ReturnType<typeof getDecisionPressureSnapshot>,
): AdviceSignal[] {
  const signals: AdviceSignal[] = []
  const ship = status.gameState?.ship
  const modules = Array.isArray((status.gameState as Record<string, unknown> | undefined)?.modules)
    ? (((status.gameState as Record<string, unknown> | undefined)?.modules) as unknown[])
    : []
  const cargo = parseUsagePair(ship?.cargo)
  const credits = toFiniteNumber(status.gameState?.credits)
  const poi = typeof status.gameState?.poi === 'string' ? status.gameState.poi.trim() : ''
  const system = typeof status.gameState?.system === 'string' ? status.gameState.system.trim() : ''
  const cargoItems = Array.isArray(ship?.cargoItems)
    ? ship.cargoItems.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
  const isDocked = looksDocked(poi) || status.navigation_state === 'docked'

  if (cargo && cargo.capacity > 0 && cargo.used >= cargo.capacity) {
    signals.push({
      kind: 'cargo_full_sell',
      priority: isDocked ? 95 : 88,
      summary: isDocked
        ? 'Cargo is full and the ship is docked; clear inventory instead of gathering more.'
        : 'Cargo is full; stop gathering and clear inventory before continuing.',
      evidence: [
        `cargo=${cargo.used}/${cargo.capacity}`,
        ...(poi ? [`poi=${poi}`] : []),
        ...(cargoItems.length > 0 ? [`cargo_items=${cargoItems.slice(0, 4).join(', ')}`] : []),
      ],
      recommendedChecks: isDocked ? ['get_cargo', 'market'] : ['get_cargo'],
      recommendedActions: isDocked ? ['sell'] : ['dock'],
      whyNow: 'the gather plan is blocked until cargo capacity is freed',
    })
  }

  if (routeSignals.length > 0) {
    signals.push({
      kind: 'route_needs_find_route',
      priority: 92,
      summary: 'The pending navigation target is not a direct hop; re-plan the route before jumping again.',
      evidence: routeSignals.slice(0, 2),
      recommendedChecks: ['find_route'],
      recommendedActions: ['jump'],
      whyNow: 'repeating the same jump will keep failing or stalling',
    })
  }

  for (const hint of commandHintSignals.slice(0, 2)) {
    signals.push({
      kind: 'verified_command_hint',
      priority: 90,
      summary: `A recently attempted command is not verified; switch to a supported command name before retrying.`,
      evidence: [
        `attempted=${hint.attempted}`,
        hint.suggestions.length > 0 ? `try=${hint.suggestions.join(', ')}` : 'try=use get_commands or a verified command from the current API',
        ...hint.usageHints,
        `command_validation=${hint.source}`,
      ],
      recommendedChecks: ['get_commands'],
      recommendedActions: hint.suggestions,
      whyNow: 'repeating unsupported commands wastes turns and hides the real next step',
    })
  }

  if (loopSignal.detected) {
    signals.push({
      kind: 'replanning_loop_detected',
      priority: 91,
      summary: loopSignal.summary,
      evidence: loopSignal.evidence,
      recommendedChecks: loopSignal.recommendedChecks,
      recommendedActions: loopSignal.recommendedActions,
      whyNow: 'recent turns are repeating checks or retries without producing state progress',
    })
  }

  if (decisionPressure.recommendation) {
    signals.push({
      kind: 'agent_learning_pressure',
      priority: 89,
      summary: 'Agent-learning indicates a local decision-pressure pattern that should be corrected before more routine querying.',
      evidence: [
        `query_streak=${decisionPressure.queryStreak}`,
        `same_query_streak=${decisionPressure.sameQueryStreak}`,
        `no_progress_streak=${decisionPressure.noProgressStreak}`,
        ...(decisionPressure.lastQueryCommand ? [`last_query=${decisionPressure.lastQueryCommand}`] : []),
        decisionPressure.recommendation,
      ],
      recommendedChecks: decisionPressure.lastQueryCommand ? [decisionPressure.lastQueryCommand] : ['get_status'],
      recommendedActions: [],
      whyNow: 'agent-learning has already observed a repeated low-progress pattern in this session',
    })
  }

  if (recentSignals.includes('not_docked error observed recently')) {
    signals.push({
      kind: 'dock_before_docked_actions',
      priority: 85,
      summary: 'A docked-only action was attempted while undocked; correct the state first.',
      evidence: [
        'recent not_docked error observed',
        ...(poi ? [`poi=${poi}`] : []),
        ...(system ? [`system=${system}`] : []),
      ],
      recommendedChecks: ['get_status'],
      recommendedActions: ['dock'],
      whyNow: 'the current plan is using the wrong ship state',
    })
  }

  if (recentSignals.includes('no_base error observed recently')) {
    signals.push({
      kind: 'dock_at_base_before_base_actions',
      priority: 84,
      summary: 'A base-only action was attempted away from a valid base; move to a base before retrying it.',
      evidence: [
        'recent no_base error observed',
        ...(poi ? [`poi=${poi}`] : []),
        ...(system ? [`system=${system}`] : []),
      ],
      recommendedChecks: ['get_status'],
      recommendedActions: ['travel', 'dock'],
      whyNow: 'the action cannot succeed from the current location',
    })
  }

  if (recentSignals.includes('view_orders scope options clarified recently')) {
    signals.push({
      kind: 'view_orders_scope_choice',
      priority: 83,
      summary: 'The last order query used an invalid scope; choose explicitly between personal orders and faction orders.',
      evidence: [
        'recent invalid_scope error explicitly listed the only valid scope values',
        'valid_scopes=personal,faction',
      ],
      recommendedChecks: ['view_orders'],
      recommendedActions: [],
      whyNow: 'retrying the same invalid scope wastes turns when the API already told you both accepted options',
    })
  }

  if (recentSignals.includes('duplicate navigation was blocked recently')) {
    signals.push({
      kind: 'wait_for_pending_navigation',
      priority: 83,
      summary: 'A second navigation command was sent while a previous one was still pending; do not stack more movement.',
      evidence: [
        'duplicate navigation was blocked recently',
        ...(status.mutation_state === 'navigation_pending' && status.mutation_state_detail ? [status.mutation_state_detail] : []),
        ...(status.navigation_state === 'navigation_pending' && status.navigation_state_detail ? [status.navigation_state_detail] : []),
      ],
      recommendedChecks: ['get_status'],
      recommendedActions: [],
      whyNow: 'stacked navigation commands create local confusion without progress',
    })
  }

  if (recentSignals.includes('not_enough_fuel error observed recently')) {
    signals.push({
      kind: 'fuel_blocked_replan',
      priority: 82,
      summary: 'The current movement plan is fuel-blocked; refuel or choose a shorter route before retrying.',
      evidence: [
        'recent not_enough_fuel error observed',
        ...(ship?.fuel ? [`fuel=${ship.fuel}`] : []),
        ...(system ? [`system=${system}`] : []),
      ],
      recommendedChecks: looksDocked(poi) ? ['get_status', 'market'] : ['get_status'],
      recommendedActions: looksDocked(poi)
        ? ['refuel', 'find_route']
        : ['dock', 'find_route'],
      whyNow: 'repeating the same movement will fail again until fuel constraints change',
    })
  }

  if (recentSignals.includes('remote view_market misuse observed recently')) {
    signals.push({
      kind: 'market_requires_local_docking',
      priority: 83,
      summary: 'The market query targeted a remote station; verify whether you are already docked locally before changing location.',
      evidence: [
        'recent view_market invalid_payload explicitly rejected remote station_id usage',
        ...(poi ? [`poi=${poi}`] : []),
        ...(system ? [`system=${system}`] : []),
      ],
      recommendedChecks: ['get_status'],
      recommendedActions: looksDocked(poi) ? ['view_market'] : ['dock'],
      whyNow: looksDocked(poi)
        ? 'if the ship is already docked, continue locally and rerun view_market without station_id instead of traveling anywhere'
        : 'only re-plan toward docking if fresh status confirms the ship is not already docked at the local market location',
    })
  }

  const facilityPending =
    status.mutation_state === 'mutation_pending'
    && typeof status.mutation_state_detail === 'string'
    && status.mutation_state_detail.toLowerCase().includes('facility')

  if (facilityPending || recentSignals.includes('facility action observed recently')) {
    signals.push({
      kind: 'facility_station_flow',
      priority: facilityPending ? 86 : 78,
      summary: facilityPending
        ? 'A station facility action is already pending; let that build/craft flow resolve before switching plans.'
        : 'Recent station facility activity suggests the next step should stay on the station build/craft flow, not jump back to mining immediately.',
      evidence: [
        ...(facilityPending && status.mutation_state_detail ? [status.mutation_state_detail] : ['recent facility action observed']),
        ...(poi ? [`poi=${poi}`] : []),
        ...(system ? [`system=${system}`] : []),
      ],
      recommendedChecks: ['get_status'],
      recommendedActions: facilityPending ? [] : ['facility'],
      whyNow: facilityPending
        ? 'stacking unrelated actions on top of an in-flight station build/craft step creates local confusion'
        : 'station crafting/building should be completed or re-checked before resuming the normal mining loop',
    })
  }

  if (recentSignals.includes('facility upgrade suggested by server recently')) {
    signals.push({
      kind: 'facility_upgrade_available',
      priority: 87,
      summary: 'The server reported that this facility already exists here; switch from build to upgrade.',
      evidence: [
        'recent facility build_failed error explicitly suggested action=upgrade',
        ...(poi ? [`poi=${poi}`] : []),
        ...(system ? [`system=${system}`] : []),
      ],
      recommendedChecks: ['get_status'],
      recommendedActions: ['facility'],
      whyNow: 'retrying the same build will fail again until the plan switches to facility(action="upgrade")',
    })
  }

  if (recentSignals.includes('sell quantity zero error observed recently')) {
    signals.push({
      kind: 'recompute_sell_quantity',
      priority: 81,
      summary: 'The last sell used quantity 0 or stale cargo assumptions; recompute the amount first.',
      evidence: [
        'recent sell quantity zero error observed',
        ...(cargoItems.length > 0 ? [`cargo_items=${cargoItems.slice(0, 4).join(', ')}`] : ['cargo_items=unknown']),
      ],
      recommendedChecks: ['get_cargo'],
      recommendedActions: ['sell'],
      whyNow: 'the sell plan is malformed, not just temporarily blocked',
    })
  }

  if (recentSignals.includes('sell zero fill observed recently')) {
    signals.push({
      kind: 'sell_zero_fill_replan',
      priority: 82,
      summary: 'Recent instant sells filled nothing; stop retrying sell and switch to a priced sell order or a better market.',
      evidence: [
        'recent sell zero fill observed',
        ...(poi ? [`poi=${poi}`] : []),
        ...(cargoItems.length > 0 ? [`cargo_items=${cargoItems.slice(0, 4).join(', ')}`] : ['cargo_items=unknown']),
      ],
      recommendedChecks: ['view_market', 'get_cargo'],
      recommendedActions: ['create_sell_order'],
      whyNow: 'repeating the same instant sell is consuming turns without generating credits',
    })
  }

  if (recentSignals.includes('mine equipment mismatch observed recently')) {
    signals.push({
      kind: 'mine_with_current_fit',
      priority: 79,
      summary: 'The current ship fit is better used at a non-empty belt compatible with the installed mining gear than at an ice node requiring a refit.',
      evidence: [
        'recent mine equipment mismatch observed',
        ...(poi ? [`poi=${poi}`] : []),
        ...(system ? [`system=${system}`] : []),
        ...(modules.length > 0
          ? [`modules=${modules.slice(0, 3).map((entry: unknown) => String((entry as Record<string, unknown>).name ?? '?')).join(', ')}`]
          : []),
      ],
      recommendedChecks: ['get_status', 'get_poi'],
      recommendedActions: ['travel'],
      whyNow: 'the ice node mismatches the current fit, but a one-off ice attempt does not justify an immediate or long-term switch to ice equipment',
    })
  }

  if (recentSignals.includes('already_in_system error observed recently')) {
    signals.push({
      kind: 'travel_already_satisfied',
      priority: 76,
      summary: 'Travel is already satisfied; skip the repeated movement and continue with the next local step.',
      evidence: [
        'recent already_in_system error observed',
        ...(system ? [`system=${system}`] : []),
        ...(poi ? [`poi=${poi}`] : []),
      ],
      recommendedChecks: ['get_status'],
      recommendedActions: [],
      whyNow: 'repeating the same travel adds no progress',
    })
  }

  if (ownedShipSignals.length > 0) {
    signals.push({
      kind: 'switch_to_owned_ship',
      priority: 74,
      summary: 'A better already-owned ship is available; switch into it before buying another hull.',
      evidence: ownedShipSignals.slice(0, 1),
      recommendedChecks: ['list_ships', 'get_ship'],
      recommendedActions: ['switch_ship'],
      whyNow: 'a stronger owned hull is already available and should be used first',
    })
  }

  if (fleetCleanupSignals.length > 0) {
    signals.push({
      kind: 'sell_non_mining_ship',
      priority: 71,
      summary: 'Stored non-mining hulls are tying up value; sell the redundant ship once it is confirmed unnecessary for the mining plan.',
      evidence: fleetCleanupSignals.slice(0, 1),
      recommendedChecks: ['list_ships', 'get_ship'],
      recommendedActions: ['sell_ship'],
      whyNow: 'excess non-mining hulls can be converted into mining capital or fitting budget',
    })
  }

  if (moduleUpgradeSignals.length > 0) {
    signals.push({
      kind: 'upgrade_module',
      priority: 73,
      summary: 'A materially better mining laser is affordable and available at this station.',
      evidence: moduleUpgradeSignals.slice(0, 1),
      recommendedChecks: ['view_market'],
      recommendedActions: ['buy', 'install_mod'],
      whyNow: credits !== null ? `current credits=${credits}` : 'an affordable module upgrade window is open',
    })
  }

  if (shipUpgradeSignals.length > 0) {
    signals.push({
      kind: 'upgrade_ship',
      priority: 72,
      summary: 'A materially better ship appears affordable with reserve left for fitting.',
      evidence: shipUpgradeSignals.slice(0, 1),
      recommendedChecks: ['browse_ships'],
      recommendedActions: ['buy_listed_ship'],
      whyNow: credits !== null ? `current credits=${credits}` : 'an affordable upgrade window is available',
    })
  }

  return signals
    .map((signal) => filterAdviceSignal(signal, verifiedCommands))
    .filter((signal): signal is AdviceSignal => signal !== null)
    .sort((a, b) => b.priority - a.priority)
}

export function buildCommandHintSignals(
  logs: ReturnType<typeof getLogEntries>,
  verifiedCommands: VerifiedCommands | null,
): CommandHintSignal[] {
  if (!verifiedCommands || logs.length === 0) return []

  const attempted = new Set<string>()
  const signals: CommandHintSignal[] = []

  for (const entry of logs) {
    if (entry.type !== 'tool_result' && entry.type !== 'error') continue
    const summary = entry.summary || ''
    const unknownMatch = summary.match(/Unknown command '([^']+)'/)
    const blockedMatch = summary.match(/unsupported action '([^']+)'|unsupported command '([^']+)'/)
    const name = (unknownMatch?.[1] || blockedMatch?.[1] || blockedMatch?.[2] || '').trim()
    if (!name || attempted.has(name)) continue
    const normalizedAttempted = normalizeCommandKey(name)
    const currentlyVerified = [...verifiedCommands.names].some((command) => normalizeCommandKey(command) === normalizedAttempted)
    if (currentlyVerified) continue
    attempted.add(name)

    const suggestions = suggestVerifiedCommands(name, verifiedCommands.names).slice(0, 3)
    const usageHints = suggestions
      .map((suggestion) => formatCommandUsageHint(verifiedCommands.infos.get(suggestion)))
      .filter((hint): hint is string => Boolean(hint))
      .slice(0, 2)
    signals.push({
      attempted: name,
      suggestions,
      usageHints,
      source: verifiedCommands.loadedFrom,
    })
  }

  return signals
}

function formatCommandUsageHint(command: GameCommandInfo | undefined): string | null {
  if (!command) return null
  const required = command.params.filter((param) => param.required).map((param) => param.name)
  const optional = command.params.filter((param) => !param.required).map((param) => param.name)
  const params = [
    ...required,
    ...optional.map((name) => `${name}?`),
  ]
  const signature = params.length > 0 ? `${command.name}(${params.join(', ')})` : `${command.name}()`
  return `usage=${signature}`
}

function suggestVerifiedCommands(inputRaw: string, names: Set<string>): string[] {
  const candidates = [...names]
  const input = normalizeCommandKey(inputRaw)
  return candidates
    .map((name) => {
      const normalized = normalizeCommandKey(name)
      let score = levenshtein(input, normalized)
      if (normalized === input) score -= 5
      if (normalized.startsWith(input)) score -= 3
      if (input.startsWith(normalized)) score -= 1
      if (normalized.includes(input)) score -= 1
      return { name, score }
    })
    .sort((a, b) => a.score - b.score || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((entry) => entry.name)
}

function normalizeCommandKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '_')
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  const curr = new Array<number>(b.length + 1).fill(0)
  for (let i = 0; i < a.length; i++) {
    curr[0] = i + 1
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1
      curr[j + 1] = Math.min(
        curr[j] + 1,
        prev[j + 1] + 1,
        prev[j] + cost,
      )
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]
  }
  return prev[b.length]
}

function parseSupervisorOutput(text: string): { nudges: Array<{ profile: string; message: string }> } | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { nudges?: Array<{ profile?: unknown; message?: unknown }> }
    if (!Array.isArray(parsed.nudges)) return null
    return {
      nudges: parsed.nudges
        .map((entry) => ({
          profile: typeof entry.profile === 'string' ? entry.profile.trim() : '',
          message: typeof entry.message === 'string' ? entry.message.trim() : '',
        }))
        .filter((entry) => entry.profile && entry.message),
    }
  } catch {
    return null
  }
}

function mentionsUnsupportedCommand(summary: string): boolean {
  return /Unknown command '([^']+)'|unsupported action '([^']+)'|unsupported command '([^']+)'/.test(summary)
}

function shouldSendNudge(lastAt: number | undefined, lastText: string | undefined, nextText: string): boolean {
  if (!nextText.trim()) return false
  if (lastText && lastText.trim() === nextText.trim()) {
    return !lastAt || (Date.now() - lastAt) >= NUDGE_COOLDOWN_MS
  }
  return !lastAt || (Date.now() - lastAt) >= 60_000
}

function isSupervisorEnabled(): boolean {
  return (getPreference('supervisor_enabled') || '').trim() === 'true'
}

function getSupervisorIntervalSec(): number {
  const raw = (getPreference('supervisor_interval_sec') || '').trim()
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_INTERVAL_SEC
  return Math.max(10, Math.floor(parsed))
}

export const fleetSupervisor = new FleetSupervisor()

function filterAdviceSignal(signal: AdviceSignal, verifiedCommands: VerifiedCommands | null): AdviceSignal | null {
  if (!verifiedCommands) return signal

  const recommendedChecks = signal.recommendedChecks.filter((command) => isVerifiedCommand(command, verifiedCommands))
  const recommendedActions = signal.recommendedActions.filter((action) => isVerifiedAction(action, verifiedCommands))
  if (signal.recommendedChecks.length > 0 && recommendedChecks.length === 0) return null
  if (signal.recommendedActions.length > 0 && recommendedActions.length === 0) return null

  return {
    ...signal,
    evidence: [
      ...signal.evidence,
      `command_validation=${verifiedCommands.loadedFrom}`,
    ],
    recommendedChecks,
    recommendedActions,
  }
}

function isVerifiedCommand(command: string, verifiedCommands: VerifiedCommands): boolean {
  return verifiedCommands.names.has(command.trim())
}

function isVerifiedAction(action: string, verifiedCommands: VerifiedCommands): boolean {
  const normalized = action.trim().toLowerCase()
  if (!normalized) return false

  const candidates = [
    normalized,
    normalized.split(/\s+/)[0],
  ]

  if (normalized.includes(' or ')) {
    candidates.push(...normalized.split(/\s+or\s+/).map((part) => part.trim()))
  }

  if (normalized.includes(' before ')) {
    candidates.push(...normalized.split(/\s+before\s+/).map((part) => part.trim()))
  }

  return candidates.some((candidate) => {
    const command = candidate.split(/\s+/)[0]
    return verifiedCommands.names.has(command)
  })
}

function parseUsagePair(value: unknown): { used: number; capacity: number } | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(\d+)\s*\/\s*(\d+)$/)
  if (!match) return null
  const used = Number(match[1])
  const capacity = Number(match[2])
  if (!Number.isFinite(used) || !Number.isFinite(capacity)) return null
  return { used, capacity }
}

function looksDocked(poi: string): boolean {
  const normalized = poi.toLowerCase()
  return normalized.includes('station') || normalized.includes('base') || normalized.includes('shipyard')
}

async function computeShipUpgradeSignals(
  profile: Profile,
  status: ReturnType<typeof agentManager.getStatus>,
): Promise<string[]> {
  const poi = typeof status.gameState?.poi === 'string' ? status.gameState.poi.toLowerCase() : ''
  if (!poi || (!poi.includes('shipyard') && !poi.includes('base') && !poi.includes('station'))) return []
  if (!profile.username || !profile.password) return []

  const credits = typeof status.gameState?.credits === 'number' ? status.gameState.credits : null
  if (credits === null || credits < MIN_FITTING_RESERVE_CREDITS) return []

  const shipRecord = status.gameState?.ship
  const shipName = stringifyShipValue(shipRecord?.name) || stringifyShipValue(shipRecord?.class)
  const currentShip = shipName ? await getShipCatalogEntry(shipName) : null
  if (!currentShip) return []

  const upgradeContext = await fetchShipUpgradeContext(profile)
  if (upgradeContext.offers.length === 0) return []

  const reserveBudget = Math.max(MIN_FITTING_RESERVE_CREDITS, Math.floor(credits * MIN_FITTING_RESERVE_RATIO))
  const best = await pickUpgradeOffer(currentShip, upgradeContext.offers, credits, reserveBudget, upgradeContext.skills)
  if (!best) return []

  const spareCredits = credits - best.price
  const totalSlotsCurrent = currentShip.weaponSlots + currentShip.defenseSlots + currentShip.utilitySlots
  const totalSlotsNext = best.ship.weaponSlots + best.ship.defenseSlots + best.ship.utilitySlots
  const requiredSkillsSummary = formatRequiredSkills(best.requiredSkills)
  return [
    `affordable ship upgrade available: ${currentShip.name} -> ${best.ship.name} for ${best.price} cr; reserve after hull purchase stays ${spareCredits} cr for fitting; skill check passed${requiredSkillsSummary ? ` (${requiredSkillsSummary})` : ''}; cargo ${currentShip.cargo}->${best.ship.cargo}, durability ${currentShip.hull + currentShip.shield}->${best.ship.hull + best.ship.shield}, total slots ${totalSlotsCurrent}->${totalSlotsNext}, tier ${currentShip.tier}->${best.ship.tier}`,
  ]
}

async function computeOwnedShipSignals(
  profile: Profile,
  status: ReturnType<typeof agentManager.getStatus>,
): Promise<string[]> {
  if (!profile.username || !profile.password) return []

  const shipRecord = status.gameState?.ship
  const shipName = stringifyShipValue(shipRecord?.name) || stringifyShipValue(shipRecord?.class)
  const currentShip = shipName ? await getShipCatalogEntry(shipName) : null
  if (!currentShip) return []

  const connection = createGameConnection(profile)
  try {
    await connection.connect()
    const login = await connection.login(profile.username || '', profile.password || '')
    if (!login.success) return []

    const resp = await connection.execute('list_ships', {})
    if (resp.error) return []
    const data = ((resp.structuredContent ?? resp.result) as Record<string, unknown> | undefined) || {}
    const ships = Array.isArray(data.ships) ? data.ships : []

    const candidates: Array<{ ship: ShipCatalogEntry; location: string | null }> = []
    for (const item of ships) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      if (record.is_active === true) continue
      const name = stringifyShipValue(record.custom_name) || stringifyShipValue(record.class_name) || stringifyShipValue(record.class_id)
      if (!name) continue
      const ship = await getShipCatalogEntry(name)
      if (!ship) continue
      if (normalizeShipKey(ship.name) === normalizeShipKey(currentShip.name)) continue

      const improvesCargo = ship.cargo > currentShip.cargo
      const improvesDurability = ship.hull + ship.shield > currentShip.hull + currentShip.shield
      const improvesSlots =
        ship.weaponSlots + ship.defenseSlots + ship.utilitySlots >
        currentShip.weaponSlots + currentShip.defenseSlots + currentShip.utilitySlots
      const improvesTier = ship.tier > currentShip.tier
      if (!improvesCargo && !improvesDurability && !improvesSlots && !improvesTier) continue

      candidates.push({
        ship,
        location: stringifyShipValue(record.location) || stringifyShipValue(record.location_base_id),
      })
    }

    candidates.sort((a, b) =>
      (b.ship.tier - a.ship.tier) ||
      (b.ship.cargo - a.ship.cargo) ||
      ((b.ship.hull + b.ship.shield) - (a.ship.hull + a.ship.shield)) ||
      (
        (b.ship.weaponSlots + b.ship.defenseSlots + b.ship.utilitySlots) -
        (a.ship.weaponSlots + a.ship.defenseSlots + a.ship.utilitySlots)
      ) ||
      a.ship.name.localeCompare(b.ship.name)
    )
    const best = candidates[0]
    if (!best) return []

    const totalSlotsCurrent = currentShip.weaponSlots + currentShip.defenseSlots + currentShip.utilitySlots
    const totalSlotsNext = best.ship.weaponSlots + best.ship.defenseSlots + best.ship.utilitySlots
    return [
      `better owned ship already available: ${currentShip.name} -> ${best.ship.name}${best.location ? ` at ${best.location}` : ''}; cargo ${currentShip.cargo}->${best.ship.cargo}, durability ${currentShip.hull + currentShip.shield}->${best.ship.hull + best.ship.shield}, total slots ${totalSlotsCurrent}->${totalSlotsNext}, tier ${currentShip.tier}->${best.ship.tier}`,
    ]
  } catch {
    return []
  } finally {
    await connection.disconnect().catch(() => {})
  }
}

async function computeFleetCleanupSignals(
  profile: Profile,
  status: ReturnType<typeof agentManager.getStatus>,
): Promise<string[]> {
  if (!profile.username || !profile.password) return []
  if (!isMiningFocusedProfile(profile)) return []

  const connection = createGameConnection(profile)
  try {
    await connection.connect()
    const login = await connection.login(profile.username || '', profile.password || '')
    if (!login.success) return []

    const resp = await connection.execute('list_ships', {})
    if (resp.error) return []
    const data = ((resp.structuredContent ?? resp.result) as Record<string, unknown> | undefined) || {}
    const ships = Array.isArray(data.ships) ? data.ships : []

    const candidates: Array<{ name: string; purpose: string; location: string | null; shipId: string }> = []
    for (const item of ships) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      if (record.is_active === true) continue

      const name = stringifyShipValue(record.custom_name) || stringifyShipValue(record.class_name) || stringifyShipValue(record.class_id)
      if (!name) continue
      const kb = lookupShipKbRecord(name)
      if (!kb || kb.purpose === 'mining') continue

      candidates.push({
        name,
        purpose: kb.purpose,
        location: stringifyShipValue(record.location) || stringifyShipValue(record.location_base_id),
        shipId: stringifyShipValue(record.ship_id) || stringifyShipValue(record.id),
      })
    }

    candidates.sort((a, b) => a.name.localeCompare(b.name))
    const target = candidates[0]
    if (!target) return []

    return [
      `stored non-mining ship can likely be liquidated: ${target.name}${target.location ? ` at ${target.location}` : ''}; purpose=${target.purpose}${target.shipId ? `; ship_id=${target.shipId}` : ''}`,
    ]
  } catch {
    return []
  } finally {
    await connection.disconnect().catch(() => {})
  }
}

async function pickUpgradeOffer(
  currentShip: ShipCatalogEntry,
  offers: ShipOffer[],
  credits: number,
  reserveBudget: number,
  skills: SkillMap,
): Promise<{ ship: ShipCatalogEntry; price: number; score: number; requiredSkills: SkillMap } | null> {
  const candidates: Array<{ ship: ShipCatalogEntry; price: number; score: number; requiredSkills: SkillMap }> = []

  for (const offer of offers) {
    if (!offer.skillEligible) continue
    const ship = await getShipCatalogEntry(offer.name || offer.classId)
    if (!ship) continue
    if (normalizeShipKey(ship.name) === normalizeShipKey(currentShip.name)) continue
    if (offer.price + reserveBudget > credits) continue
    if (!hasRequiredSkills(skills, offer.requiredSkills)) continue

    const improvesCargo = ship.cargo > currentShip.cargo
    const improvesDurability = ship.hull + ship.shield > currentShip.hull + currentShip.shield
    const improvesSlots =
      ship.weaponSlots + ship.defenseSlots + ship.utilitySlots >
      currentShip.weaponSlots + currentShip.defenseSlots + currentShip.utilitySlots
    const improvesTier = ship.tier > currentShip.tier
    if (!improvesCargo && !improvesDurability && !improvesSlots && !improvesTier) continue

    const score =
      (ship.tier - currentShip.tier) * 10_000 +
      (ship.cargo - currentShip.cargo) * 10 +
      ((ship.hull + ship.shield) - (currentShip.hull + currentShip.shield)) +
      ((ship.weaponSlots + ship.defenseSlots + ship.utilitySlots) - (currentShip.weaponSlots + currentShip.defenseSlots + currentShip.utilitySlots)) * 250 -
      offer.price / 100
    candidates.push({ ship, price: offer.price, score, requiredSkills: offer.requiredSkills })
  }

  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  return best || null
}

async function fetchShipUpgradeContext(profile: Profile): Promise<ShipUpgradeContext> {
  const connection = createGameConnection(profile)
  try {
    await connection.connect()
    const login = await connection.login(profile.username || '', profile.password || '')
    if (!login.success) return { offers: [], skills: {} }

    const responses = await Promise.all([
      connection.execute('catalog', { type: 'ships', commissionable: true }),
      connection.execute('get_skills', {}),
      connection.execute('browse_ships', {}),
    ])

    const commissionable = responses[0]
    const skillsResp = responses[1]
    const offerResponses = responses.slice(2)
    const skills = extractSkillLevels((skillsResp.structuredContent ?? skillsResp.result) as Record<string, unknown> | undefined)
    const commissionableOffers = extractShipOffers((commissionable.structuredContent ?? commissionable.result) as Record<string, unknown> | undefined)
    const commissionableClassIds = new Set(
      commissionableOffers
        .map((offer) => normalizeCatalogKey(offer.classId || offer.name))
        .filter(Boolean),
    )

    const offers = await applyCommissionQuotes(connection, profile.id, dedupeShipOffers([
      ...commissionableOffers,
      ...offerResponses.flatMap((resp) => {
        if (resp.error) return []
        return extractShipOffers((resp.structuredContent ?? resp.result) as Record<string, unknown> | undefined)
      }),
    ]))

    return {
      offers: offers
        .filter((offer): offer is CatalogShipOffer & { price: number } => typeof offer.price === 'number' && Number.isFinite(offer.price))
        .map((offer) => ({
          name: offer.name,
          classId: offer.classId,
          price: offer.price,
          requiredSkills: offer.requiredSkills,
          skillEligible:
            commissionableClassIds.has(normalizeCatalogKey(offer.classId || offer.name)) ||
            hasRequiredSkills(skills, offer.requiredSkills),
        })),
      skills,
    }
  } catch {
    return { offers: [], skills: {} }
  } finally {
    await connection.disconnect().catch(() => {})
  }
}

async function computeModuleUpgradeSignals(
  profile: Profile,
  status: ReturnType<typeof agentManager.getStatus>,
): Promise<string[]> {
  if (!profile.username || !profile.password) return []
  if (!isMiningFocusedProfile(profile)) return []

  const poi = typeof status.gameState?.poi === 'string' ? status.gameState.poi.toLowerCase() : ''
  if (!poi || (!poi.includes('station') && !poi.includes('base') && !poi.includes('shipyard'))) return []

  const credits = toFiniteNumber(status.gameState?.credits)
  if (credits === null || credits < 2000) return []

  const modules = Array.isArray((status.gameState as Record<string, unknown> | undefined)?.modules)
    ? ((status.gameState as Record<string, unknown>).modules as unknown[])
    : []
  
  let currentLaserTier = 0
  for (const m of modules) {
    const name = String((m as Record<string, unknown>).name || '').toLowerCase()
    if (name.includes('mining laser iv')) currentLaserTier = Math.max(currentLaserTier, 4)
    else if (name.includes('mining laser iii')) currentLaserTier = Math.max(currentLaserTier, 3)
    else if (name.includes('mining laser ii')) currentLaserTier = Math.max(currentLaserTier, 2)
    else if (name.includes('mining laser i') || name.includes('mining laser')) currentLaserTier = Math.max(currentLaserTier, 1)
  }

  if (currentLaserTier === 0 || currentLaserTier >= 4) return []

  const connection = createGameConnection(profile)
  try {
    await connection.connect()
    const login = await connection.login(profile.username || '', profile.password || '')
    if (!login.success) return []

    const [marketResp, skillsResp, catalogResp] = await Promise.all([
      connection.execute('view_market', {}),
      connection.execute('get_skills', {}),
      connection.execute('catalog', { type: 'modules' }),
    ])

    if (marketResp.error || skillsResp.error || catalogResp.error) return []

    const marketData = ((marketResp.structuredContent ?? marketResp.result) as Record<string, unknown> | undefined) || {}
    const items = Array.isArray(marketData.items) ? marketData.items : []
    const availableLasers = items.filter(item => {
      if (!item || typeof item !== 'object') return false
      const rec = item as Record<string, unknown>
      const name = String(rec.name || rec.item_name || rec.item_id || '').toLowerCase()
      const ask = toFiniteNumber(rec.best_ask ?? rec.ask_price ?? rec.sell_price)
      return name.includes('mining laser') && ask !== null && ask <= credits - 1000
    })

    if (availableLasers.length === 0) return []

    const skillsData = ((skillsResp.structuredContent ?? skillsResp.result) as Record<string, unknown> | undefined) || {}
    const skills = extractSkillLevels(skillsData)

    const catalogData = ((catalogResp.structuredContent ?? catalogResp.result) as Record<string, unknown> | undefined) || {}
    const modDetails = extractModuleDetails(catalogData)

    const candidates: Array<{ name: string; tier: number; price: number; requiredSkills: SkillMap }> = []
    for (const laser of availableLasers) {
      const rec = laser as Record<string, unknown>
      const name = String(rec.name || rec.item_name || rec.item_id || '')
      const nameLower = name.toLowerCase()
      const ask = toFiniteNumber(rec.best_ask ?? rec.ask_price ?? rec.sell_price)!
      
      let tier = 1
      if (nameLower.includes(' iv')) tier = 4
      else if (nameLower.includes(' iii')) tier = 3
      else if (nameLower.includes(' ii')) tier = 2
      
      if (tier <= currentLaserTier) continue

      const detail = modDetails.find(d => d.name.toLowerCase() === nameLower)
      let requiredSkills: SkillMap = {}
      if (detail && Object.keys(detail.requiredSkills).length > 0) {
        if (!hasRequiredSkills(skills, detail.requiredSkills)) continue
        requiredSkills = detail.requiredSkills
      }
      
      candidates.push({ name, tier, price: ask, requiredSkills })
    }

    candidates.sort((a, b) => b.tier - a.tier || a.price - b.price)
    const best = candidates[0]
    if (!best) return []

    const reqStr = Object.keys(best.requiredSkills).length > 0 ? ` (requires ${formatRequiredSkills(best.requiredSkills)})` : ''
    return [
      `affordable module upgrade available: Mining Laser Tier ${currentLaserTier} -> ${best.name} (Tier ${best.tier}) for ${best.price} cr${reqStr}. You have enough credits and skills. Replace your old laser to increase mining yield.`
    ]
  } catch {
    return []
  } finally {
    await connection.disconnect().catch(() => {})
  }
}

async function getShipCatalogEntry(nameOrClass: string): Promise<ShipCatalogEntry | null> {
  const ships = await getShipCatalog()
  return ships.get(normalizeShipKey(nameOrClass)) || null
}

async function getShipCatalog(): Promise<Map<string, ShipCatalogEntry>> {
  if (shipCatalogCache && shipCatalogCache.expiresAt > Date.now()) {
    return shipCatalogCache.ships
  }

  const resp = await fetch(SHIP_KB_URL, { signal: AbortSignal.timeout(15_000) })
  if (!resp.ok) throw new Error(`failed to load ship catalog: ${resp.status}`)
  const html = await resp.text()
  const ships = parseShipCatalog(html)
  shipCatalogCache = { expiresAt: Date.now() + KB_CACHE_TTL_MS, ships }
  return ships
}

function parseShipCatalog(html: string): Map<string, ShipCatalogEntry> {
  const ships = new Map<string, ShipCatalogEntry>()
  const rowPattern = /<tr>\s*<td>([^<]+)<\/td>\s*<td class="num">(\d+)<\/td>\s*<td class="num">(\d+)<\/td>\s*<td class="num">\d+<\/td>\s*<td class="num">(\d+)<\/td>\s*<td class="num">[^<]+<\/td>\s*<td class="num">[^<]+<\/td>\s*<td class="num">\d+<\/td>\s*<td class="num">(\d+)<\/td>\s*<td class="num">(\d+)<\/td>\s*<td class="num">(\d+)<\/td>\s*<td class="num">(\d+)<\/td>\s*<\/tr>/g
  for (const match of html.matchAll(rowPattern)) {
    const entry: ShipCatalogEntry = {
      name: match[1].trim(),
      tier: Number(match[2]),
      hull: Number(match[3]),
      shield: Number(match[4]),
      cargo: Number(match[5]),
      weaponSlots: Number(match[6]),
      defenseSlots: Number(match[7]),
      utilitySlots: Number(match[8]),
    }
    ships.set(normalizeShipKey(entry.name), entry)
  }
  return ships
}

function normalizeShipKey(value: string): string {
  return normalizeCatalogKey(value)
}

function isMiningFocusedProfile(profile: Profile): boolean {
  const text = `${profile.name || ''}\n${profile.directive || ''}`.toLowerCase()
  return /\bmine\b|\bmining\b|\bminer\b|\bore\b/.test(text)
}

function stringifyShipValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function extractSkillLevels(data: Record<string, unknown> | undefined): SkillMap {
  const rawSkills = (data?.skills || (data?.result as Record<string, unknown> | undefined)?.skills) as Record<string, unknown> | undefined
  if (!rawSkills || typeof rawSkills !== 'object') return {}
  const entries = Object.entries(rawSkills)
    .map(([skillId, value]) => {
      if (!value || typeof value !== 'object') return null
      const level = toFiniteNumber((value as Record<string, unknown>).level)
      if (level === null) return null
      return [normalizeShipKey(skillId), level] as const
    })
    .filter((entry): entry is readonly [string, number] => Boolean(entry))
  return Object.fromEntries(entries)
}

function hasRequiredSkills(skills: SkillMap, requiredSkills: SkillMap): boolean {
  for (const [skillId, level] of Object.entries(requiredSkills)) {
    if ((skills[normalizeShipKey(skillId)] || 0) < level) return false
  }
  return true
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeSystemKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function extractPendingDestination(detail: string | null | undefined): string | null {
  if (!detail) return null
  const match = detail.match(/\b(?:jump|travel)\s+to\s+(.+?)\s+pending\b/i)
  return match?.[1]?.trim() || null
}

function resolveSystem(graph: RouteGraph, raw: string): MapSystem | null {
  const key = normalizeSystemKey(raw)
  return graph.byId.get(key) || graph.byName.get(key) || null
}

function estimateHopCount(graph: RouteGraph, fromId: string, toId: string): number | null {
  const start = normalizeSystemKey(fromId)
  const goal = normalizeSystemKey(toId)
  if (start === goal) return 0

  const visited = new Set<string>([start])
  const queue: Array<{ id: string; hops: number }> = [{ id: start, hops: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()!
    const node = graph.byId.get(current.id)
    if (!node) continue
    for (const nextRaw of node.connections || []) {
      const next = normalizeSystemKey(nextRaw)
      if (visited.has(next)) continue
      const hops = current.hops + 1
      if (next === goal) return hops
      visited.add(next)
      queue.push({ id: next, hops })
    }
  }
  return null
}

async function getRouteGraph(serverUrl: string | undefined): Promise<RouteGraph | null> {
  const normalizedUrl = (serverUrl || 'https://game.spacemolt.com').trim().replace(/\/$/, '')
  const cached = graphCache.get(normalizedUrl)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.graph
  }

  try {
    const graph = await fetchRouteGraph(normalizedUrl)
    graphCache.set(normalizedUrl, { expiresAt: Date.now() + GRAPH_TTL_MS, graph })
    return graph
  } catch {
    return null
  }
}

async function fetchRouteGraph(serverUrl: string): Promise<RouteGraph> {
  const resp = await fetch(`${serverUrl}/api/map`, {
    headers: { 'User-Agent': 'SpaceMolt-Admiral' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!resp.ok) {
    throw new Error(`map request failed (${resp.status})`)
  }

  const parsed = await resp.json() as MapResponse
  const systems = Array.isArray(parsed.systems) ? parsed.systems : []
  const byId = new Map<string, MapSystem>()
  const byName = new Map<string, MapSystem>()
  for (const system of systems) {
    if (!system?.id || !system?.name) continue
    byId.set(normalizeSystemKey(system.id), system)
    byName.set(normalizeSystemKey(system.name), system)
  }
  return { byId, byName }
}
