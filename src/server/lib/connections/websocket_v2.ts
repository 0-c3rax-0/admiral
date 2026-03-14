import type { GameConnection, LoginResult, RegisterResult, CommandResult, NotificationHandler } from './interface'
import { USER_AGENT } from './interface'
import WebSocket from 'ws'
import { normalizeCommandResult } from './command-meta'

const RECONNECT_BASE_DELAY = 1000
const RECONNECT_MAX_DELAY = 30_000
const HANDSHAKE_FAILURE_BACKOFF_MS = 60_000
const CONNECT_TIMEOUT = 10_000
const COMMAND_TIMEOUT = 30_000
const HEARTBEAT_INTERVAL = 15_000
const HEARTBEAT_INTERVAL_BUSY = 5_000
const HEARTBEAT_TIMEOUT = 60_000
const HEARTBEAT_MISSES_BEFORE_TERMINATE = 2
const PENDING_ACTIVITY_STALE_MS = 20_000
const MAX_PENDING_COMMANDS = 32

const RESPONSE_TYPES = new Set([
  'ok',
  'error',
  'logged_in',
  'registered',
  'version_info',
])

const AUTH_RECOVERABLE_ERRORS = new Set(['not_authenticated', 'session_invalid', 'session_expired'])

interface PendingCommand {
  resolve: (value: CommandResult) => void
  timer: ReturnType<typeof setTimeout>
  command: string
  args?: Record<string, unknown>
  canRetryAuth: boolean
}

export class WebSocketV2Connection implements GameConnection {
  readonly mode = 'websocket_v2' as const
  private wsUrl: string
  private ws: WebSocket | null = null
  private notificationHandlers: NotificationHandler[] = []
  private connected = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private credentials: { username: string; password: string } | null = null
  private shouldReconnect = true
  private reauthInFlight: Promise<boolean> | null = null
  private reconnectInFlight: Promise<boolean> | null = null
  private handshakeBackoffUntil = 0
  private lastPongAt = 0
  private lastMessageAt = 0
  private lastActivityAt = 0
  private lastHeartbeatSentAt = 0
  private heartbeatMisses = 0
  private heartbeatFallbackPending = false
  private transportLog: ((type: 'info' | 'warn' | 'error', msg: string) => void) | null = null
  private onPong = () => {
    this.lastPongAt = Date.now()
    this.lastActivityAt = this.lastPongAt
    this.heartbeatFallbackPending = false
    this.heartbeatMisses = 0
  }

  private pendingQueue: PendingCommand[] = []

  constructor(serverUrl: string) {
    this.wsUrl = toWebSocketUrl(serverUrl)
  }

  async connect(): Promise<void> {
    this.shouldReconnect = true
    if (Date.now() < this.handshakeBackoffUntil) {
      throw new Error(`WebSocket handshake backoff active for ${Math.ceil((this.handshakeBackoffUntil - Date.now()) / 1000)}s`)
    }
    return new Promise((resolve, reject) => {
      const currentWs = this.ws = new WebSocket(this.wsUrl, { headers: { 'User-Agent': USER_AGENT } })
      let settled = false
      let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        if (settled) return
        settled = true
        try { currentWs.terminate() } catch { /* ignore */ }
        reject(new Error('WebSocket connection timed out during open handshake'))
      }, CONNECT_TIMEOUT)
      try {
        currentWs.on('unexpected-response', (_req, res) => {
          if (!this.connected && !settled) {
            settled = true
            if (connectTimer) clearTimeout(connectTimer)
            this.noteHandshakeFailure(`HTTP ${res.statusCode}`)
            reject(new Error(`WebSocket handshake failed: HTTP ${res.statusCode}`))
          }
        })

        currentWs.onopen = () => {
          if (this.ws !== currentWs) return
          const socket = (currentWs as WebSocket & { _socket?: { setNoDelay?: (noDelay?: boolean) => void } } | null)?._socket
          socket?.setNoDelay?.(true)
          this.connected = true
          this.handshakeBackoffUntil = 0
          this.reconnectAttempt = 0
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
          }
          this.lastPongAt = Date.now()
          this.lastMessageAt = this.lastPongAt
          this.lastActivityAt = this.lastPongAt
          this.lastHeartbeatSentAt = 0
          this.heartbeatMisses = 0
          this.heartbeatFallbackPending = false
          this.startHeartbeat()
          this.logTransport('info', `WebSocket opened: ${this.wsUrl}`)
          settled = true
          if (connectTimer) clearTimeout(connectTimer)
          connectTimer = null
          resolve()
        }

        currentWs.onmessage = (event) => {
          if (this.ws !== currentWs) return
          this.lastMessageAt = Date.now()
          this.lastActivityAt = this.lastMessageAt
          this.heartbeatFallbackPending = false
          this.heartbeatMisses = 0
          const raw = String(event.data)
          const lines = raw.split('\n').filter(l => l.trim())
          for (const line of lines) {
            try {
              const msg = JSON.parse(line)
              this.handleMessage(msg)
            } catch {
              // Ignore unparseable line
            }
          }
        }

        currentWs.on('pong', this.onPong)

        currentWs.onclose = (event) => {
          if (this.ws !== currentWs) return
          this.connected = false
          this.stopHeartbeat()
          const reason = event.reason ? `: ${event.reason}` : ''
          this.logTransport('warn', `WebSocket closed (code ${event.code}${reason})`)
          this.rejectAllPending(`Connection closed (code ${event.code}${reason})`)
          if (!settled) {
            settled = true
            if (connectTimer) clearTimeout(connectTimer)
            if (event.code === 1002 && String(event.reason || '').includes('Expected 101 status code')) {
              this.noteHandshakeFailure(`close code ${event.code}`)
            }
            reject(new Error(`WebSocket connection closed before open (code ${event.code}${reason})`))
          }
          if (this.shouldReconnect && !this.reconnectInFlight) {
            this.scheduleReconnect()
          }
        }

        currentWs.onerror = (err) => {
          if (this.ws !== currentWs) return
          this.logTransport('error', `WebSocket error: ${err.message}`)
          if (!this.connected && !settled) {
            settled = true
            if (connectTimer) clearTimeout(connectTimer)
            if (err.message.includes('Expected 101 status code')) {
              this.noteHandshakeFailure('Expected 101 status code')
            }
            reject(new Error(`WebSocket connection failed: ${err.message}`))
          }
        }
      } catch (err) {
        if (connectTimer) clearTimeout(connectTimer)
        reject(err)
      }
    })
  }

  async login(username: string, password: string): Promise<LoginResult> {
    this.credentials = { username, password }
    const resp = await this.sendCommand('login', { username, password }, false)
    if (resp.error) {
      return { success: false, error: resp.error.message }
    }
    const result = resp.result as Record<string, unknown> | undefined
    const player = result?.player as Record<string, unknown> | undefined
    return {
      success: true,
      player_id: (player?.id as string) || (result?.player_id as string | undefined),
    }
  }

  async register(username: string, empire: string, code?: string): Promise<RegisterResult> {
    const args: Record<string, unknown> = { username, empire }
    if (code) args.registration_code = code
    const resp = await this.sendCommand('register', args, false)
    if (resp.error) {
      return { success: false, error: resp.error.message }
    }
    const result = resp.result as Record<string, unknown> | undefined
    if (result?.password) {
      this.credentials = {
        username: (result.username as string) || username,
        password: result.password as string,
      }
    }
    return {
      success: true,
      username: (result?.username as string) || username,
      password: result?.password as string,
      player_id: result?.player_id as string,
      empire: (result?.empire as string) || empire,
    }
  }

  async execute(command: string, args?: Record<string, unknown>): Promise<CommandResult> {
    return this.sendCommand(command, args, true)
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler)
  }

  setTransportLog(handler: (type: 'info' | 'warn' | 'error', msg: string) => void): void {
    this.transportLog = handler
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.rejectAllPending('Disconnecting')
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.off('pong', this.onPong)
      this.ws.close()
      this.ws = null
    }
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected && !!this.ws && this.ws.readyState === WebSocket.OPEN
  }

  private async sendCommand(command: string, args?: Record<string, unknown>, canRetryAuth = true): Promise<CommandResult> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const reconnected = await this.ensureSocketReady()
      if (!reconnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return { error: { code: 'not_connected', message: 'WebSocket not connected' } }
      }
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { error: { code: 'not_connected', message: 'WebSocket not connected' } }
    }
    if (this.pendingQueue.length >= MAX_PENDING_COMMANDS) {
      return { error: { code: 'client_busy', message: 'Too many pending WebSocket commands; refusing to queue more work' } }
    }

    const msg = { type: command, payload: args || {} }

    const response = await new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.pendingQueue.findIndex(p => p.timer === timer)
        if (idx !== -1) this.pendingQueue.splice(idx, 1)
        resolve({ error: { code: 'timeout', message: `Command ${command} timed out` } })
      }, COMMAND_TIMEOUT)

      this.pendingQueue.push({ resolve, timer, command, args, canRetryAuth })
      this.lastActivityAt = Date.now()
      try {
        this.ws!.send(JSON.stringify(msg))
      } catch (err) {
        clearTimeout(timer)
        const idx = this.pendingQueue.findIndex(p => p.timer === timer)
        if (idx !== -1) this.pendingQueue.splice(idx, 1)
        resolve({
          error: {
            code: 'send_failed',
            message: `WebSocket send failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        })
      }
    })

    if (!response.error || !canRetryAuth) return response
    if (response.error.code === 'not_connected' || response.error.code === 'disconnected') {
      const reconnected = await this.ensureSocketReady()
      if (reconnected) return this.sendCommand(command, args, false)
      return response
    }
    if (!AUTH_RECOVERABLE_ERRORS.has(response.error.code)) return response
    if (command === 'login' || !this.credentials) return response

    const reauthed = await this.ensureAuthenticated()
    if (!reauthed) return response
    return this.sendCommand(command, args, false)
  }

  private async ensureSocketReady(): Promise<boolean> {
    if (!this.shouldReconnect) return false
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return true
    if (this.reconnectInFlight) return this.reconnectInFlight
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    this.reconnectInFlight = (async () => {
      try {
        if (this.ws) {
          this.ws.onopen = null
          this.ws.onmessage = null
          this.ws.onclose = null
          this.ws.onerror = null
          this.ws.off('pong', this.onPong)
          try { this.ws.close() } catch { /* ignore */ }
          this.ws = null
        }
        this.connected = false
        this.logTransport('warn', 'Attempting immediate WebSocket reconnect')
        await this.connect()
        this.logTransport('info', 'Immediate WebSocket reconnect succeeded')
        if (this.credentials) {
          const loginResp = await this.sendCommand('login', {
            username: this.credentials.username,
            password: this.credentials.password,
          }, false)
          if (loginResp.error) {
            this.logTransport('error', `Re-login after immediate reconnect failed: ${loginResp.error.code}`)
            return false
          }
          this.logTransport('info', 'Re-login after immediate reconnect succeeded')
        }
        return this.connected
      } catch (err) {
        this.logTransport('error', `Immediate WebSocket reconnect failed: ${err instanceof Error ? err.message : String(err)}`)
        return false
      } finally {
        this.reconnectInFlight = null
      }
    })()

    return this.reconnectInFlight
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string
    const payload = (msg.payload || {}) as Record<string, unknown>

    if (RESPONSE_TYPES.has(type) && this.pendingQueue.length > 0) {
      const pending = this.pendingQueue.shift()!
      clearTimeout(pending.timer)

      if (type === 'error') {
        pending.resolve({
          error: {
            code: (payload.code as string) || 'server_error',
            message: this.mapServerError(payload),
            wait_seconds: payload.wait_seconds as number | undefined,
          },
        })
      } else {
        pending.resolve(normalizeCommandResult(pending.command, { result: payload }))
      }
      return
    }

    for (const handler of this.notificationHandlers) {
      handler(msg)
    }
  }

  private mapServerError(payload: Record<string, unknown>): string {
    const code = (payload.code as string) || 'server_error'
    const message = (payload.message as string) || 'Unknown error'
    if (code === 'not_authenticated') return 'Authentication required. Re-login and retry.'
    if (code === 'session_expired') return 'Session expired. Re-login and retry.'
    if (code === 'session_invalid') return 'Session invalid. Re-login and retry.'
    return message
  }

  private rejectAllPending(reason: string): void {
    for (const pending of this.pendingQueue) {
      clearTimeout(pending.timer)
      pending.resolve({ error: { code: 'disconnected', message: reason } })
    }
    this.pendingQueue = []
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.reconnectInFlight || !this.shouldReconnect) {
      return
    }

    const now = Date.now()
    if (now < this.handshakeBackoffUntil) {
      const delay = Math.max(this.handshakeBackoffUntil - now, RECONNECT_BASE_DELAY)
      this.logTransport('warn', `Handshake backoff active; delaying reconnect for ${delay}ms`)
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        this.scheduleReconnect()
      }, delay)
      return
    }

    const baseDelay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempt), RECONNECT_MAX_DELAY)
    const jitter = Math.floor(Math.random() * 500)
    const delay = baseDelay + jitter
    this.reconnectAttempt++
    this.logTransport('warn', `Scheduling WebSocket reconnect attempt ${this.reconnectAttempt} in ${delay}ms`)

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        await this.connect()
        this.logTransport('info', 'Scheduled WebSocket reconnect succeeded')
        if (this.credentials) {
          const loginResp = await this.sendCommand('login', {
            username: this.credentials.username,
            password: this.credentials.password,
          }, false)
          if (loginResp.error) {
            this.logTransport('error', `Re-login after scheduled reconnect failed: ${loginResp.error.code}`)
            return
          }
          this.logTransport('info', 'Re-login after scheduled reconnect succeeded')
        }
      } catch (err) {
        this.logTransport('error', `Scheduled WebSocket reconnect failed: ${err instanceof Error ? err.message : String(err)}`)
        // onclose schedules subsequent retries
      }
    }, delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
      const now = Date.now()
      const lastInboundAt = Math.max(this.lastMessageAt, this.lastPongAt)
      const heartbeatInterval = this.pendingQueue.length > 0 ? HEARTBEAT_INTERVAL_BUSY : HEARTBEAT_INTERVAL
      if (this.pendingQueue.length > 0 && now - this.lastActivityAt > PENDING_ACTIVITY_STALE_MS) {
        this.logTransport('warn', `Terminating stale WebSocket after ${now - this.lastActivityAt}ms with ${this.pendingQueue.length} pending command(s)`)
        this.ws.terminate()
        return
      }
      if (now - lastInboundAt > HEARTBEAT_TIMEOUT) {
        if (!this.heartbeatFallbackPending) {
          this.heartbeatFallbackPending = true
          this.lastHeartbeatSentAt = now
          this.logTransport('warn', `No inbound WebSocket activity for ${now - lastInboundAt}ms; sending empty-message heartbeat fallback`)
          try {
            this.ws.send('')
          } catch (err) {
            this.logTransport('error', `WebSocket fallback heartbeat failed: ${err instanceof Error ? err.message : String(err)}`)
            this.ws.terminate()
          }
          return
        }
        this.heartbeatMisses++
        if (this.heartbeatMisses >= HEARTBEAT_MISSES_BEFORE_TERMINATE) {
          this.logTransport('warn', `Heartbeat timeout after ${now - lastInboundAt}ms; terminating socket`)
          this.ws.terminate()
        }
        return
      }
      if (now - lastInboundAt < HEARTBEAT_TIMEOUT) {
        this.heartbeatFallbackPending = false
      }
      this.heartbeatMisses = 0
      if (now - lastInboundAt < heartbeatInterval || now - this.lastHeartbeatSentAt < heartbeatInterval) {
        return
      }
      try {
        this.lastHeartbeatSentAt = now
        this.ws.ping()
      } catch (err) {
        this.logTransport('error', `WebSocket ping failed: ${err instanceof Error ? err.message : String(err)}`)
        try {
          this.lastHeartbeatSentAt = now
          this.heartbeatFallbackPending = true
          this.ws.send('')
        } catch (fallbackErr) {
          this.logTransport('error', `WebSocket fallback heartbeat failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`)
          this.ws.terminate()
        }
      }
    }, HEARTBEAT_INTERVAL_BUSY)
  }

  private noteHandshakeFailure(reason: string): void {
    const until = Date.now() + HANDSHAKE_FAILURE_BACKOFF_MS
    if (until <= this.handshakeBackoffUntil) return
    this.handshakeBackoffUntil = until
    this.logTransport('warn', `WebSocket handshake instability detected (${reason}); backing off reconnects for ${Math.round(HANDSHAKE_FAILURE_BACKOFF_MS / 1000)}s`)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private logTransport(type: 'info' | 'warn' | 'error', msg: string): void {
    this.transportLog?.(type, msg)
  }

  private async ensureAuthenticated(): Promise<boolean> {
    if (!this.credentials) return false
    if (this.reauthInFlight) return this.reauthInFlight

    this.reauthInFlight = (async () => {
      const loginResp = await this.sendCommand('login', {
        username: this.credentials!.username,
        password: this.credentials!.password,
      }, false)
      return !loginResp.error
    })()

    try {
      return await this.reauthInFlight
    } finally {
      this.reauthInFlight = null
    }
  }
}

function toWebSocketUrl(serverUrl: string): string {
  const raw = serverUrl.trim()
  try {
    const u = new URL(raw)
    if (u.protocol === 'http:') u.protocol = 'ws:'
    else if (u.protocol === 'https:') u.protocol = 'wss:'
    const path = u.pathname.replace(/\/+$/, '')
    u.pathname = path.endsWith('/ws') ? path : `${path}/ws`
    return u.toString()
  } catch {
    const base = raw.replace(/\/$/, '')
    return base.replace(/^http/, 'ws') + '/ws'
  }
}
