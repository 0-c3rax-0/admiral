import type { Context, Message, Model } from '@mariozechner/pi-ai'
import type { GameConnection, CommandResult } from './connections/interface'
import type { LogFn } from './tools'
import type { Profile } from '../../shared/types'
import { HttpConnection } from './connections/http'
import { HttpV2Connection } from './connections/http_v2'
import { WebSocketConnection } from './connections/websocket'
import { WebSocketV2Connection } from './connections/websocket_v2'
import { McpConnection } from './connections/mcp'
import { McpV2Connection } from './connections/mcp_v2'
import { resolveModel } from './model'
import { fetchGameCommands, formatCommandList, parseRuntimeCommandResult } from './schema'
import { allTools, mergeGameStateSnapshot } from './tools'
import { is429PredictionEnabled, predict429Risk, runAgentTurn, type CompactionState } from './loop'
import { addLogEntry, getLatestPendingLlmRequest, getProfile, updateProfile, getPreference } from './db'
import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import { reconcilePendingNavigationWithStatus, updatePendingNavigationFromNotification } from './navigation-guard'
import { getPendingNavigation } from './navigation-guard'
import { createGameConnection } from './game-connection'
import { buildLearningContext, getDecisionPressureSnapshot, observeGameState, recordCommandOutcome } from './agent-learning'
import {
  buildLocalMutationStuckSummary,
  buildMutationStallNudge,
  buildMutationStateNudge,
  buildNavigationStateNudge,
  buildRecoveryNudge,
  deriveNavigationState,
  describeNavigationState,
  formatNotificationSummary,
  formatReconnectDetail,
  formatVerifiedGameState,
  ingestTradeNotification,
  isActionResultNotification,
  isPendingMutationNotification,
  isReconnectNotification,
  type MutationState,
  type NavigationState,
  shouldForceStateRefreshFromNotifications,
} from '../../fork/server'
import { isDockedPoi, isResourcePoi, resolvePoiSnapshot } from './poi'
import { ingestRuntimeNotification } from './runtime-guards'
import { classifyMiningFit } from './mining-fit'
import {
  applyCommissionQuotes,
  dedupeShipOffers,
  extractItemDetails,
  extractModuleDetails,
  extractRecipeDetails,
  extractShipOffers,
  extractSkillDetails,
  formatMaterialRequirements,
  formatRequiredSkills,
} from './catalog'

const TURN_INTERVAL = 5000
const PROMPT_PATH = path.join(process.cwd(), 'prompt.md')
const MEMORY_DIR = path.join(process.cwd(), 'data', 'memory')
const AGENTS_DIR = path.join(process.cwd(), 'data', 'agents')
const CONTINUE_NUDGE_INTERVAL = 6
const LEARNING_CONTEXT_REFRESH_INTERVAL_MS = 5 * 60_000
const MARKET_TELEMETRY_INTERVAL = 3
const SHIP_TELEMETRY_INTERVAL = 8
const MUTATION_STALL_NUDGE_THRESHOLD = 4
const LOCAL_MUTATION_STUCK_THRESHOLD = 6
const PENDING_WAIT_SLEEP_MS = 1500
const PENDING_RECOVERY_VERIFY_COOLDOWN_MS = 8000
const PENDING_RECOVERY_MAX_WAIT_MS = 25_000
const RECONNECT_STORM_WINDOW_MS = 10 * 60_000
const RECONNECT_STORM_THRESHOLD = 3
const RECONNECT_STORM_COOLDOWN_MS = 60_000
const HTTP_V2_FALLBACK_QUERY_COMMANDS = new Set([
  'get_status', 'get_location', 'get_system', 'get_poi', 'get_cargo', 'get_ship', 'get_skills',
  'get_missions', 'get_active_missions', 'get_nearby', 'get_action_log', 'view_market', 'analyze_market',
  'estimate_purchase', 'catalog', 'browse_ships', 'list_ships', 'quote', 'wrecks', 'forum_list', 'forum_get_thread',
  'captains_log_list', 'captains_log_get', 'social_captains_log_list', 'social_captains_log_get',
  'get_commands', 'get_base', 'view_orders', 'search_systems', 'find_route', 'storage_view', 'salvage_quote',
])

export type { MutationState, NavigationState } from '../../fork/server'

let _promptMd: string | null = null
function getPromptMd(): string {
  if (_promptMd) return _promptMd
  try {
    _promptMd = fs.readFileSync(PROMPT_PATH, 'utf-8')
  } catch {
    _promptMd = '(No prompt.md found)'
  }
  return _promptMd
}

export class Agent {
  readonly profileId: string
  readonly events = new EventEmitter()
  private connection: GameConnection | null = null
  private running = false
  private abortController: AbortController | null = null
  private restartRequested = false
  private pendingNudges: string[] = []
  private _activity: string = 'idle'
  private _gameState: Record<string, unknown> | null = null
  private _sessionExpired = false
  private _adaptiveMode: 'normal' | 'soft' | 'high' | 'critical' = 'normal'
  private _effectiveContextBudgetRatio: number | null = null
  private llmFailoverActive = false
  private memorySummary: string = ''
  private lastSavedMemory: string = ''
  private pendingRecoveryNudge: string | null = null
  private pendingMutationObserved = false
  private loopsSincePendingMutation = 0
  private loopsSinceActionResult = 0
  private localMutationStuckReported = false
  private telemetryCycle = 0
  private learningContext: string = ''
  private learningContextDirty = false
  private lastLearningContextInjectedAt = 0
  private lastRateRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | null = null
  private lastMutationCommand: string | null = null
  private lastMutationAt = 0
  private pendingWaitStartedAt = 0
  private lastPendingVerificationAt = 0
  private pendingRecoveryReason: string | null = null
  private recentReconnectAt: number[] = []
  private reconnectStormCooldownUntil = 0
  private miningAutopilotArmed = false
  private miningAutopilotRunning = false
  private miningAutopilotChainCount = 0
  constructor(profileId: string) {
    this.profileId = profileId
  }

  get isConnected(): boolean {
    return this.connection?.isConnected() ?? false
  }

  get isRunning(): boolean {
    return this.running
  }

  get activity(): string {
    return this._activity
  }

  get gameState(): Record<string, unknown> | null {
    return this._gameState
  }

  get sessionExpired(): boolean {
    return this._sessionExpired
  }

  get adaptiveMode(): 'normal' | 'soft' | 'high' | 'critical' {
    return this._adaptiveMode
  }

  get effectiveContextBudgetRatio(): number | null {
    return this._effectiveContextBudgetRatio
  }

  get mutationState(): MutationState {
    const pendingNavigation = getPendingNavigation(this.profileId)
    if (this.loopsSincePendingMutation >= LOCAL_MUTATION_STUCK_THRESHOLD) return 'local_stall'
    if (pendingNavigation) return 'navigation_pending'
    if (this.pendingMutationObserved) return 'mutation_pending'
    return 'idle'
  }

  get mutationStateDetail(): string | null {
    const pendingNavigation = getPendingNavigation(this.profileId)
    if (this.loopsSincePendingMutation >= LOCAL_MUTATION_STUCK_THRESHOLD) {
      return `local stall after ${this.loopsSincePendingMutation} verification cycles without ACTION_RESULT`
    }
    if (pendingNavigation) {
      const destination = pendingNavigation.destination ? ` to ${pendingNavigation.destination}` : ''
      return `${pendingNavigation.command}${destination} pending`
    }
    if (this.pendingMutationObserved) {
      return `pending mutation unresolved for ${this.loopsSincePendingMutation} verification cycles`
    }
    return null
  }

  get navigationState(): NavigationState {
    if (this.mutationState === 'local_stall') return 'local_stall'
    if (this.mutationState === 'navigation_pending') return 'navigation_pending'
    return deriveNavigationState(this._gameState)
  }

  get navigationStateDetail(): string | null {
    return describeNavigationState(this._gameState, this.navigationState, this.mutationStateDetail)
  }
  private setActivity(activity: string) {
    this._activity = activity
    this.events.emit('activity', activity)
  }

  private cacheGameState(result: CommandResult): void {
    const data = result.structuredContent ?? result.result
    if (!data || typeof data !== 'object') return
    const merged = mergeGameStateSnapshot(this._gameState, result)
    if (!merged) return
    this._gameState = merged
    reconcilePendingNavigationWithStatus(this.profileId, result)
    observeGameState(this.profileId, this._gameState)
  }

  private refreshLearningContext(): boolean {
    const next = buildLearningContext(this.profileId)
    if (!next || next === this.learningContext) return false
    this.learningContext = next
    this.learningContextDirty = true
    return true
  }

  private consumeLearningContextUpdate(force = false): string | null {
    if (!this.learningContextDirty || !this.learningContext) return null
    const now = Date.now()
    if (!force && now - this.lastLearningContextInjectedAt < LEARNING_CONTEXT_REFRESH_INTERVAL_MS) return null
    this.learningContextDirty = false
    this.lastLearningContextInjectedAt = now
    return this.learningContext
  }

  private async executeSilentQuery(command: string, args?: Record<string, unknown>): Promise<CommandResult | null> {
    if (!this.connection) return null
    try {
      const result = await this.connection.execute(command, args)
      return await this.maybeFallbackToHttpV2(command, args, result, false)
    } catch {
      return await this.tryHttpV2Fallback(command, args, false)
    }
  }

  private resetPendingMutationTracking(): void {
    this.pendingMutationObserved = false
    this.loopsSincePendingMutation = 0
    this.loopsSinceActionResult = 0
    this.localMutationStuckReported = false
    this.pendingWaitStartedAt = 0
    this.lastPendingVerificationAt = 0
    this.pendingRecoveryReason = null
  }

  private notePendingMutationObserved(reason?: string): void {
    this.pendingMutationObserved = true
    this.loopsSincePendingMutation = 0
    this.localMutationStuckReported = false
    if (!this.pendingWaitStartedAt) this.pendingWaitStartedAt = Date.now()
    if (reason) this.pendingRecoveryReason = reason
  }

  private noteReconnectDuringPendingResolution(): void {
    const now = Date.now()
    this.recentReconnectAt = this.recentReconnectAt.filter((ts) => now - ts <= RECONNECT_STORM_WINDOW_MS)
    this.recentReconnectAt.push(now)
    if (this.recentReconnectAt.length < RECONNECT_STORM_THRESHOLD) return
    const nextCooldownUntil = now + RECONNECT_STORM_COOLDOWN_MS
    if (nextCooldownUntil <= this.reconnectStormCooldownUntil) return
    this.reconnectStormCooldownUntil = nextCooldownUntil
    this.log(
      'system',
      `Reconnect storm detected during pending action (${this.recentReconnectAt.length} reconnects in ${Math.round(RECONNECT_STORM_WINDOW_MS / 60_000)}m). Cooling navigation recovery for ${Math.round(RECONNECT_STORM_COOLDOWN_MS / 1000)}s before replanning.`,
    )
  }

  private async queryPendingResolutionState(hasPendingNavigation: boolean): Promise<{
    statusResp: CommandResult | null
    locationResp: CommandResult | null
    queueResp: CommandResult | null
  }> {
    const statusResp = await this.executeSilentQuery('get_status')
    if (statusResp) this.cacheGameState(statusResp)
    const locationResp = hasPendingNavigation ? await this.executeSilentQuery('get_location') : null
    if (locationResp) this.cacheGameState(locationResp)
    const profile = getProfile(this.profileId)
    const queueResp = hasPendingNavigation && profile && (
      profile.connection_mode === 'websocket_v2'
      || profile.connection_mode === 'http_v2'
      || profile.connection_mode === 'mcp_v2'
    )
      ? await this.executeSilentQuery('v2_get_queue')
      : null
    if (queueResp) this.cacheGameState(queueResp)
    return { statusResp, locationResp, queueResp }
  }

  private hasPendingServerResolution(): boolean {
    return this.pendingMutationObserved || !!getPendingNavigation(this.profileId)
  }

  private noteCommandOutcome(command: string, result: CommandResult): void {
    if (command === 'undock' || command === 'dock' || command === 'travel' || command === 'jump' || command === 'mine' || command === 'sell' || command === 'refuel' || command === 'repair') {
      this.lastMutationCommand = command
      this.lastMutationAt = Date.now()
    }

    if (command === 'mine' && !result.error && (result.meta?.pending || (result.result && typeof result.result === 'object' && (result.result as Record<string, unknown>).pending === true))) {
      if (!this.miningAutopilotArmed) {
        this.miningAutopilotChainCount = 0
        this.log('system', 'Mining autopilot armed: first mine accepted, local chaining enabled until cargo/state stop condition.')
      }
      this.miningAutopilotArmed = true
    } else if (command !== 'mine' && command !== 'get_status' && command !== 'get_location' && command !== 'get_cargo') {
      if (this.miningAutopilotArmed) {
        this.log('system', `Mining autopilot disarmed by command change: ${command}. chained_mines=${this.miningAutopilotChainCount}`)
      }
      this.miningAutopilotArmed = false
      this.miningAutopilotChainCount = 0
    }

    if (command === 'undock' && !result.error && (result.meta?.pending || (result.result && typeof result.result === 'object' && (result.result as Record<string, unknown>).pending === true))) {
      this.notePendingMutationObserved('undock pending; waiting for state change')
    }
  }

  private parseActionResultCommand(notification: unknown): string | null {
    if (!notification || typeof notification !== 'object') return null
    const record = notification as Record<string, unknown>
    const type = String(record.type || record.msg_type || '').toLowerCase()
    if (type !== 'action_result') return null
    const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : null
    const command = typeof payload?.command === 'string' ? payload.command.trim().toLowerCase() : ''
    return command || null
  }

  private getCargoRatio(): number | null {
    const cargo = this.getCargoUsage()
    if (cargo.used === null || cargo.capacity === null || cargo.capacity <= 0) return null
    return cargo.used / cargo.capacity
  }

  private canContinueMiningFromGameState(): boolean {
    const location = (this._gameState?.location as Record<string, unknown> | undefined) || {}
    const player = (this._gameState?.player as Record<string, unknown> | undefined) || {}
    const modules = Array.isArray(this._gameState?.modules) ? this._gameState?.modules : []
    const poi = resolvePoiSnapshot(location, player)
    const fitKind = classifyMiningFit(modules)
    if (isDockedPoi(poi.type, poi.name)) return false
    if (!isResourcePoi(poi.type, poi.name)) return false
    if (fitKind === 'none') return false
    if (fitKind === 'mixed') return true
    const poiType = String(poi.type || '').toLowerCase()
    if (poiType.includes('asteroid')) return fitKind === 'ore'
    if (poiType.includes('ice')) return fitKind === 'ice'
    if (poiType.includes('gas')) return fitKind === 'gas'
    return true
  }

  private async maybeContinueMiningAutopilot(notification: unknown): Promise<void> {
    if (!this.connection || !this.miningAutopilotArmed || this.miningAutopilotRunning) return
    if (this.parseActionResultCommand(notification) !== 'mine') return

    this.miningAutopilotRunning = true
    try {
      const [cargoResp, locationResp] = await Promise.all([
        this.executeSilentQuery('get_cargo'),
        this.executeSilentQuery('get_location'),
      ])
      if (cargoResp) this.cacheGameState(cargoResp)
      if (locationResp) this.cacheGameState(locationResp)

      const cargoRatio = this.getCargoRatio()
      if (cargoRatio !== null && cargoRatio >= 0.95) {
        this.miningAutopilotArmed = false
        this.log('system', `Mining autopilot stopped: cargo reached ${Math.round(cargoRatio * 100)}%. chained_mines=${this.miningAutopilotChainCount}`)
        this.miningAutopilotChainCount = 0
        return
      }

      if (!this.canContinueMiningFromGameState()) {
        this.miningAutopilotArmed = false
        this.log('system', `Mining autopilot stopped: current live state is no longer a compatible mining situation. chained_mines=${this.miningAutopilotChainCount}`)
        this.miningAutopilotChainCount = 0
        return
      }

      this.miningAutopilotChainCount += 1
      this.log('system', `Mining autopilot: repeating mine without LLM because cargo/fit/location still qualify. chained_mines=${this.miningAutopilotChainCount}`)
      const result = await this.connection.execute('mine')
      this.cacheGameState(result)
      this.noteCommandOutcome('mine', result)

      const resultText = result.error
        ? `Mining autopilot mine failed: ${result.error.code}: ${result.error.message}`
        : 'Mining autopilot issued mine.'
      this.log('tool_call', 'auto_mining: game(mine)')
      this.log('tool_result', resultText, JSON.stringify(result, null, 2))

      if (result.error) {
        this.log('system', `Mining autopilot stopped: mine execution failed. chained_mines=${this.miningAutopilotChainCount}`)
        this.miningAutopilotArmed = false
        this.miningAutopilotChainCount = 0
      }
    } finally {
      this.miningAutopilotRunning = false
    }
  }

  private async maybeRunDockedRecoveryAction(): Promise<boolean> {
    if (!this.connection) return false
    if (this.commandResultStillPending({ result: this._gameState || {} })) return false
    if (Date.now() - this.lastMutationAt > 2 * 60_000) return false

    const docked = this.isLikelyDocked()

    if (docked && this.lastMutationCommand === 'undock') {
      this.log('system', 'Verified docked state after unresolved undock flow; issuing one automatic undock recovery action')
      this.log('tool_call', 'auto_recovery: game(undock)')
      const resp = await this.connection.execute('undock')
      this.cacheGameState(resp)
      this.noteCommandOutcome('undock', resp)

      const resultText = resp.error
        ? `Automatic undock recovery failed: ${resp.error.code}: ${resp.error.message}`
        : 'Automatic undock recovery sent.'
      this.log('tool_result', resultText, JSON.stringify(resp, null, 2))
      return !resp.error
    }

    if (!docked && this.lastMutationCommand === 'dock') {
      this.log('system', 'Verified undocked state after unresolved dock flow; issuing one automatic dock recovery action')
      this.log('tool_call', 'auto_recovery: game(dock)')
      const resp = await this.connection.execute('dock')
      this.cacheGameState(resp)
      this.noteCommandOutcome('dock', resp)

      const resultText = resp.error
        ? `Automatic dock recovery failed: ${resp.error.code}: ${resp.error.message}`
        : 'Automatic dock recovery sent.'
      this.log('tool_result', resultText, JSON.stringify(resp, null, 2))
      return !resp.error
    }

    return false
  }

  private commandResultStillPending(result: CommandResult | null): boolean {
    const data = ((result?.structuredContent ?? result?.result) as Record<string, unknown> | undefined) || {}
    const queue = (data.queue as Record<string, unknown> | undefined) || {}
    const location = (data.location as Record<string, unknown> | undefined) || {}
    const pendingNavigation = getPendingNavigation(this.profileId)
    const currentTick = toFiniteNumber(
      data.current_tick
      ?? data.tick
      ?? location.current_tick
      ?? location.tick
      ?? result?.meta?.tick,
    )
    const etaTick = pendingNavigation?.etaTick
      ?? toFiniteNumber(location.transit_arrival_tick ?? data.transit_arrival_tick ?? location.arrival_tick ?? data.arrival_tick)
    if (queue.has_pending === true) return true
    if (location.in_transit === true) return true
    if (etaTick !== null && etaTick !== undefined) {
      if (currentTick === null) return true
      if (currentTick < etaTick) return true
    }
    return false
  }

  private async maybeHandlePendingServerResolution(context: Context): Promise<boolean> {
    if (!this.abortController?.signal || !this.hasPendingServerResolution()) return false

    const now = Date.now()
    const waitMs = this.pendingWaitStartedAt > 0 ? now - this.pendingWaitStartedAt : 0
    if (now < this.reconnectStormCooldownUntil) {
      const remainingMs = this.reconnectStormCooldownUntil - now
      this.setActivity('Cooling off after reconnect storm...')
      await abortableSleep(Math.min(Math.max(remainingMs, PENDING_WAIT_SLEEP_MS), 5_000), this.abortController.signal)
      return true
    }
    const needsVerification = Boolean(this.pendingRecoveryReason)
      || waitMs >= PENDING_RECOVERY_MAX_WAIT_MS
      || this.loopsSincePendingMutation >= MUTATION_STALL_NUDGE_THRESHOLD

    if (!needsVerification) {
      this.setActivity('Waiting for server tick/action result...')
      await abortableSleep(PENDING_WAIT_SLEEP_MS, this.abortController.signal)
      return true
    }

    if (now - this.lastPendingVerificationAt < PENDING_RECOVERY_VERIFY_COOLDOWN_MS) {
      this.setActivity('Waiting before next pending-state verification...')
      await abortableSleep(PENDING_WAIT_SLEEP_MS, this.abortController.signal)
      return true
    }

    this.lastPendingVerificationAt = now
    const recoveryReason = this.pendingRecoveryReason || 'pending action exceeded local wait threshold'
    this.setActivity('Verifying pending server state...')

    const hasPendingNavigation = !!getPendingNavigation(this.profileId)
    const { statusResp, locationResp, queueResp } = await this.queryPendingResolutionState(hasPendingNavigation)

    const stillPending = this.commandResultStillPending(statusResp)
      || this.commandResultStillPending(locationResp)
      || this.commandResultStillPending(queueResp)
    if (stillPending) {
      this.notePendingMutationObserved()
      this.pendingRecoveryReason = null
      this.log('system', `Pending action still unresolved after recovery check: ${recoveryReason}`)
      await abortableSleep(PENDING_WAIT_SLEEP_MS, this.abortController.signal)
      return true
    }

    this.resetPendingMutationTracking()
    if (await this.maybeRunDockedRecoveryAction()) {
      return true
    }
    context.messages.push({
      role: 'user' as const,
      content: [
        '## Pending Action Recovery',
        `Admiral locally re-verified state after waiting because: ${recoveryReason}.`,
        'Fresh state was fetched directly from the server. Reassess from the latest verified state before issuing any new mutation.',
      ].join('\n\n'),
      timestamp: Date.now(),
    })
    this.log('system', `Pending action resolved or invalidated after recovery check: ${recoveryReason}`)
    return false
  }

  private getCargoUsage(): { used: number | null; capacity: number | null } {
    const ship = (this._gameState?.ship as Record<string, unknown> | undefined) || {}
    return {
      used: toFiniteNumber(ship.cargo_used),
      capacity: toFiniteNumber(ship.cargo_capacity),
    }
  }

  private isLikelyDocked(): boolean {
    const location = (this._gameState?.location as Record<string, unknown> | undefined) || {}
    const player = (this._gameState?.player as Record<string, unknown> | undefined) || {}
    const poi = resolvePoiSnapshot(location, player)
    return isDockedPoi(poi.type, poi.name)
  }

  private async collectFreeTelemetry(): Promise<string | null> {
    const statusResp = await this.executeSilentQuery('get_status')
    if (!statusResp || statusResp.error) return null
    this.cacheGameState(statusResp)

    this.telemetryCycle++

    const sections: string[] = []
    const verifiedState = formatVerifiedGameState(this._gameState)
    if (verifiedState) sections.push(`Verified state:\n${verifiedState}`)

    const cargoInfo = await this.collectCargoTelemetry()
    if (cargoInfo) sections.push(cargoInfo)

    const cargo = this.getCargoUsage()
    const cargoRatio = cargo.used !== null && cargo.capacity ? cargo.used / cargo.capacity : null
    const likelyDocked = this.isLikelyDocked()

    if (likelyDocked && (this.telemetryCycle % MARKET_TELEMETRY_INTERVAL === 0 || (cargoRatio !== null && cargoRatio >= 0.75))) {
      const marketInfo = await this.collectMarketTelemetry()
      if (marketInfo) sections.push(marketInfo)
    }

    if (likelyDocked && this.telemetryCycle % SHIP_TELEMETRY_INTERVAL === 0) {
      const shipInfo = await this.collectShipTelemetry()
      if (shipInfo) sections.push(shipInfo)
    }

    if (sections.length === 0) return null
    return [
      '## Automatic Telemetry',
      'Admiral refreshed free query commands directly. Treat this snapshot as current and prefer using it instead of re-running routine get_status/get_cargo checks unless you need a fresher answer after an action.',
      ...sections,
    ].join('\n\n')
  }

  private async collectCargoTelemetry(): Promise<string | null> {
    const cargoResp = await this.executeSilentQuery('get_cargo')
    if (!cargoResp || cargoResp.error) return null
    const data = ((cargoResp.structuredContent ?? cargoResp.result) as Record<string, unknown> | undefined) || {}
    const entries = extractCargoEntries(data)
    const cargo = this.getCargoUsage()
    const lines: string[] = []
    if (cargo.used !== null && cargo.capacity !== null) {
      const percent = cargo.capacity > 0 ? Math.round((cargo.used / cargo.capacity) * 100) : 0
      lines.push(`Cargo load: ${cargo.used}/${cargo.capacity} (${percent}%)`)
      if (percent >= 85) lines.push('Cargo is nearly full. Prefer unloading/selling over continued mining.')
    }
    if (entries.length > 0) {
      const summary = entries
        .slice(0, 6)
        .map((entry) => `${entry.name} x${entry.quantity}`)
        .join(', ')
      lines.push(`Cargo manifest: ${summary}`)
      const oreEntries = entries.filter((entry) => /ore|ice|gas/i.test(entry.id) || /ore|ice|gas/i.test(entry.name))
      if (oreEntries.length > 0) {
        lines.push(`Sellable raw materials onboard: ${oreEntries.map((entry) => `${entry.name} x${entry.quantity}`).join(', ')}`)
      }
    } else {
      lines.push('Cargo manifest: empty')
    }
    return lines.join('\n')
  }

  private async collectMarketTelemetry(): Promise<string | null> {
    const [marketResp, personalOrdersResp, bestSellSummary] = await Promise.all([
      this.executeSilentQuery('view_market', { category: 'ore' }),
      this.executeSilentQuery('view_orders', { scope: 'personal', order_type: 'sell', sort_by: 'price_asc', page: 1, page_size: 20 }),
      this.fetchBestSellSummary('ore'),
    ])

    const sections: string[] = []
    if (marketResp && !marketResp.error) {
      const data = ((marketResp.structuredContent ?? marketResp.result) as Record<string, unknown> | undefined) || {}
      const summary = summarizeMarket(data)
      if (summary) sections.push(`Ore market snapshot:\n${summary}`)
    }

    if (personalOrdersResp && !personalOrdersResp.error) {
      const data = ((personalOrdersResp.structuredContent ?? personalOrdersResp.result) as Record<string, unknown> | undefined) || {}
      const summary = summarizeSellOrders(data)
      if (summary) sections.push(`Personal sell orders:\n${summary}`)
    }

    if (bestSellSummary) {
      sections.push(`Best sell hints:\n${bestSellSummary}`)
    }

    return sections.length > 0 ? sections.join('\n\n') : null
  }

  private async fetchBestSellSummary(category: string): Promise<string | null> {
    const stationId = getCurrentStationId(this._gameState)
    if (!stationId) return null
    const port = process.env.PORT || '3031'
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const resp = await fetch(`${baseUrl}/api/economy/market/best-sell?station_id=${encodeURIComponent(stationId)}&category=${encodeURIComponent(category)}&limit=3`)
      if (!resp.ok) return null
      const data = await resp.json() as { best?: Array<{ summary?: string | null }> }
      const lines = Array.isArray(data.best)
        ? data.best
          .map((entry) => typeof entry.summary === 'string' ? entry.summary.trim() : '')
          .filter((entry) => entry.length > 0)
        : []
      return lines.length > 0 ? lines.join('\n') : null
    } catch {
      return null
    }
  }

  private async collectShipTelemetry(): Promise<string | null> {
    const commissionableCatalogResp = await this.executeSilentQuery('catalog', { type: 'ships', commissionable: true })
    const browseResp = await this.executeSilentQuery('browse_ships', {})
    const commissionableItems = commissionableCatalogResp?.error ? [] : extractShipOffers((commissionableCatalogResp?.structuredContent ?? commissionableCatalogResp?.result) as Record<string, unknown> | undefined)
    const listedItems = browseResp?.error ? [] : extractShipOffers((browseResp?.structuredContent ?? browseResp?.result) as Record<string, unknown> | undefined)
    const combined = await applyCommissionQuotes(this.connection!, this.profileId, dedupeShipOffers([
      ...commissionableItems,
      ...listedItems,
    ]))
    if (combined.length === 0) return null

    const credits = toFiniteNumber(((this._gameState?.player as Record<string, unknown> | undefined) || {}).credits)
    const sorted = [...combined].sort((a, b) => {
      const aPrice = a.price ?? Number.MAX_SAFE_INTEGER
      const bPrice = b.price ?? Number.MAX_SAFE_INTEGER
      return aPrice - bPrice
    })
    const priced = sorted.filter((offer) => offer.price !== null)
    const affordable = credits !== null ? priced.filter((offer) => (offer.price ?? Number.MAX_SAFE_INTEGER) <= credits) : []
    const chosen = affordable.length > 0
      ? affordable.slice(0, 5)
      : priced.length > 0
        ? priced.slice(0, 5)
        : sorted.slice(0, 5)

    if (chosen.length === 0) return null

    const lines = chosen.map((offer) => {
      const price = offer.price !== null ? `${offer.price} cr` : 'price unknown'
      const label = [offer.name, offer.classId].filter(Boolean).join(' / ')
      const extras = [
        offer.category ? `category ${offer.category}` : '',
        offer.buildMaterials.length > 0 ? `build ${formatMaterialRequirements(offer.buildMaterials)}` : '',
        offer.requiredSkills && Object.keys(offer.requiredSkills).length > 0 ? `skills ${formatRequiredSkills(offer.requiredSkills)}` : '',
      ].filter(Boolean)
      return `- ${label || 'Unknown ship'} at ${price}${extras.length > 0 ? ` (${extras.join('; ')})` : ''}`
    })
    const header = affordable.length > 0
      ? 'Affordable ship opportunities:'
      : priced.length > 0
        ? 'Nearby ship opportunities to monitor:'
        : 'Nearby ship opportunities (quote unavailable):'
    return `${header}\n${lines.join('\n')}`
  }

  private log: LogFn = (type, summary, detail?) => {
    const id = addLogEntry(this.profileId, type, summary, detail)
    this.events.emit('log', { id, profile_id: this.profileId, type, summary, detail, timestamp: new Date().toISOString() })
  }

  async connect(): Promise<void> {
    const profile = getProfile(this.profileId)
    if (!profile) throw new Error('Profile not found')

    this.setActivity('Connecting...')
    this.log('connection', `Connecting via ${profile.connection_mode}...`)

    this.connection = createConnection(profile)

    // Wire up spec log for connections that fetch OpenAPI specs
    if (this.connection instanceof HttpV2Connection) {
      this.connection.setSpecLog((type, msg) => {
        this.log(type === 'error' ? 'error' : 'system', msg)
      })
    }
    if (this.connection instanceof WebSocketV2Connection) {
      this.connection.setTransportLog((type, msg) => {
        if (this.hasPendingServerResolution()) {
          const lower = msg.toLowerCase()
          if (lower.includes('closed') || lower.includes('error')) {
            this.pendingRecoveryReason = 'connection interruption while awaiting server resolution'
          } else if (lower.includes('opened')) {
            this.pendingRecoveryReason = 'connection recovered while awaiting server resolution'
          }
        }
        this.log(type === 'error' ? 'error' : 'connection', msg)
      })
    }

    try {
      await this.connection.connect()
      this.setActivity('idle')
      this.log('connection', `Connected via ${profile.connection_mode}`)
    } catch (err) {
      this.setActivity('idle')
      this.log('error', `Connection failed: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }

    // Set up notification handler
      this.connection.onNotification((n) => {
      updatePendingNavigationFromNotification(this.profileId, n)
      ingestRuntimeNotification(this.profileId, n)
      ingestTradeNotification(this.profileId, n, this._gameState)
      if (isReconnectNotification(n)) {
        if (this.hasPendingServerResolution()) {
          this.pendingRecoveryReason = 'server reconnect notification during pending action'
          this.noteReconnectDuringPendingResolution()
        }
        const detail = formatReconnectDetail(n)
        this.log('connection', formatNotificationSummary(n), detail ?? JSON.stringify(n, null, 2))
        void Promise.all([
          this.executeSilentQuery('get_status'),
          this.executeSilentQuery('get_location'),
        ])
          .then(([statusResp, locationResp]) => {
            if (statusResp) this.cacheGameState(statusResp)
            if (locationResp) this.cacheGameState(locationResp)
            this.log('system', 'Automatic status/location refresh triggered after reconnect notification')
          })
          .catch(() => {})
        return
      }
      this.log('notification', formatNotificationSummary(n), JSON.stringify(n, null, 2))
      void this.maybeContinueMiningAutopilot(n).catch((err) => {
        this.miningAutopilotArmed = false
        this.log('error', `Mining autopilot failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    })

    // Login if credentials exist
    if (profile.username && profile.password) {
      this.log('connection', `Logging in as ${profile.username}...`)
      const result = await this.connection.login(profile.username, profile.password)
      if (result.success) {
        this.log('connection', `Logged in as ${profile.username}`)
      } else {
        this.log('error', `Login failed: ${result.error}`)
      }
    }

    // Fetch initial game state (best-effort)
    try {
      const statusResp = await this.connection.execute('get_status')
      this.cacheGameState(statusResp)
    } catch { /* ignore */ }

    // For modern websocket/v2 setups, immediately reconcile stale local pending
    // navigation flags against the server's actual queue state.
    if (profile.connection_mode === 'websocket_v2' || profile.connection_mode === 'http_v2' || profile.connection_mode === 'mcp_v2') {
      try {
        const queueResp = await this.connection.execute('v2_get_queue')
        reconcilePendingNavigationWithStatus(this.profileId, queueResp)
      } catch { /* ignore */ }
    }
  }

  async startLLMLoop(): Promise<void> {
    const profile = getProfile(this.profileId)
    if (!profile) throw new Error('Profile not found')
    if (!profile.provider || !profile.model) throw new Error('No LLM provider/model configured')
    if (!this.connection) throw new Error('Not connected')

    this.running = true
    this.abortController = new AbortController()

    this.log('system', `Starting LLM loop with ${profile.provider}/${profile.model}`)

    const { model, apiKey, failoverApiKey } = await resolveModel(`${profile.provider}/${profile.model}`)
    let failoverModel: Model<any> | undefined
    let failoverModelApiKey: string | undefined = failoverApiKey
    if (profile.failover_provider && profile.failover_model) {
      try {
        const resolved = await resolveModel(`${profile.failover_provider}/${profile.failover_model}`)
        failoverModel = resolved.model
        failoverModelApiKey = resolved.apiKey || resolved.failoverApiKey || failoverModelApiKey
      } catch (err) {
        this.log('error', `Failover model invalid: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // Fetch game commands - MCP v2 uses tool discovery, others use OpenAPI
    const specLog = (type: 'info' | 'warn' | 'error', msg: string) => {
      this.log(type === 'error' ? 'error' : 'system', msg)
    }
    let commandList: string
    if (profile.connection_mode === 'mcp_v2' && this.connection instanceof McpV2Connection) {
      commandList = this.connection.getCommandList()
      this.log('system', `Discovered ${this.connection.toolCount} v2 commands`)
    } else if ((profile.connection_mode === 'websocket' || profile.connection_mode === 'websocket_v2') && this.connection) {
      const resp = await this.connection.execute('get_commands').catch(() => null)
      const commands = resp && !resp.error ? parseRuntimeCommandResult(resp.result) : []
      if (commands.length > 0) {
        commandList = formatCommandList(commands)
        this.log('system', `Loaded ${commands.length} runtime game commands`)
      } else {
        const serverUrl = profile.server_url.replace(/\/$/, '')
        const apiVersion = profile.connection_mode === 'websocket_v2' ? 'v2' : 'v1'
        const fallbackCommands = await fetchGameCommands(`${serverUrl}/api/${apiVersion}`, specLog)
        commandList = formatCommandList(fallbackCommands)
        this.log('system', `Loaded ${fallbackCommands.length} game commands`)
      }
    } else {
      const serverUrl = profile.server_url.replace(/\/$/, '')
      const apiVersion = profile.connection_mode === 'http_v2' || profile.connection_mode === 'websocket_v2' ? 'v2' : 'v1'
      const commands = await fetchGameCommands(`${serverUrl}/api/${apiVersion}`, specLog)
      commandList = formatCommandList(commands)
      this.log('system', `Loaded ${commands.length} game commands`)
    }

    // Build initial context
    ensureProfileAgentsFromDirective(profile)
    const systemPrompt = buildSystemPrompt(profile, commandList)
    const context: Context = {
      systemPrompt,
      messages: [{
        role: 'user' as const,
        content: `Begin your mission: ${profile.directive || 'Play the game. Mine ore, sell it, and grow stronger.'}`,
        timestamp: Date.now(),
      }],
      tools: allTools,
    }
    let resumeRequest: { id: number; idempotencyKey: string; attemptCount?: number } | undefined

    const pending = getLatestPendingLlmRequest(this.profileId)
    if (pending?.messages_json) {
      try {
        const restored = JSON.parse(pending.messages_json)
        if (Array.isArray(restored) && restored.length > 0) {
          context.messages = restored as Message[]
          context.systemPrompt = pending.system_prompt || context.systemPrompt
          resumeRequest = {
            id: pending.id,
            idempotencyKey: pending.idempotency_key,
            attemptCount: pending.attempt_count || 0,
          }
          this.log('system', `Recovered pending LLM request ${pending.id} for replay`)
        }
      } catch (err) {
        this.log('error', `Failed to parse pending LLM request snapshot: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    this.memorySummary = loadProfileMemory(this.profileId)
    this.lastSavedMemory = this.memorySummary
    this.learningContext = buildLearningContext(this.profileId)
    this.learningContextDirty = false
    if (this.memorySummary) {
      context.messages.push({
        role: 'user' as const,
        content: `## Session History Summary\n\n${this.memorySummary}\n\n---\nUse this as persistent memory from earlier runs.`,
        timestamp: Date.now(),
      })
      this.log('system', 'Loaded persistent profile memory')
      const memoryIntegrityWarning = buildMemoryIntegrityWarning(this.memorySummary)
      if (memoryIntegrityWarning) {
        context.messages.push({
          role: 'user' as const,
          content: memoryIntegrityWarning,
          timestamp: Date.now(),
        })
        this.log('system', 'Persistent memory flagged as potentially stale or poisoned')
      }
    }
    if (this.learningContext) {
      this.lastLearningContextInjectedAt = Date.now()
      context.messages.push({
        role: 'user' as const,
        content: `${this.learningContext}\n\nUse this structured profile as persistent development context. Prefer measured strengths/weaknesses and learned rules over improvising a new personality each turn.`,
        timestamp: Date.now(),
      })
      this.log('system', 'Loaded structured agent learning context')
    }

    const compaction: CompactionState = { summary: this.memorySummary }
    const todo = { value: profile.todo || '' }
      let idleLoopCount = 0

    while (this.running) {
      // Reset abort controller if it was used (e.g. by a nudge wakeup)
      if (this.abortController.signal.aborted) {
        this.abortController = new AbortController()
      }

      // Handle restart request (directive changed)
      if (this.restartRequested) {
        this.restartRequested = false
        this.abortController = new AbortController()

        const freshProfile = getProfile(this.profileId)
        if (freshProfile) {
          context.systemPrompt = buildSystemPrompt(freshProfile, commandList)
          const directive = freshProfile.directive || 'Play the game. Mine ore, sell it, and grow stronger.'
          context.messages.push({
            role: 'user' as const,
            content: `## Directive Updated\nYour mission has changed. New directive: ${directive}\n\nAdjust your strategy and actions to follow this new directive immediately.`,
            timestamp: Date.now(),
          })
          this.log('system', `Directive updated, restarting turn: ${directive}`)
        }
      }

      try {
        if (await this.maybeHandlePendingServerResolution(context)) {
          if (!this.running) break
          if (this.restartRequested) continue
          continue
        }

        if (is429PredictionEnabled()) {
          const rateRisk = predict429Risk(this.profileId)
          if (rateRisk.level !== this.lastRateRiskLevel) {
            this.lastRateRiskLevel = rateRisk.level
            if (rateRisk.level === 'HIGH' || rateRisk.level === 'MEDIUM') {
              this.log('system', `Rate-limit backoff active: ${rateRisk.reason}`)
            }
          }
          if (rateRisk.level === 'HIGH') {
            this.setActivity('Backing off for rate limit pressure...')
            await abortableSleep(15_000, this.abortController.signal)
            if (!this.running || this.restartRequested) continue
          } else if (rateRisk.level === 'MEDIUM') {
            this.setActivity('Backing off for rate limit pressure...')
            await abortableSleep(5_000, this.abortController.signal)
            if (!this.running || this.restartRequested) continue
          }
        }

        const maxTurnsStr = getPreference('max_turns')
        const maxToolRounds = maxTurnsStr ? parseInt(maxTurnsStr, 10) || undefined : undefined
        const llmTimeoutStr = getPreference('llm_timeout')
        const llmTimeoutMs = llmTimeoutStr ? parseInt(llmTimeoutStr, 10) * 1000 || undefined : undefined
        const freshForBudget = getProfile(this.profileId)
        const contextBudgetRatio = freshForBudget?.context_budget ?? undefined
        const compactInputEnabled = getPreference('compact_input_enabled') === 'true'
        const compactInputProvider = (getPreference('compact_input_provider') || '').trim()
        const compactInputModel = (getPreference('compact_input_model') || '').trim()
        const altSolverEnabled = getPreference('alt_solver_enabled') === 'true'
        const altSolverProvider = (getPreference('alt_solver_provider') || '').trim()
        const altSolverModel = (getPreference('alt_solver_model') || '').trim()
        let compactionModel: Model<any> | undefined
        let compactionApiKey: string | undefined
        let advisorModel: Model<any> | undefined
        let advisorApiKey: string | undefined
        if (compactInputEnabled && compactInputModel) {
          try {
            const compactModelSpec = compactInputModel.includes('/')
              ? compactInputModel
              : (compactInputProvider ? `${compactInputProvider}/${compactInputModel}` : '')
            if (compactModelSpec) {
              const resolvedCompaction = await resolveModel(compactModelSpec)
              compactionModel = resolvedCompaction.model
              compactionApiKey = resolvedCompaction.apiKey || resolvedCompaction.failoverApiKey
            }
          } catch (err) {
            this.log('error', `Compact-input model invalid: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        if (altSolverEnabled && altSolverModel) {
          try {
            const altModelSpec = altSolverModel.includes('/')
              ? altSolverModel
              : (altSolverProvider ? `${altSolverProvider}/${altSolverModel}` : '')
            if (altModelSpec) {
              const resolvedAdvisor = await resolveModel(altModelSpec)
              advisorModel = resolvedAdvisor.model
              advisorApiKey = resolvedAdvisor.apiKey || resolvedAdvisor.failoverApiKey
            }
          } catch (err) {
            this.log('error', `Alt-solver model invalid: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        this.setActivity('Waiting for LLM response...')
        await runAgentTurn(
          model, context, this.connection, this.profileId,
          this.log, todo,
          {
            signal: this.abortController.signal,
            apiKey,
            failoverApiKey: failoverModelApiKey,
            failoverModel,
            failoverActive: this.llmFailoverActive,
            onFailoverActivated: () => {
              if (!this.llmFailoverActive) {
                this.llmFailoverActive = true
                this.log('system', 'LLM failover activated')
              }
            },
            onPrimaryRecovered: () => {
              if (this.llmFailoverActive) {
                this.llmFailoverActive = false
                this.log('system', 'Primary LLM provider recovered; failover disabled')
              }
            },
            maxToolRounds,
            llmTimeoutMs,
            resumeRequest,
            contextBudgetRatio,
            compactInputEnabled,
            compactionModel,
            compactionApiKey,
            advisorEnabled: altSolverEnabled,
            advisorModel,
            advisorApiKey,
            gameState: this._gameState,
            onActivity: (a) => this.setActivity(a),
            onAdaptiveContext: (info) => {
              this._adaptiveMode = info.mode
              this._effectiveContextBudgetRatio = info.effectiveRatio
            },
            onGameCommandResult: (command, args, result) => {
              this.noteCommandOutcome(command, result)
              const changed = recordCommandOutcome(this.profileId, command, args, result, this._gameState)
              if (changed) {
                this.refreshLearningContext()
              }
            },
          },
          compaction,
        )
        resumeRequest = undefined

        if (compaction.summary && compaction.summary !== this.lastSavedMemory) {
          saveProfileMemory(this.profileId, compaction.summary)
          this.memorySummary = compaction.summary
          this.lastSavedMemory = compaction.summary
        }
      } catch (err) {
        if (!this.running) break
        if (this.restartRequested) continue
        this.log('error', `Turn error: ${err instanceof Error ? err.message : String(err)}`)
      }

      if (!this.running) break
      if (this.restartRequested) continue
      this.setActivity('Sleeping between turns...')
      await abortableSleep(TURN_INTERVAL, this.abortController.signal)
      if (!this.running) break
      if (this.restartRequested) continue

      this.setActivity('Polling for events...')
      // Poll for events between turns
      let pendingEvents = ''
      try {
        const pollResp = await this.connection.execute('get_status')
        this.cacheGameState(pollResp)
        const notifications = Array.isArray(pollResp.notifications) ? pollResp.notifications : []
        const sawActionResult = notifications.some((n) => isActionResultNotification(n))
        const sawPendingMutation = notifications.some((n) => isPendingMutationNotification(n))
        if (sawActionResult) {
          this.resetPendingMutationTracking()
        } else if (this.pendingMutationObserved) {
          this.loopsSincePendingMutation++
          this.loopsSinceActionResult++
        }
        if (sawPendingMutation) {
          this.notePendingMutationObserved()
        }
        if (notifications.length > 0) {
          pendingEvents = notifications
            .map(n => {
              const s = formatNotificationSummary(n)
              return `  > ${s}`
            })
            .join('\n')

          if (shouldForceStateRefreshFromNotifications(notifications)) {
            const refreshResp = await this.connection.execute('get_status')
            this.cacheGameState(refreshResp)
            this.log('system', 'Automatic state refresh triggered after dock/undock-related notification')
            pendingEvents += '\n  > [SYSTEM] Automatic recovery: refreshed state with get_status after dock/undock event.'
            this.pendingRecoveryNudge = buildRecoveryNudge(notifications, this._gameState)
          }
        }
      } catch {
        // Best-effort
      }

      const nudgeParts: string[] = []
      if (pendingEvents) nudgeParts.push('## Events Since Last Action\n' + pendingEvents + '\n')

      const telemetryNudge = await this.collectFreeTelemetry()
      if (telemetryNudge) nudgeParts.push(telemetryNudge)

      const decisionPressure = getDecisionPressureSnapshot(this.profileId)
      if (decisionPressure.recommendation) {
        nudgeParts.push([
          '## Decision Pressure',
          decisionPressure.recommendation,
          `Current signals: query_streak=${decisionPressure.queryStreak}, same_query_streak=${decisionPressure.sameQueryStreak}, no_progress_streak=${decisionPressure.noProgressStreak}${decisionPressure.lastQueryCommand ? `, last_query=${decisionPressure.lastQueryCommand}` : ''}.`,
        ].join('\n\n'))
      }

      const mutationStateNudge = buildMutationStateNudge(this.mutationState, this.mutationStateDetail, this._gameState)
      if (mutationStateNudge) nudgeParts.push(mutationStateNudge)

      const navigationStateNudge = buildNavigationStateNudge(this.navigationState, this.navigationStateDetail, this._gameState)
      if (navigationStateNudge) nudgeParts.push(navigationStateNudge)

      this.refreshLearningContext()
      const updatedLearningContext = this.consumeLearningContextUpdate()
      if (updatedLearningContext) {
        nudgeParts.push(`## Learned Model Update\n\n${updatedLearningContext}`)
        this.log('system', 'Structured agent learning context updated')
      }

      const stallNudge = buildMutationStallNudge(
        this.pendingMutationObserved,
        this.loopsSincePendingMutation,
        this.loopsSinceActionResult,
        this._gameState,
        MUTATION_STALL_NUDGE_THRESHOLD,
      )
      if (stallNudge) {
        nudgeParts.push(stallNudge)
        this.log('system', 'Mutation stall recovery nudge delivered after prolonged pending state without action_result')
      }

      const localStuckSummary = buildLocalMutationStuckSummary(
        this.loopsSincePendingMutation,
        this.loopsSinceActionResult,
        this._gameState,
        LOCAL_MUTATION_STUCK_THRESHOLD,
      )
      if (this.pendingMutationObserved && localStuckSummary && !this.localMutationStuckReported) {
        this.localMutationStuckReported = true
        this.log('system', localStuckSummary)
      }

      // Drain any human nudges
      if (this.pendingNudges.length > 0) {
        const nudges = this.pendingNudges.splice(0)
        for (const n of nudges) {
          nudgeParts.push(`## Human Nudge\nYour human operator has sent you guidance: ${n}\nTake this into account for your next actions.\n`)
          this.log('system', `Nudge delivered: ${n.slice(0, 100)}`)
        }
      }
      if (this.pendingRecoveryNudge) {
        nudgeParts.push(this.pendingRecoveryNudge)
        this.log('system', 'Recovery re-plan nudge delivered after contradictory action outcome')
        this.pendingRecoveryNudge = null
      }
      if (nudgeParts.length > 0) {
        idleLoopCount = 0
        nudgeParts.push('Continue your mission.')
        context.messages.push({
          role: 'user' as const,
          content: nudgeParts.join('\n'),
          timestamp: Date.now(),
        })
      } else {
        idleLoopCount++
        if (idleLoopCount >= CONTINUE_NUDGE_INTERVAL) {
          idleLoopCount = 0
          context.messages.push({
            role: 'user' as const,
            content: 'Continue your mission.',
            timestamp: Date.now(),
          })
        }
      }

      // Refresh system prompt with latest credentials
      const freshProfile = getProfile(this.profileId)
      if (freshProfile) {
        context.systemPrompt = buildSystemPrompt(freshProfile, commandList)
      }
    }

    this.running = false
    this.setActivity('idle')
    if (compaction.summary && compaction.summary !== this.lastSavedMemory) {
      saveProfileMemory(this.profileId, compaction.summary)
      this.memorySummary = compaction.summary
      this.lastSavedMemory = compaction.summary
    }
    this.log('system', 'Agent loop stopped')
  }

  getMemory(): string {
    if (this.memorySummary) return this.memorySummary
    const loaded = loadProfileMemory(this.profileId)
    this.memorySummary = loaded
    this.lastSavedMemory = loaded
    return loaded
  }

  saveMemory(): boolean {
    const memory = this.getMemory()
    if (!memory.trim()) return false
    saveProfileMemory(this.profileId, memory)
    this.lastSavedMemory = memory
    this.log('system', 'Persistent memory saved')
    return true
  }

  resetMemory(): void {
    resetProfileMemory(this.profileId)
    this.memorySummary = ''
    this.lastSavedMemory = ''
    this.log('system', 'Persistent memory reset')
  }

  async executeCommand(command: string, args?: Record<string, unknown>): Promise<CommandResult> {
    if (!this.connection) {
      return { error: { code: 'not_connected', message: 'Not connected' } }
    }

    this.log('tool_call', `manual: ${command}(${args ? JSON.stringify(args) : ''})`)
    const primaryResult = await this.connection.execute(command, args)
    const result = await this.maybeFallbackToHttpV2(command, args, primaryResult, true)

    if (command === 'get_status' || command === 'get_location') this.cacheGameState(result)
    recordCommandOutcome(this.profileId, command, args, result, this._gameState)

    if (result.error) {
      this.log('tool_result', `Error: ${result.error.message}`, JSON.stringify(result, null, 2))
    } else {
      const summary = summarizeCommandResult(command, args, result)
      this.log('tool_result', summary, JSON.stringify(result, null, 2))
    }

    return result
  }

  private async maybeFallbackToHttpV2(
    command: string,
    args: Record<string, unknown> | undefined,
    result: CommandResult,
    emitLog: boolean,
  ): Promise<CommandResult> {
    if (!result.error) return result
    const fallbackCodes = new Set(['not_connected', 'disconnected', 'timeout', 'send_failed'])
    if (!fallbackCodes.has(result.error.code)) return result
    const fallback = await this.tryHttpV2Fallback(command, args, emitLog)
    return fallback ?? result
  }

  private async tryHttpV2Fallback(
    command: string,
    args: Record<string, unknown> | undefined,
    emitLog: boolean,
  ): Promise<CommandResult | null> {
    const profile = getProfile(this.profileId)
    if (!profile) return null
    if (profile.connection_mode !== 'websocket_v2') return null
    if (!HTTP_V2_FALLBACK_QUERY_COMMANDS.has(command)) return null
    if (!profile.username || !profile.password) return null

    const fallback = new HttpV2Connection(profile.server_url)
    try {
      await fallback.connect()
      const loginResult = await fallback.login(profile.username, profile.password)
      if (!loginResult.success) {
        if (emitLog) this.log('system', `HTTP v2 fallback login failed for ${command}: ${loginResult.error || 'unknown error'}`)
        return null
      }
      const result = await fallback.execute(command, args)
      if (emitLog) {
        if (result.error) {
          this.log('system', `HTTP v2 fallback for ${command} also failed: ${result.error.code}`)
        } else {
          this.log('system', `HTTP v2 fallback served ${command} after websocket_v2 transport failure`)
        }
      }
      return result
    } catch (err) {
      if (emitLog) this.log('system', `HTTP v2 fallback for ${command} failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    } finally {
      try {
        await fallback.disconnect()
      } catch {
        // ignore cleanup failures for one-shot fallback connections
      }
    }
  }

  /**
   * Lightweight stats poll that avoids writing tool_call/tool_result logs.
   */
  async sampleGameStatus(): Promise<{
    credits: number | null
    ore_mined: number | null
    trades_completed: number | null
    systems_explored: number | null
  } | null> {
    if (!this.connection) return null
    const result = await this.connection.execute('get_status', {})
    if (result.error) return null

    const data = (result.structuredContent ?? result.result) as Record<string, unknown> | undefined
    if (!data || typeof data !== 'object') return null
    const player = data.player as Record<string, unknown> | undefined
    const stats = (player?.stats as Record<string, unknown> | undefined) || {}
    const toNum = (v: unknown): number | null => {
      if (typeof v === 'number' && Number.isFinite(v)) return v
      if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v)
        return Number.isFinite(n) ? n : null
      }
      return null
    }

    return {
      credits: toNum(player?.credits),
      ore_mined: toNum(stats.ore_mined),
      trades_completed: toNum(stats.trades_completed),
      systems_explored: toNum(stats.systems_explored),
    }
  }

  /** Abort current turn and restart the loop with the updated directive. */
  restartTurn(): void {
    if (!this.running) return
    this.restartRequested = true
    this.abortController?.abort()
  }

  /** Inject a nudge message into the agent's context for the next turn. */
  injectNudge(message: string): void {
    this.pendingNudges.push(message)
    // Wake the agent from sleep so it picks up the nudge quickly
    this.abortController?.abort()
  }

  async stop(): Promise<void> {
    this.running = false
    this.llmFailoverActive = false
    this.abortController?.abort()
    if (this.connection) {
      this.log('connection', 'Disconnecting...')
      await this.connection.disconnect()
      this.connection = null
      this.log('connection', 'Disconnected')
    }
  }
}

function profileMemoryPath(profileId: string): string {
  const safeId = profileId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(MEMORY_DIR, `${safeId}.md`)
}

function profileAgentsPath(profileId: string): string {
  const safeId = profileId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(AGENTS_DIR, safeId, 'AGENTS.md')
}

function readProfileAgents(profileId: string): string {
  const file = profileAgentsPath(profileId)
  try {
    return fs.readFileSync(file, 'utf-8').trim()
  } catch {
    return ''
  }
}

function writeProfileAgents(profileId: string, profileName: string, content: string): void {
  const file = profileAgentsPath(profileId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const ts = new Date().toISOString()
  const body = [
    `# AGENTS.md for ${profileName}`,
    '',
    `<!-- profile-id: ${profileId} -->`,
    `<!-- updated-at: ${ts} -->`,
    '',
    content.trim(),
    '',
  ].join('\n')
  fs.writeFileSync(file, body, 'utf-8')
}

export function overwriteProfileAgentsFromDirective(profile: Profile): void {
  const directive = (profile.directive || '').trim()
  if (!directive) return
  writeProfileAgents(profile.id, profile.name, directive)
}

function ensureProfileAgentsFromDirective(profile: Profile): void {
  const existing = readProfileAgents(profile.id)
  if (existing) return
  overwriteProfileAgentsFromDirective(profile)
}

function resolveMissionDirective(profile: Profile): string {
  const fromAgents = readProfileAgents(profile.id)
  if (fromAgents) return fromAgents
  return profile.directive || 'Play the game. Mine ore, sell it, and grow stronger.'
}

function loadProfileMemory(profileId: string): string {
  const file = profileMemoryPath(profileId)
  try {
    const raw = fs.readFileSync(file, 'utf-8').trim()
    return stripMemoryHeader(raw)
  } catch {
    return ''
  }
}

function saveProfileMemory(profileId: string, summary: string): void {
  const file = profileMemoryPath(profileId)
  const profile = getProfile(profileId)
  const profileName = profile?.name || 'unknown'
  const content = formatMemoryFile(profileId, profileName, summary)
  fs.mkdirSync(MEMORY_DIR, { recursive: true })
  fs.writeFileSync(file, content, 'utf-8')
}

function resetProfileMemory(profileId: string): void {
  const file = profileMemoryPath(profileId)
  try {
    fs.unlinkSync(file)
  } catch {
    // ignore
  }
}

export function readProfileMemory(profileId: string): string {
  return loadProfileMemory(profileId)
}

export function writeProfileMemory(profileId: string, summary: string): void {
  saveProfileMemory(profileId, summary)
}

export function clearProfileMemory(profileId: string): void {
  resetProfileMemory(profileId)
}

function formatMemoryFile(profileId: string, profileName: string, summary: string): string {
  const ts = new Date().toISOString()
  return [
    '<!-- admiral-memory-v1 -->',
    `<!-- profile-id: ${profileId} -->`,
    `<!-- profile-name: ${profileName} -->`,
    `<!-- updated-at: ${ts} -->`,
    '',
    summary.trim(),
    '',
  ].join('\n')
}

function stripMemoryHeader(content: string): string {
  if (!content.startsWith('<!-- admiral-memory-v1 -->')) return content
  const lines = content.split('\n')
  let i = 0
  while (i < lines.length && lines[i].trim().startsWith('<!--')) i++
  while (i < lines.length && lines[i].trim() === '') i++
  return lines.slice(i).join('\n').trim()
}

function buildMemoryIntegrityWarning(memory: string): string | null {
  const lower = memory.toLowerCase()
  const suspiciousPatterns = [
    'server-wide',
    'server wide',
    'server freeze',
    'global deadlock',
    'mutation issue',
    'mutation stall',
    'http 504',
    'pending jump to sirius',
    'jump to sirius pending',
    'monitoring via telemetry',
    'will automatically resume',
    '(additional context was lost due to summarization failure.)',
  ]
  const hits = suspiciousPatterns.filter((pattern) => lower.includes(pattern))
  if (hits.length === 0) return null

  return [
    '## Memory Integrity Warning',
    'Persistent memory may be stale or poisoned by outdated stall assumptions.',
    `Suspicious memory markers detected: ${hits.slice(0, 6).join(', ')}.`,
    'Do not trust old server-wide failure claims, pending-jump narratives, or passive-monitoring plans without fresh verification.',
    'Before using memory-derived assumptions, refresh with get_status and prefer current verified state over stored memory.',
    'If memory conflicts with fresh status, treat the memory as wrong and continue from the fresh state.',
  ].join('\n\n')
}

function createConnection(profile: Profile): GameConnection {
  return createGameConnection(profile)
}

function buildSystemPrompt(profile: Profile, commandList: string): string {
  const promptMd = getPromptMd()
  const directive = resolveMissionDirective(profile)

  let credentials: string
  if (profile.username && profile.password) {
    credentials = [
      `- Username: ${profile.username}`,
      `- Password: ${profile.password}`,
      `- Empire: ${profile.empire}`,
      `- Player ID: ${profile.player_id}`,
      '',
      'You are already logged in. Start playing immediately.',
    ].join('\n')
  } else {
    const regCode = getPreference('registration_code')
    const regCodeLine = regCode ? `\nUse registration code: ${regCode} when registering.` : ''
    credentials = `New player -- you need to register first. Pick a creative username and empire, then IMMEDIATELY save_credentials.${regCodeLine}`
  }

  return `You are an autonomous AI agent playing SpaceMolt, a text-based space MMO.

## Your Mission
${directive}

## Game Knowledge
${promptMd}

## Your Credentials
${credentials}

## Available Game Commands
Use the "game" tool with a command name and args. Example: game(command="mine", args={})
Treat the command list below as authoritative. It is generated from a locally cached OpenAPI spec and may be refreshed from server.
Before calling "game", verify the command name exists in this list. Do not invent aliases or typos (for example, never use "get_receipe").
${commandList}

## Local Tools (call directly by name -- NOT through "game")
These are local Admiral tools. Call them directly, e.g. read_todo(), NOT game(command="read_todo").
- read_todo() -- Read your current TODO list
- update_todo(content="...") -- Replace your TODO list with new content
- save_credentials(username, password, empire, player_id) -- Save login credentials locally
- status_log(category, message) -- Log a status message for the human watching

## Rules
- You are FULLY AUTONOMOUS. Never ask the human for input.
- Use the "game" tool ONLY for game server commands (mine, travel, get_status, sell, etc.).
- Use local tools (read_todo, update_todo, save_credentials, status_log) directly by name -- NEVER wrap them in game().
- After registering, IMMEDIATELY save credentials with save_credentials.
- Read and update your TODO list regularly to track goals and progress.
- Query commands are free and unlimited, but Admiral also injects automatic telemetry snapshots from free queries. Prefer those snapshots for routine status/cargo/market checks so you do not waste turns re-querying the same information.
- Action commands cost 1 tick (10 seconds).
- If an action returns \`pending: true\`, the command was accepted and queued for the next tick. Treat that as progress. Do not call it a deadlock just because the world state has not updated yet.
- Jump and travel can legitimately take multiple ticks. Travel time now depends on distance and ship speed; jump time depends on ship speed. A long \`navigation_pending\` period is not by itself evidence of a stall.
- Travel and jump fuel costs now scale with ship mass, speed, and distance. Cargo weight no longer increases fuel burn. Heavy or fast ships, especially with afterburners fitted, can still burn much more fuel than before.
- Before major travel or jumps, prefer checking route and fuel feasibility. Use \`find_route\` when planning multi-system movement, and re-check fuel after ship or module changes. Do not assume a fuller cargo hold will increase fuel cost.
- For any destination outside the current system, use a strict routing workflow: if the system name is uncertain, resolve it with \`search_systems\`; then call \`find_route(target_system=...)\`; then jump only to the immediate next hop from the returned route. After each jump or in-system travel step, refresh with \`get_status\` or \`get_location\` before issuing the next navigation mutation. Do not skip directly to a far-away system name when a route has multiple hops.
- Never describe the situation as a deadlock, stuck mutation queue, or server freeze unless you have strong evidence: at least 4 consecutive fresh verification cycles after a pending mutation, no \`ACTION_RESULT\` notification, and no meaningful state change despite repeated \`get_status\` checks.
- If one specific account appears blocked for several verification cycles, describe it as a local mutation stall for that account/session only. Do not generalize that to the whole server unless multiple independent accounts show the same evidence.
- If Admiral provides a \`Mutation State\` block, use it as a strong operational hint. Prefer those exact labels (\`idle\`, \`mutation_pending\`, \`navigation_pending\`, \`local_stall\`) instead of inventing stronger terms like deadlock or server-wide freeze, but choose the narrowest verification query that resolves the uncertainty instead of defaulting to \`get_status\`.
- If Admiral provides a \`Navigation State\` block, treat it as a derived hint from recent \`get_status\` data, not as perfect ground truth. Before committing to important travel/dock/mine decisions, verify the current state yourself with the narrowest fresh query that resolves the ambiguity: \`get_location\` for live POI/transit, \`get_cargo\` for mining completion or cargo changes, \`get_status\` only for broad state reconciliation.
- If \`navigation_pending\` follows a recent \`jump\` or \`travel\`, first assume the ship may still be in transit. Prefer \`get_location\` to inspect active transit destination and arrival tick, then refresh with \`get_status\` only if you need broader reconciliation before declaring a navigation stall.
- After a pending \`mine\`, do not reflexively spam \`get_status\`. If you only need to confirm that mining completed or cargo changed, prefer \`get_cargo\`. Use \`get_location\` when the question is whether you are actually at a compatible resource node. Reserve \`get_status\` for broader state reconciliation.
- If you see a state error like \`not_docked\` after \`undock\`, or \`already_docked\` after \`dock\`, interpret it as evidence that the desired state may already be true. Refresh with \`get_status\` before retrying or claiming the server is frozen.
- If you have verified a local stall for several cycles, do not stay in passive monitoring forever. After refreshing with \`get_status\`, test exactly one simple low-risk mutation that matches the verified state (typically a corrected \`dock\`, \`undock\`, \`sell\`, \`refuel\`, or other obvious local action).
- When testing a recovery mutation, send only one probe action, wait for the result, and reassess from fresh \`get_status\`. Do not spam repeated retries of the same command.
- If you hit errors like \`already_in_system\`, \`cargo_full\`, \`not_enough_fuel\`, \`invalid_payload\` for a zero-quantity sell, or a market/sell rejection, treat them as planning feedback. Verify state, change strategy, and avoid repeating the same blocked action.
- Before every \`sell\` mutation, run a fresh \`get_status\` and verify that you are docked at a valid base/station and that the cargo quantity you plan to sell is still present. Do not rely on stale docked/cargo assumptions.
- Use a strict selling workflow: \`get_status\` -> confirm docked -> inspect market/orderbook -> decide price/quantity -> \`sell\` once -> verify the result. If any step is ambiguous, refresh instead of submitting the sell.
- If Admiral provides a \`Best sell hints\` block, treat it as a compact station-local pricing aid built from current bids plus recent fills. Prefer it when choosing whether to instant-sell, hold, or list near market, but still sanity-check against fresh cargo quantity and current docked station before submitting the mutation.
- Read the market sides correctly: instant \`sell\` fills against existing buy orders and therefore depends on the bid/buy side, not the listed \`sell_orders\`. \`sell_orders\` are the ask side and only describe competing sellers unless you create your own sell order.
- Use a strict cargo-unload fallback when docked with sale inventory: first try to sell directly only if the local market has real bid-side liquidity and the instant sale is acceptable; if immediate sale is not realistically possible or would be obviously bad, move the cargo into the station's local storage before doing anything else with it.
- If the market has no meaningful buy orders or bid-side depth, do not dump cargo into a bad or empty instant market. Prefer putting the goods into local station storage first so the ship can resume work with free cargo space, then batch inventory and decide whether to create a well-placed sell order from that station later.
- If your sell attempt returns \`quantity_sold: 0\`, \`total_earned: 0\`, or leaves cargo unchanged, interpret that as no fill or a bad market fit. Re-check docked state, orders, and the local orderbook before attempting another sell.
- When using the storage fallback, use the station's personal/local storage, confirm the cargo actually moved, and keep a note of what was stored and where.
- Treat \`create_sell_order\` as fee-bearing. Before listing, inspect the listing fee and compare it to the expected total sale value and expected margin. Do not create tiny low-value orders where the fee eats a meaningful share of proceeds, and prefer larger batched listings when that materially improves fee efficiency.
- Prefer batching sale inventory in local station storage and waiting until you have a meaningfully larger stack before creating a sell order. A single larger order is usually better than many tiny fee-paying orders for the same item at the same station.
- "Batching" can include running multiple mining trips first: if the current station and route are still good for the same ore family, it is often better to unload to local storage, return to the belt for more, and combine several trips into one later sell order instead of listing every small haul immediately.
- After creating a sell order, let it run for at least 3 ticks (about 30 seconds) before considering \`cancel_order\` or \`modify_order\`, unless the order is clearly wrong (wrong item, wrong quantity, obviously bad price, or a strategic emergency requires immediate liquidity).
- Only create a sell order after the cargo is safely unloaded or when you have explicitly verified that listing it is better than keeping it in local storage for later sale.
- Do not cancel a newly created order just because it is still unfilled on the first verification. Unfilled for one or two checks is normal.
- Use a strict order-management workflow: \`view_orders\` -> identify the exact \`order_id\` and \`created_at\` -> compare against current orderbook -> only then \`modify_order\` or \`cancel_order\`.
- Never call \`cancel_order\` with \`item_id\`, quantity, or price fields as a substitute for \`order_id\`. Cancel only by exact \`order_id\`.
- Ship browse/showroom/catalog lists may expose ship category instead of a live hull price. When you need a real current purchase price for a ship, use \`commission_quote\` rather than trusting a static list price.
- Catalog detail responses may now include ship lore and build materials, module combat reach/ammo/accuracy bonus/survey power/skill requirements, and item hazardous-material warnings. Use those fields when evaluating fit, safety, and upgrade prerequisites.
- Never use irreversible self-destruction, account reset, character wipe, or similarly destructive escape-hatch commands. Self-destruction is not a navigation shortcut: it can destroy the current ship, cargo, equipped modules, and expensive mining gear/badges tied to the loadout. If stranded or blocked, recover through travel, docking, refueling, repair, insurance, chat, or by waiting for better state information.
- Never claim a stuck mutation queue, deadlock, or server freeze unless multiple fresh observations explicitly prove commands are neither executing nor changing state after verification with \`get_status\`.
- Always check fuel before traveling and cargo space before mining.
- Match mining targets to the installed modules before traveling or mining: ore equipment should target asteroid belts, ice harvesters should target ice fields, and gas harvesters should target gas clouds. Do not fly to an incompatible resource node just to try mine().
- Route planning matters more now: use \`find_route\` for non-trivial jumps, and do not assume older fixed-time or fixed-fuel navigation behavior.
- Existing ships may have new speed values after a server restart. Do not rely on stale assumptions about jump duration, travel duration, or fuel burn from earlier runs.
- If attacked by NPC pirates and escape is legal, \`jump\` or \`travel\` can be a valid recovery option. Treat navigation as a possible escape tool when combat pressure is non-player and leaving is feasible.
- Mining loops should be practical: mine until cargo is near full (roughly 95%), but stop early if yields fail, the location lacks resources, the node mismatches the current mining fit, cargo is full, or a better unload/travel opportunity appears.
- Prefer a stable default miner route when no stronger local constraint applies: mine in the Furud system, and use Nova Terra / Nova Terra Central as the default unload, storage, refuel, and market station.
- If the ship is already running a normal ore-mining loop and no mission, fuel, cargo, combat, or market constraint overrides it, bias route planning back toward Furud belts for mining and Nova Terra Central for docking/selling.
- Use a structured ore-mining loop when applicable: if undocked with an ore-mining fit and cargo is below 15%, prefer traveling to a known compatible ore belt and starting the loop there.
- If already at a compatible ore belt and cargo is below 95%, keep mining unless the location is depleted, yields collapse, cargo is full, no resources are available, or the current fit does not match the node.
- If cargo reaches roughly 95%, stop mining, return to a known unload station, dock, refuel when needed, unload, and only craft items when a supported crafting action is actually available and worthwhile.
- If docked with cargo above 15%, process cargo before leaving again: refuel when needed, unload, only craft items when a supported crafting action is actually available and worthwhile, then choose direct sell for small stacks or strong buy-side liquidity; otherwise prefer \`create_sell_order\` once quantity or expected sale value is above your configured threshold.
- Do not hoard ore blindly. When docked with valuable raw materials, inspect the market before selling. Avoid dumping into obviously bad instant bids; prefer corrected pricing or listing behavior when needed.
- Periodically check for practical ship upgrades when docked at a shipyard or base. Favor upgrades that materially improve cargo, mining throughput, survivability, or travel efficiency and are affordable without stalling progress.
- Keep a wallet reserve of at least 10000 credits. Do not spend below that floor on ship purchases, fitting, or optional upgrades unless explicit human guidance overrides it.
- Before buying another ship, check \`list_ships\` for already-owned hulls. If you already own a larger or clearly better ship than the current active hull, prefer switching into that owned ship before spending more credits on a new purchase.
- When multiple owned ships are available, prefer the best already-owned practical upgrade first: usually the highest-tier hull that is actually usable now, with priority on cargo, survivability, and slot count for the current role. Do not keep flying a clearly inferior starter ship while a better owned hull is sitting in storage at a reachable station.
- For mining-focused accounts, periodically review stored ships and sell stored non-mining hulls with \`sell_ship\` when they are not part of the current mining progression, not needed as a temporary logistics tool, and not being kept as a module donor.
- After \`buy_listed_ship\`, treat the purchased hull as the new active ship immediately and continue the plan in that ship. The previous active ship is stored automatically. Verify the active hull with \`get_ship\`/\`get_status\` before resuming travel, mining, or selling.
- After \`commission_ship\`, do not forget the delivery step: monitor until the build is complete, then use \`list_ships\` and \`switch_ship\` at the correct station so the commissioned hull actually becomes the active ship before treating the upgrade as done.
- Ship switching does not transfer modules automatically. When moving into a newly bought or commissioned ship, inspect both fit and cargo/storage, then either:
  1. move the old fit over with \`uninstall_mod\` -> \`switch_ship\` -> \`install_mod\`, or
  2. buy/install a fresh fit if that is faster or clearly better.
- Carrier ships can transport stored ships in a bay. When flying a carrier and docked at the same station as the ship you want to move, prefer grouped storage commands when present: \`storage(action="deposit", item_id=<ship_id>, target=self)\` to load it and \`storage(action="withdraw", item_id=<ship_id>)\` to unload it. If the current API exposes \`storage_deposit\` / \`storage_withdraw\` aliases, those are equivalent.
- On carrier ships, inspect \`get_cargo\` for \`carried_ships\`, \`bay_used\`, and \`bay_capacity\` before loading more ships or planning long travel.
- Do not treat carried ships as ordinary cargo inventory. They consume carrier bay capacity, and if the carrier is destroyed the loaded ships become separate wrecks at that location.
- Do not leave an upgraded ship idle in storage while continuing to fly the weaker hull, unless the new ship is temporarily unusable because of missing modules, skills, fuel, or required fitting work.
- For miners, prioritize restoring a workable mining fit immediately after an upgrade: mining laser first, travel/fuel support second, cargo expansions after that. If the old modules remain on the stored ship, recover them or replace them before returning to the mining loop.
- For Solarian mining accounts, use this default upgrade path unless current market prices, missing skills, or mission constraints make a nearby step impractical.
- Do not apply this Solarian path blindly to Nebula or other factions. For non-Solarian mining accounts, derive the next mining hull from the current owned mining ships plus \`catalog(type=ships)\` / \`commission_quote\`, and treat freighters like \`Floor Price\` as logistics hulls rather than mining upgrades.
  Solarian Miner Upgrade Path
  | Ship | Tier | Hull Price | Cargo | Slots W/D/U | Mining Fit | Ship Skills |
  | Theoria | 0 | 0 cr | 70 | 1/1/3 | 1x Mining Laser I, 1x Afterburner I, 2x Cargo Bay Expansion | none publicly exposed |
  | Archimedes | 1 | 2200 cr | 185 | 1/1/3 | 1x Mining Laser I, 1x Afterburner I, 2x Cargo Bay Expansion | none publicly exposed |
  | Excavation | 2 | 8000 cr | 250 | 1/1/4 | 1x Mining Laser II, 1x Afterburner II, 3x Cargo Bay Expansion | mining 3, small_ships 3 |
  | Deep Survey | 3 | 30000 cr | 660 | 1/1/6 | 1x Mining Laser III, 1x Afterburner III, 5x Cargo Bay Expansion | mining 5, small_ships 5 |
  | Lithosphere | 4 | 100000 cr | 1680 | 1/2/8 | 1x Mining Laser IV, 1x Afterburner III, 7x Cargo Bay Expansion | mining 7, medium_ships 3 |
  | Tellurian | 5 | 400000 cr | 2400 | 1/3/10 | 1x Mining Laser IV, 1x Afterburner III, 9x Cargo Bay Expansion | mining 7, large_ships 5 |
- When evaluating a Solarian miner upgrade, prefer the next ship in that path first. Only skip a step if the next hull is unavailable, unaffordable after fitting reserve, blocked by skills, or a later step is already clearly affordable and skill-legal.
- For non-Solarian mining accounts, prefer continuity of the current mining line: keep mining hulls in the upgrade path, keep freighters/support hulls out of it, and use \`list_ships\` plus the ship catalog before deciding to buy, switch, or sell.
- Be social -- chat with players you meet.
- Prioritize faction coordination: use faction chat frequently to share status, plans, threats, trade needs, and requests for support.
- Interact in faction chat: react to incoming messages, answer teammates, ask follow-up questions, and agree on concrete coordinated actions.
- When starting fresh: undock -> travel to asteroid belt -> mine -> travel back -> dock -> sell -> refuel -> repeat.
`
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function extractCargoEntries(data: Record<string, unknown> | undefined): Array<{ id: string; name: string; quantity: number }> {
  if (!data) return []
  const candidates = [
    data.items,
    data.cargo,
    (data.result as Record<string, unknown> | undefined)?.items,
    (data.ship as Record<string, unknown> | undefined)?.cargo,
  ]

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const entries = candidate
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        const id = String(record.item_id || record.id || '')
        const name = String(record.name || record.item_name || id || 'item')
        const quantity = toFiniteNumber(record.quantity ?? record.qty ?? record.amount)
        if (!quantity || quantity <= 0) return null
        return { id, name, quantity }
      })
      .filter((entry): entry is { id: string; name: string; quantity: number } => Boolean(entry))
    if (entries.length > 0) return entries
  }

  return []
}

function summarizeMarket(data: Record<string, unknown> | undefined): string {
  if (!data) return ''
  const normalizedEntries = extractMarketEntries(data)
  if (normalizedEntries.length > 0) {
    return normalizedEntries
      .slice(0, 6)
      .map((entry) => {
        const parts = [entry.name]
        if (entry.bid !== null) parts.push(`bid ${entry.bid}`)
        if (entry.ask !== null) parts.push(`ask ${entry.ask}`)
        if (entry.bidVolume !== null) parts.push(`buy vol ${entry.bidVolume}`)
        if (entry.askVolume !== null) parts.push(`sell vol ${entry.askVolume}`)
        if (entry.volume !== null && entry.bidVolume === null && entry.askVolume === null) parts.push(`qty ${entry.volume}`)
        return `- ${parts.join(', ')}`
      })
      .join('\n')
  }

  const candidates = [
    data.items,
    data.orders,
    data.market,
    (data.result as Record<string, unknown> | undefined)?.items,
  ]

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const lines = candidate
      .slice(0, 6)
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        const name = String(record.name || record.item_name || record.item_id || '').trim()
        if (!name) return null
        const bid = toFiniteNumber(record.best_bid ?? record.bid_price ?? record.buy_price ?? record.highest_buy)
        const ask = toFiniteNumber(record.best_ask ?? record.ask_price ?? record.sell_price ?? record.lowest_sell)
        const volume = toFiniteNumber(record.quantity ?? record.available ?? record.volume)
        const parts = [name]
        if (bid !== null) parts.push(`bid ${bid}`)
        if (ask !== null) parts.push(`ask ${ask}`)
        if (volume !== null) parts.push(`qty ${volume}`)
        return `- ${parts.join(', ')}`
      })
      .filter((line): line is string => Boolean(line))
    if (lines.length > 0) return lines.join('\n')
  }

  return ''
}

function summarizeSellOrders(data: Record<string, unknown> | undefined): string {
  if (!data) return ''
  const orders = extractActiveOrders(data)
    .filter((order) => order.side === 'sell')
    .sort((a, b) => {
      if (a.price !== null && b.price !== null) return a.price - b.price
      if (a.price !== null) return -1
      if (b.price !== null) return 1
      return a.name.localeCompare(b.name)
    })

  if (orders.length === 0) return 'none'

  return orders
    .slice(0, 8)
    .map((order) => {
      const parts = [order.name]
      if (order.price !== null) parts.push(`ask ${order.price}`)
      if (order.quantity !== null) parts.push(`qty ${order.quantity}`)
      if (order.station) parts.push(`at ${order.station}`)
      return `- ${parts.join(', ')}`
    })
    .join('\n')
}

function extractActiveOrders(data: Record<string, unknown>): Array<{ name: string; side: 'buy' | 'sell' | 'unknown'; price: number | null; quantity: number | null; station: string | null }> {
  const candidates = [
    data.orders,
    (data.result as Record<string, unknown> | undefined)?.orders,
    data.items,
    (data.result as Record<string, unknown> | undefined)?.items,
  ]

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const orders = candidate
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        const name = String(record.item_name || record.name || record.item_id || '').trim()
        if (!name) return null
        const rawSide = String(record.side || record.order_type || '').trim().toLowerCase()
        const side = rawSide === 'buy' || rawSide === 'sell' ? rawSide : 'unknown'
        return {
          name,
          side,
          price: toFiniteNumber(record.price_each ?? record.price ?? record.unit_price ?? record.ask_price ?? record.sell_price ?? record.buy_price),
          quantity: toFiniteNumber(record.quantity ?? record.remaining_quantity ?? record.available ?? record.volume),
          station: typeof record.station_name === 'string'
            ? record.station_name
            : typeof record.base === 'string'
              ? record.base
              : typeof record.station_id === 'string'
                ? record.station_id
                : null,
        }
      })
      .filter((order): order is { name: string; side: 'buy' | 'sell' | 'unknown'; price: number | null; quantity: number | null; station: string | null } => Boolean(order))

    if (orders.length > 0) return orders
  }

  return []
}

function getCurrentStationId(gameState: Record<string, unknown> | null): string | null {
  const location = (gameState?.location as Record<string, unknown> | undefined) || {}
  const candidates = [
    location.docked_at,
    location.poi_id,
    location.station_id,
    location.base_id,
  ]

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const normalized = candidate.trim().toLowerCase()
    if (normalized) return normalized
  }

  return null
}

type MarketEntry = {
  name: string
  bid: number | null
  ask: number | null
  volume: number | null
  bidVolume: number | null
  askVolume: number | null
}

function extractMarketEntries(data: Record<string, unknown>): MarketEntry[] {
  const directEntries = extractMarketEntriesFromArrayCandidates([
    data.items,
    data.orders,
    data.market,
    (data.result as Record<string, unknown> | undefined)?.items,
    (data.result as Record<string, unknown> | undefined)?.orders,
  ])
  if (directEntries.length > 0) return directEntries

  const orderbook = extractOrderbookEntries(data)
  if (orderbook.length > 0) return orderbook

  return []
}

function summarizeCommandResult(command: string, args: Record<string, unknown> | undefined, result: CommandResult): string {
  const data = (result.structuredContent ?? result.result) as Record<string, unknown> | undefined
  if (command === 'catalog' && data) {
    const type = typeof args?.type === 'string' ? args.type.trim().toLowerCase() : ''
    if (type === 'ships') {
      const ships = extractShipOffers(data)
      if (ships.length > 0) {
        const preview = ships.slice(0, 3).map((ship) => {
          const parts = [ship.name || ship.classId]
          if (ship.category) parts.push(ship.category)
          if (ship.buildMaterials.length > 0) parts.push(`build ${formatMaterialRequirements(ship.buildMaterials)}`)
          return parts.join(' | ')
        }).join('; ')
        return `Catalog ships: ${preview}`.slice(0, 200)
      }
    }

    if (type === 'modules') {
      const modules = extractModuleDetails(data)
      if (modules.length > 0) {
        const preview = modules.slice(0, 3).map((module) => {
          const parts = [module.name || module.itemId]
          if (module.combatReach !== null) parts.push(`reach ${module.combatReach}`)
          if (module.ammoType) parts.push(`ammo ${module.ammoType}`)
          if (module.surveyPower !== null) parts.push(`survey ${module.surveyPower}`)
          if (Object.keys(module.requiredSkills).length > 0) parts.push(`skills ${formatRequiredSkills(module.requiredSkills)}`)
          return parts.join(' | ')
        }).join('; ')
        return `Catalog modules: ${preview}`.slice(0, 200)
      }
    }

    if (type === 'items') {
      const items = extractItemDetails(data)
      const hazardous = items.filter((item) => item.hazardousWarnings.length > 0)
      if (hazardous.length > 0) {
        const preview = hazardous.slice(0, 3).map((item) => `${item.name || item.itemId}: ${item.hazardousWarnings[0]}`).join('; ')
        return `Catalog hazards: ${preview}`.slice(0, 200)
      }
      if (items.length > 0) {
        const preview = items.slice(0, 3).map((item) => item.name || item.itemId).join('; ')
        return `Catalog items: ${preview}`.slice(0, 200)
      }
    }

    if (type === 'recipes') {
      const recipes = extractRecipeDetails(data)
      if (recipes.length > 0) {
        const preview = recipes.slice(0, 3).map((recipe) => {
          const parts = [recipe.name || recipe.recipeId]
          if (recipe.category) parts.push(recipe.category)
          if (recipe.inputCount !== null || recipe.outputCount !== null) parts.push(`${recipe.inputCount ?? '?'}->${recipe.outputCount ?? '?'}`)
          if (Object.keys(recipe.requiredSkills).length > 0) parts.push(`skills ${formatRequiredSkills(recipe.requiredSkills)}`)
          return parts.join(' | ')
        }).join('; ')
        return `Catalog recipes: ${preview}`.slice(0, 200)
      }
    }

    if (type === 'skills') {
      const skills = extractSkillDetails(data)
      if (skills.length > 0) {
        const preview = skills.slice(0, 3).map((skill) => {
          const parts = [skill.name || skill.skillId]
          if (skill.category) parts.push(skill.category)
          if (skill.maxLevel !== null) parts.push(`max ${skill.maxLevel}`)
          if (Object.keys(skill.requiredSkills).length > 0) parts.push(`req ${formatRequiredSkills(skill.requiredSkills)}`)
          return parts.join(' | ')
        }).join('; ')
        return `Catalog skills: ${preview}`.slice(0, 200)
      }
    }
  }

  return typeof result.result === 'string'
    ? result.result.slice(0, 200)
    : JSON.stringify(result.result).slice(0, 200)
}

function extractMarketEntriesFromArrayCandidates(candidates: unknown[]): MarketEntry[] {
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const entries = candidate
      .map((item) => toMarketEntry(item))
      .filter((entry): entry is MarketEntry => Boolean(entry))
    if (entries.length > 0) return entries
  }
  return []
}

function extractOrderbookEntries(data: Record<string, unknown>): MarketEntry[] {
  const roots = [
    data,
    data.result,
    data.market,
    (data.result as Record<string, unknown> | undefined)?.market,
  ]

  for (const root of roots) {
    if (!root || typeof root !== 'object') continue
    const record = root as Record<string, unknown>
    const buyOrders = record.buy_orders
    const sellOrders = record.sell_orders
    if (!Array.isArray(buyOrders) && !Array.isArray(sellOrders)) continue

    const grouped = new Map<string, MarketEntry>()
    addOrderbookSide(grouped, buyOrders, 'buy')
    addOrderbookSide(grouped, sellOrders, 'sell')
    if (grouped.size > 0) {
      return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name))
    }
  }

  return []
}

function addOrderbookSide(grouped: Map<string, MarketEntry>, orders: unknown, side: 'buy' | 'sell'): void {
  if (!Array.isArray(orders)) return

  for (const order of orders) {
    if (!order || typeof order !== 'object') continue
    const record = order as Record<string, unknown>
    const name = String(record.name || record.item_name || record.item_id || '').trim()
    if (!name) continue

    const price = toFiniteNumber(record.price ?? record.unit_price ?? record.bid_price ?? record.ask_price ?? record.buy_price ?? record.sell_price)
    const volume = toFiniteNumber(record.quantity ?? record.remaining_quantity ?? record.volume ?? record.available)
    const existing = grouped.get(name) || {
      name,
      bid: null,
      ask: null,
      volume: null,
      bidVolume: null,
      askVolume: null,
    }

    if (side === 'buy') {
      if (price !== null && (existing.bid === null || price > existing.bid)) existing.bid = price
      if (volume !== null) existing.bidVolume = (existing.bidVolume ?? 0) + volume
    } else {
      if (price !== null && (existing.ask === null || price < existing.ask)) existing.ask = price
      if (volume !== null) existing.askVolume = (existing.askVolume ?? 0) + volume
    }

    grouped.set(name, existing)
  }
}

function toMarketEntry(item: unknown): MarketEntry | null {
  if (!item || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  const name = String(record.name || record.item_name || record.item_id || '').trim()
  if (!name) return null
  return {
    name,
    bid: toFiniteNumber(record.best_bid ?? record.bid_price ?? record.buy_price ?? record.highest_buy),
    ask: toFiniteNumber(record.best_ask ?? record.ask_price ?? record.sell_price ?? record.lowest_sell),
    volume: toFiniteNumber(record.quantity ?? record.available ?? record.volume),
    bidVolume: toFiniteNumber(record.buy_volume ?? record.bid_volume),
    askVolume: toFiniteNumber(record.sell_volume ?? record.ask_volume),
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}
