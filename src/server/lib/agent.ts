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
import { fetchGameCommands, formatCommandList } from './schema'
import { allTools } from './tools'
import { runAgentTurn, type CompactionState } from './loop'
import { addLogEntry, getLatestPendingLlmRequest, getProfile, updateProfile, getPreference } from './db'
import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'

const TURN_INTERVAL = 2000
const PROMPT_PATH = path.join(process.cwd(), 'prompt.md')
const MEMORY_DIR = path.join(process.cwd(), 'data', 'memory')
const AGENTS_DIR = path.join(process.cwd(), 'data', 'agents')
const CONTINUE_NUDGE_INTERVAL = 6
const MARKET_TELEMETRY_INTERVAL = 3
const SHIP_TELEMETRY_INTERVAL = 8

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
  private telemetryCycle = 0
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

  private setActivity(activity: string) {
    this._activity = activity
    this.events.emit('activity', activity)
  }

  private cacheGameState(result: CommandResult): void {
    const data = result.structuredContent ?? result.result
    if (data && typeof data === 'object' && ('player' in data || 'ship' in data || 'location' in data)) {
      this._gameState = data as Record<string, unknown>
    }
  }

  private async executeSilentQuery(command: string, args?: Record<string, unknown>): Promise<CommandResult | null> {
    if (!this.connection) return null
    try {
      return await this.connection.execute(command, args)
    } catch {
      return null
    }
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
    const poiType = String(location.poi_type || player.current_poi_type || '').toLowerCase()
    const poiName = String(location.poi_name || player.current_poi || '').toLowerCase()
    return poiType.includes('station') || poiType.includes('base') || poiType.includes('shipyard') || poiName.includes('station') || poiName.includes('base')
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
    const marketResp = await this.executeSilentQuery('view_market', { category: 'ore' })
    if (!marketResp || marketResp.error) return null
    const data = ((marketResp.structuredContent ?? marketResp.result) as Record<string, unknown> | undefined) || {}
    const summary = summarizeMarket(data)
    return summary ? `Ore market snapshot:\n${summary}` : null
  }

  private async collectShipTelemetry(): Promise<string | null> {
    const showroomResp = await this.executeSilentQuery('shipyard_showroom', {})
    const browseResp = await this.executeSilentQuery('browse_ships', {})
    const showroomItems = showroomResp?.error ? [] : extractShipOffers((showroomResp?.structuredContent ?? showroomResp?.result) as Record<string, unknown> | undefined)
    const listedItems = browseResp?.error ? [] : extractShipOffers((browseResp?.structuredContent ?? browseResp?.result) as Record<string, unknown> | undefined)
    const combined = [...showroomItems, ...listedItems]
    if (combined.length === 0) return null

    const credits = toFiniteNumber(((this._gameState?.player as Record<string, unknown> | undefined) || {}).credits)
    const practical = combined
      .filter((offer) => offer.price !== null)
      .sort((a, b) => (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER))
      .slice(0, 5)

    if (practical.length === 0) return null

    const affordable = credits !== null ? practical.filter((offer) => (offer.price ?? Number.MAX_SAFE_INTEGER) <= credits) : []
    const chosen = affordable.length > 0 ? affordable : practical
    const lines = chosen.map((offer) => {
      const price = offer.price !== null ? `${offer.price} cr` : 'price unknown'
      const label = [offer.name, offer.classId].filter(Boolean).join(' / ')
      return `- ${label || 'Unknown ship'} at ${price}`
    })
    const header = affordable.length > 0
      ? 'Affordable ship opportunities:'
      : 'Nearby ship opportunities to monitor:'
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
      this.log('notification', formatNotificationSummary(n), JSON.stringify(n, null, 2))
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
    } else {
      const serverUrl = profile.server_url.replace(/\/$/, '')
      const apiVersion = profile.connection_mode === 'http_v2' ? 'v2' : 'v1'
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
    if (this.memorySummary) {
      context.messages.push({
        role: 'user' as const,
        content: `## Session History Summary\n\n${this.memorySummary}\n\n---\nUse this as persistent memory from earlier runs.`,
        timestamp: Date.now(),
      })
      this.log('system', 'Loaded persistent profile memory')
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
            onActivity: (a) => this.setActivity(a),
            onAdaptiveContext: (info) => {
              this._adaptiveMode = info.mode
              this._effectiveContextBudgetRatio = info.effectiveRatio
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
    const result = await this.connection.execute(command, args)

    if (command === 'get_status') this.cacheGameState(result)

    if (result.error) {
      this.log('tool_result', `Error: ${result.error.message}`, JSON.stringify(result, null, 2))
    } else {
      const summary = typeof result.result === 'string'
        ? result.result.slice(0, 200)
        : JSON.stringify(result.result).slice(0, 200)
      this.log('tool_result', summary, JSON.stringify(result, null, 2))
    }

    return result
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

function ensureProfileAgentsFromDirective(profile: Profile): void {
  const existing = readProfileAgents(profile.id)
  if (existing) return
  const directive = (profile.directive || '').trim()
  if (!directive) return
  writeProfileAgents(profile.id, profile.name, directive)
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

function createConnection(profile: Profile): GameConnection {
  switch (profile.connection_mode) {
    case 'websocket':
      return new WebSocketConnection(profile.server_url)
    case 'websocket_v2':
      return new WebSocketV2Connection(profile.server_url)
    case 'mcp':
      return new McpConnection(profile.server_url)
    case 'mcp_v2':
      return new McpV2Connection(profile.server_url)
    case 'http_v2':
      return new HttpV2Connection(profile.server_url)
    case 'http':
    default:
      return new HttpConnection(profile.server_url)
  }
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
Treat the command list below as authoritative. It is generated from a locally cached OpenAPI spec (https://www.spacemolt.com/api/openapi.json) and may be refreshed from server.
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
- If you see a state error like \`not_docked\` after \`undock\`, or \`already_docked\` after \`dock\`, interpret it as evidence that the desired state may already be true. Refresh with \`get_status\` before retrying or claiming the server is frozen.
- If you hit errors like \`already_in_system\`, \`cargo_full\`, \`not_enough_fuel\`, \`invalid_payload\` for a zero-quantity sell, or a market/sell rejection, treat them as planning feedback. Verify state, change strategy, and avoid repeating the same blocked action.
- Never claim a stuck mutation queue, deadlock, or server freeze unless multiple fresh observations explicitly prove commands are neither executing nor changing state after verification with \`get_status\`.
- Always check fuel before traveling and cargo space before mining.
- Mining loops should be practical: mine until cargo is near full (roughly 80-90%), but stop early if yields fail, the location lacks resources, cargo is full, or a better unload/travel opportunity appears.
- Do not hoard ore blindly. When docked with valuable raw materials, inspect the market before selling. Avoid dumping into obviously bad instant bids; prefer corrected pricing or listing behavior when needed.
- Periodically check for practical ship upgrades when docked at a shipyard or base. Favor upgrades that materially improve cargo, mining throughput, survivability, or travel efficiency and are affordable without stalling progress.
- Be social -- chat with players you meet.
- Prioritize faction coordination: use faction chat frequently to share status, plans, threats, trade needs, and requests for support.
- Interact in faction chat: react to incoming messages, answer teammates, ask follow-up questions, and agree on concrete coordinated actions.
- When starting fresh: undock -> travel to asteroid belt -> mine -> travel back -> dock -> sell -> refuel -> repeat.
`
}

function formatNotificationSummary(n: unknown): string {
  if (typeof n === 'string') return n
  if (typeof n !== 'object' || n === null) return JSON.stringify(n)

  const notif = n as Record<string, unknown>
  const type = (notif.type as string) || (notif.msg_type as string) || 'event'
  let data = notif.data as Record<string, unknown> | string | undefined
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch { /* leave as string */ }
  }

  if (data && typeof data === 'object') {
    const msg = (data.message as string) || (data.content as string)
    if (msg) return `[${type.toUpperCase()}] ${msg}`
  }

  return `[${type.toUpperCase()}] ${JSON.stringify(n).slice(0, 200)}`
}

function shouldForceStateRefreshFromNotifications(notifications: unknown[]): boolean {
  return notifications.some((n) => {
    const parsed = parseNotificationMeta(n)
    if (!parsed) return false

    return isRecoveryRelevantNotification(parsed)
  })
}

function buildRecoveryNudge(notifications: unknown[], gameState: Record<string, unknown> | null): string {
  const reasons = notifications
    .map((n) => parseNotificationMeta(n))
    .filter((value): value is { type: string; message: string } => Boolean(value))
    .filter((parsed) => isRecoveryRelevantNotification(parsed))
    .map(({ type, message }) => `- ${type}: ${message}`)

  return [
    '## Recovery Replan',
    'Your previous action assumptions are no longer trustworthy.',
    'Stop repeating the last blocked or contradictory action.',
    'Re-evaluate from the verified current game state below and build a fresh plan from here.',
    reasons.length > 0 ? 'Observed contradictory or blocked signals:\n' + reasons.join('\n') : 'Observed contradictory or blocked action signals.',
    'Verified current state from fresh get_status:',
    formatVerifiedGameState(gameState),
    'Use the verified state as authoritative. If the intended result is already satisfied or the current action is blocked by fuel, cargo, travel, or market constraints, continue with a corrected next strategic step instead of retrying the same action.',
  ].join('\n\n')
}

function isRecoveryRelevantNotification(parsed: { type: string; message: string }): boolean {
  const type = parsed.type.toUpperCase()
  const message = parsed.message.toLowerCase()

    if (type === 'ACTION_ERROR' && (
      message.includes('not_docked') ||
      message.includes('already_docked') ||
      message.includes('already_in_system') ||
      message.includes('cargo_full') ||
      message.includes('not_enough_fuel') ||
      (message.includes('invalid_payload') && message.includes('quantity must be greater than 0')) ||
      message.includes('market') ||
      message.includes('sell')
    )) {
      return true
  }

  if (type === 'OK' && (
    message.includes('"action":"dock"') ||
    message.includes('"action":"undock"') ||
    message.includes('"command":"dock"') ||
    message.includes('"command":"undock"') ||
    message.includes('"action":"travel"') ||
    message.includes('"command":"travel"') ||
    message.includes('"action":"sell"') ||
    message.includes('"command":"sell"')
  )) {
    return true
  }

  return false
}

function formatVerifiedGameState(gameState: Record<string, unknown> | null): string {
  if (!gameState) return '- get_status succeeded, but no structured game state was available.'

  const player = (gameState.player as Record<string, unknown> | undefined) || {}
  const ship = (gameState.ship as Record<string, unknown> | undefined) || {}
  const location = (gameState.location as Record<string, unknown> | undefined) || {}

  const systemName = stringifyStateValue(player.current_system ?? location.system_name) || '?'
  const poiName = stringifyStateValue(player.current_poi ?? location.poi_name) || '?'
  const credits = stringifyStateValue(player.credits) || '?'
  const shipName = stringifyStateValue(ship.name) || stringifyStateValue(ship.ship_name) || '?'
  const cargoUsed = stringifyStateValue(ship.cargo_used) || '?'
  const cargoCapacity = stringifyStateValue(ship.cargo_capacity) || '?'
  const fuel = stringifyStateValue(ship.fuel) || '?'
  const maxFuel = stringifyStateValue(ship.max_fuel) || '?'
  const hull = stringifyStateValue(ship.hull) || '?'
  const maxHull = stringifyStateValue(ship.max_hull) || '?'

  return [
    `- Location: ${systemName} / ${poiName}`,
    `- Credits: ${credits}`,
    `- Ship: ${shipName}`,
    `- Cargo: ${cargoUsed}/${cargoCapacity}`,
    `- Fuel: ${fuel}/${maxFuel}`,
    `- Hull: ${hull}/${maxHull}`,
  ].join('\n')
}

function stringifyStateValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
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

function extractShipOffers(data: Record<string, unknown> | undefined): Array<{ name: string; classId: string; price: number | null }> {
  if (!data) return []
  const candidates = [
    data.ships,
    data.listings,
    data.offers,
    (data.result as Record<string, unknown> | undefined)?.ships,
  ]

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const offers = candidate
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        const name = String(record.name || record.ship_name || record.class_name || '').trim()
        const classId = String(record.ship_class || record.class_id || record.ship_class_id || '').trim()
        const price = toFiniteNumber(record.price ?? record.ask_price ?? record.cost ?? record.sale_price)
        if (!name && !classId) return null
        return { name, classId, price }
      })
      .filter((offer): offer is { name: string; classId: string; price: number | null } => Boolean(offer))
    if (offers.length > 0) return offers
  }

  return []
}

function parseNotificationMeta(n: unknown): { type: string; message: string } | null {
  if (typeof n !== 'object' || n === null) return null

  const notif = n as Record<string, unknown>
  const type = String((notif.type as string) || (notif.msg_type as string) || 'event')
  let data = notif.data as Record<string, unknown> | string | undefined
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch { /* leave as string */ }
  }

  if (data && typeof data === 'object') {
    const message = (data.message as string) || (data.content as string) || JSON.stringify(data)
    return { type, message }
  }

  if (typeof data === 'string') return { type, message: data }
  if (typeof notif.message === 'string') return { type, message: notif.message }
  return { type, message: JSON.stringify(n) }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}
