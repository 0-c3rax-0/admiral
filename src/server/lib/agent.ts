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

    const { model, apiKey, failoverApiKey } = resolveModel(`${profile.provider}/${profile.model}`)
    let failoverModel: Model<any> | undefined
    let failoverModelApiKey: string | undefined = failoverApiKey
    if (profile.failover_provider && profile.failover_model) {
      try {
        const resolved = resolveModel(`${profile.failover_provider}/${profile.failover_model}`)
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
        let compactionModel: Model<any> | undefined
        let compactionApiKey: string | undefined
        if (compactInputEnabled && compactInputModel) {
          try {
            const compactModelSpec = compactInputModel.includes('/')
              ? compactInputModel
              : (compactInputProvider ? `${compactInputProvider}/${compactInputModel}` : '')
            if (compactModelSpec) {
              const resolvedCompaction = resolveModel(compactModelSpec)
              compactionModel = resolvedCompaction.model
              compactionApiKey = resolvedCompaction.apiKey || resolvedCompaction.failoverApiKey
            }
          } catch (err) {
            this.log('error', `Compact-input model invalid: ${err instanceof Error ? err.message : String(err)}`)
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
        if (pollResp.notifications && Array.isArray(pollResp.notifications) && pollResp.notifications.length > 0) {
          pendingEvents = pollResp.notifications
            .map(n => {
              const s = formatNotificationSummary(n)
              return `  > ${s}`
            })
            .join('\n')
        }
      } catch {
        // Best-effort
      }

      const nudgeParts: string[] = []
      if (pendingEvents) nudgeParts.push('## Events Since Last Action\n' + pendingEvents + '\n')

      // Drain any human nudges
      if (this.pendingNudges.length > 0) {
        const nudges = this.pendingNudges.splice(0)
        for (const n of nudges) {
          nudgeParts.push(`## Human Nudge\nYour human operator has sent you guidance: ${n}\nTake this into account for your next actions.\n`)
          this.log('system', `Nudge delivered: ${n.slice(0, 100)}`)
        }
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
- Query commands are free and unlimited -- use them often.
- Action commands cost 1 tick (10 seconds).
- Always check fuel before traveling and cargo space before mining.
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

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}
