import fs from 'fs'
import path from 'path'
import { WebSocketV2Connection } from '../server/lib/connections/websocket_v2'
import type { CommandResult, LoginResult, NotificationHandler, RegisterResult } from '../server/lib/connections/interface'
import type {
  BrokerConnectRequest,
  BrokerEvent,
  BrokerExecuteRequest,
  BrokerLoginRequest,
  BrokerRegisterRequest,
  BrokerSessionState,
  BrokerSessionMode,
} from '../shared/broker-types'

const DATA_DIR = path.join(process.cwd(), 'data')
const SESSIONS_PATH = path.join(DATA_DIR, 'broker-sessions.json')
const MAX_EVENTS_PER_SESSION = 500
const REQUEST_RESULT_TTL_MS = 5 * 60_000
const AUTH_RECOVERABLE_ERRORS = new Set(['not_authenticated', 'session_invalid', 'session_expired'])

interface PersistedSession {
  profileId: string
  mode: BrokerSessionMode
  serverUrl: string
  username: string | null
  password: string | null
  connectedIntent: boolean
  runningIntent: boolean
  lastSeq: number
  lastSnapshot: Record<string, unknown> | null
  lastError: string | null
  updatedAt: number
}

interface CachedRequest {
  promise?: Promise<CommandResult>
  result?: CommandResult
  expiresAt: number
}

class BrokerSession {
  readonly profileId: string
  readonly mode: BrokerSessionMode = 'websocket_v2'
  serverUrl: string
  username: string | null
  password: string | null
  connectedIntent: boolean
  runningIntent: boolean
  lastSeq: number
  lastSnapshot: Record<string, unknown> | null
  lastError: string | null
  updatedAt: number

  private connection: WebSocketV2Connection | null = null
  private connected = false
  private loggedIn = false
  private events: BrokerEvent[] = []
  private requestCache = new Map<string, CachedRequest>()

  constructor(record: PersistedSession) {
    this.profileId = record.profileId
    this.serverUrl = record.serverUrl
    this.username = record.username
    this.password = record.password
    this.connectedIntent = record.connectedIntent
    this.runningIntent = record.runningIntent
    this.lastSeq = record.lastSeq
    this.lastSnapshot = record.lastSnapshot
    this.lastError = record.lastError
    this.updatedAt = record.updatedAt
  }

  toState(): BrokerSessionState {
    return {
      profileId: this.profileId,
      mode: this.mode,
      serverUrl: this.serverUrl,
      connected: this.connected && !!this.connection?.isConnected(),
      loggedIn: this.loggedIn,
      connectedIntent: this.connectedIntent,
      runningIntent: this.runningIntent,
      lastSeq: this.lastSeq,
      lastSnapshot: this.lastSnapshot,
      lastError: this.lastError,
      updatedAt: this.updatedAt,
    }
  }

  toPersisted(): PersistedSession {
    return {
      profileId: this.profileId,
      mode: this.mode,
      serverUrl: this.serverUrl,
      username: this.username,
      password: this.password,
      connectedIntent: this.connectedIntent,
      runningIntent: this.runningIntent,
      lastSeq: this.lastSeq,
      lastSnapshot: this.lastSnapshot,
      lastError: this.lastError,
      updatedAt: this.updatedAt,
    }
  }

  getEventsSince(seq: number): BrokerEvent[] {
    return this.events.filter((event) => event.seq > seq)
  }

  async connect(req: BrokerConnectRequest): Promise<BrokerSessionState> {
    this.serverUrl = req.serverUrl
    this.connectedIntent = true
    this.updatedAt = Date.now()
    await this.ensureConnected()
    return this.toState()
  }

  async login(req: BrokerLoginRequest): Promise<LoginResult> {
    this.username = req.username
    this.password = req.password
    this.updatedAt = Date.now()
    await this.ensureConnected()
    const result = this.normalizeLoginResult(await this.connection!.login(req.username, req.password), req.username)
    this.loggedIn = result.success
    this.lastError = result.success ? null : (result.error || 'login_failed')
    this.pushConnectionEvent({
      connected: this.connected,
      loggedIn: this.loggedIn,
      message: result.success ? 'logged_in' : `login_failed:${result.error || 'unknown'}`,
    })
    if (!result.success) throw new Error(result.error || 'Login failed')
    return result
  }

  async register(req: BrokerRegisterRequest): Promise<RegisterResult> {
    this.updatedAt = Date.now()
    await this.ensureConnected()
    const result = await this.connection!.register(req.username, req.empire, req.code)
    if (result.success && result.username && result.password) {
      this.username = result.username
      this.password = result.password
      this.loggedIn = true
      this.lastError = null
    } else if (!result.success) {
      this.lastError = result.error || 'register_failed'
    }
    this.pushConnectionEvent({
      connected: this.connected,
      loggedIn: this.loggedIn,
      message: result.success ? 'registered' : `register_failed:${result.error || 'unknown'}`,
    })
    if (!result.success) throw new Error(result.error || 'Register failed')
    return result
  }

  async execute(req: BrokerExecuteRequest): Promise<CommandResult> {
    this.pruneRequestCache()
    const cached = this.requestCache.get(req.requestId)
    if (cached?.result) return cached.result
    if (cached?.promise) return cached.promise

    await this.ensureConnected()
    if (req.command !== 'login' && req.command !== 'register') {
      await this.ensureAuthenticated()
    }
    const promise = this.connection!.execute(req.command, req.args)
      .then((result) => {
        if (result.error && AUTH_RECOVERABLE_ERRORS.has(result.error.code) && req.command !== 'login' && req.command !== 'register') {
          return this.retryAfterBrokerRelogin(req, result)
        }
        this.captureCommandResult(req.command, result)
        this.requestCache.set(req.requestId, { result, expiresAt: Date.now() + REQUEST_RESULT_TTL_MS })
        return result
      })
      .catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err)
        this.updatedAt = Date.now()
        throw err
      })
    this.requestCache.set(req.requestId, { promise, expiresAt: Date.now() + REQUEST_RESULT_TTL_MS })
    return promise
  }

  async disconnect(): Promise<void> {
    this.connectedIntent = false
    this.runningIntent = false
    this.updatedAt = Date.now()
    this.loggedIn = false
    this.lastError = null
    const connection = this.connection
    this.connection = null
    this.connected = false
    this.pushConnectionEvent({ connected: false, loggedIn: false, message: 'disconnected' })
    if (connection) await connection.disconnect()
  }

  setRunningIntent(runningIntent: boolean): void {
    this.runningIntent = runningIntent
    this.updatedAt = Date.now()
  }

  async restore(): Promise<void> {
    if (!this.connectedIntent) return
    try {
      await this.ensureConnected()
      if (this.username && this.password) {
        const result = this.normalizeLoginResult(await this.connection!.login(this.username, this.password), this.username)
        this.loggedIn = result.success
        this.lastError = result.success ? null : (result.error || 'login_failed')
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.updatedAt = Date.now()
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.connection?.isConnected()) {
      this.connected = true
      return
    }

    if (this.connection) {
      try {
        await this.connection.disconnect()
      } catch {
        // ignore
      }
    }

    const next = new WebSocketV2Connection(this.serverUrl)
    next.setTransportLog((type, msg) => {
      this.updatedAt = Date.now()
      if (type === 'error') this.lastError = msg
      if (msg.toLowerCase().includes('opened')) {
        this.connected = true
      }
      if (msg.toLowerCase().includes('closed') || msg.toLowerCase().includes('disconnect')) {
        this.connected = false
        this.loggedIn = false
      }
      this.pushConnectionEvent({
        connected: type === 'error' ? this.connected : next.isConnected(),
        loggedIn: this.loggedIn,
        message: msg,
      })
    })
    next.onNotification(this.handleNotification)

    await next.connect()
    this.connection = next
    this.connected = true
    this.lastError = null
    this.updatedAt = Date.now()
    this.pushConnectionEvent({ connected: true, loggedIn: this.loggedIn, message: 'connected' })
  }

  private handleNotification: NotificationHandler = (notification) => {
    this.updatedAt = Date.now()
    this.events.push({
      seq: ++this.lastSeq,
      profileId: this.profileId,
      ts: this.updatedAt,
      type: 'notification',
      payload: notification,
    })
    if (this.events.length > MAX_EVENTS_PER_SESSION) {
      this.events.splice(0, this.events.length - MAX_EVENTS_PER_SESSION)
    }
  }

  private pushConnectionEvent(payload: { connected: boolean; loggedIn: boolean; message: string }): void {
    this.events.push({
      seq: ++this.lastSeq,
      profileId: this.profileId,
      ts: Date.now(),
      type: 'connection',
      payload,
    })
    if (this.events.length > MAX_EVENTS_PER_SESSION) {
      this.events.splice(0, this.events.length - MAX_EVENTS_PER_SESSION)
    }
  }

  private captureCommandResult(command: string, result: CommandResult): void {
    this.updatedAt = Date.now()
    if (result.error) {
      this.lastError = `${result.error.code}: ${result.error.message}`
    } else {
      this.lastError = null
    }
    if (command === 'get_status' || command === 'get_location' || command === 'get_queue') {
      const data = result.structuredContent ?? result.result
      this.lastSnapshot = data && typeof data === 'object' ? data as Record<string, unknown> : this.lastSnapshot
    }
  }

  private pruneRequestCache(): void {
    const now = Date.now()
    for (const [key, entry] of this.requestCache.entries()) {
      if (entry.expiresAt <= now && !entry.promise) this.requestCache.delete(key)
    }
  }

  private normalizeLoginResult(result: LoginResult, username: string): LoginResult {
    if (result.success) return result
    const message = (result.error || '').toLowerCase()
    if (!message.includes('already logged in')) return result
    const sameUser = !username || message.includes(`'${username.toLowerCase()}'`) || message.includes(`"${username.toLowerCase()}"`)
    if (!sameUser) return result
    return {
      success: true,
      player_id: result.player_id,
      session: result.session,
    }
  }

  private async ensureAuthenticated(): Promise<boolean> {
    if (this.loggedIn) return true
    if (!this.username || !this.password || !this.connection) return false
    const result = this.normalizeLoginResult(await this.connection.login(this.username, this.password), this.username)
    this.loggedIn = result.success
    this.lastError = result.success ? null : (result.error || 'login_failed')
    if (result.success) {
      this.pushConnectionEvent({
        connected: this.connected,
        loggedIn: true,
        message: 'logged_in',
      })
    }
    return result.success
  }

  private async retryAfterBrokerRelogin(req: BrokerExecuteRequest, original: CommandResult): Promise<CommandResult> {
    const reauthed = await this.ensureAuthenticated()
    if (!reauthed) return original
    const retried = await this.connection!.execute(req.command, req.args)
    this.captureCommandResult(req.command, retried)
    this.requestCache.set(req.requestId, { result: retried, expiresAt: Date.now() + REQUEST_RESULT_TTL_MS })
    return retried
  }
}

export class BrokerSessionManager {
  private sessions = new Map<string, BrokerSession>()

  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    for (const record of this.readPersisted()) {
      this.sessions.set(record.profileId, new BrokerSession(record))
    }
  }

  async restorePersistedSessions(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.restore()
      this.persist()
    }
  }

  listSessions(): BrokerSessionState[] {
    return [...this.sessions.values()].map((session) => session.toState())
  }

  getSession(profileId: string): BrokerSessionState | null {
    return this.sessions.get(profileId)?.toState() || null
  }

  async connect(profileId: string, req: BrokerConnectRequest): Promise<BrokerSessionState> {
    const session = this.getOrCreate(profileId, req.serverUrl)
    const state = await session.connect(req)
    this.persist()
    return state
  }

  async login(profileId: string, req: BrokerLoginRequest): Promise<{ result: LoginResult; session: BrokerSessionState }> {
    const session = this.getOrCreate(profileId)
    const result = await session.login(req)
    this.persist()
    return { result, session: session.toState() }
  }

  async register(profileId: string, req: BrokerRegisterRequest): Promise<{ result: RegisterResult; session: BrokerSessionState }> {
    const session = this.getOrCreate(profileId)
    const result = await session.register(req)
    this.persist()
    return { result, session: session.toState() }
  }

  async execute(profileId: string, req: BrokerExecuteRequest): Promise<{ result: CommandResult; session: BrokerSessionState }> {
    const session = this.getOrCreate(profileId)
    const result = await session.execute(req)
    this.persist()
    return { result, session: session.toState() }
  }

  async disconnect(profileId: string): Promise<BrokerSessionState | null> {
    const session = this.sessions.get(profileId)
    if (!session) return null
    await session.disconnect()
    this.persist()
    return session.toState()
  }

  setRunningIntent(profileId: string, runningIntent: boolean): BrokerSessionState | null {
    const session = this.sessions.get(profileId)
    if (!session) return null
    session.setRunningIntent(runningIntent)
    this.persist()
    return session.toState()
  }

  getEvents(profileId: string, sinceSeq: number): { events: BrokerEvent[]; session: BrokerSessionState } | null {
    const session = this.sessions.get(profileId)
    if (!session) return null
    return { events: session.getEventsSince(sinceSeq), session: session.toState() }
  }

  private getOrCreate(profileId: string, serverUrl?: string): BrokerSession {
    let session = this.sessions.get(profileId)
    if (session) {
      if (serverUrl) session.serverUrl = serverUrl
      return session
    }
    if (!serverUrl) throw new Error(`Missing broker session for ${profileId}`)
    session = new BrokerSession({
      profileId,
      mode: 'websocket_v2',
      serverUrl,
      username: null,
      password: null,
      connectedIntent: false,
      runningIntent: false,
      lastSeq: 0,
      lastSnapshot: null,
      lastError: null,
      updatedAt: Date.now(),
    })
    this.sessions.set(profileId, session)
    return session
  }

  private readPersisted(): PersistedSession[] {
    try {
      const raw = fs.readFileSync(SESSIONS_PATH, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((entry): entry is PersistedSession => !!entry && typeof entry === 'object')
    } catch {
      return []
    }
  }

  private persist(): void {
    const body = JSON.stringify([...this.sessions.values()].map((session) => session.toPersisted()), null, 2)
    fs.writeFileSync(SESSIONS_PATH, body, 'utf-8')
  }
}
