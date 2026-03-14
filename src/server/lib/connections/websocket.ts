import type { GameConnection, LoginResult, RegisterResult, CommandResult, NotificationHandler } from './interface'
import { USER_AGENT } from './interface'
import WebSocket from 'ws'

const RECONNECT_BASE_DELAY = 1000
const RECONNECT_MAX_DELAY = 30000
const HANDSHAKE_FAILURE_BACKOFF_MS = 60_000
const COMMAND_TIMEOUT = 30_000
const AUTH_RECOVERABLE_ERRORS = new Set(['not_authenticated', 'session_invalid', 'session_expired'])

/**
 * Message types that are direct responses to client commands.
 * Everything else is a server-push notification.
 */
const RESPONSE_TYPES = new Set([
  'ok',           // Generic success (queries + mutation acks)
  'error',        // Generic error
  'logged_in',    // Response to 'login'
  'registered',   // Response to 'register' (followed by 'logged_in' as notification)
  'version_info', // Response to 'get_version'
])

export class WebSocketConnection implements GameConnection {
  readonly mode = 'websocket' as const
  private wsUrl: string
  private ws: WebSocket | null = null
  private notificationHandlers: NotificationHandler[] = []
  private connected = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private credentials: { username: string; password: string } | null = null
  private handshakeBackoffUntil = 0
  private reauthInFlight: Promise<boolean> | null = null

  // Sequential FIFO queue: server processes commands in order with no request IDs
  private pendingQueue: Array<{
    resolve: (value: CommandResult) => void
    timer: ReturnType<typeof setTimeout>
    command: string
  }> = []

  constructor(serverUrl: string) {
    const base = serverUrl.replace(/\/$/, '')
    this.wsUrl = base.replace(/^http/, 'ws') + '/ws'
  }

  async connect(): Promise<void> {
    if (Date.now() < this.handshakeBackoffUntil) {
      throw new Error(`WebSocket handshake backoff active for ${Math.ceil((this.handshakeBackoffUntil - Date.now()) / 1000)}s`)
    }
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl, { headers: { 'User-Agent': USER_AGENT } })
        this.ws.on('unexpected-response', (_req, res) => {
          if (!this.connected) {
            this.noteHandshakeFailure(`HTTP ${res.statusCode}`)
            reject(new Error(`WebSocket handshake failed: HTTP ${res.statusCode}`))
          }
        })

        this.ws.onopen = () => {
          this.connected = true
          this.handshakeBackoffUntil = 0
          this.reconnectAttempt = 0
          resolve()
        }

        this.ws.onmessage = (event) => {
          const raw = String(event.data)
          const lines = raw.split('\n').filter(l => l.trim())
          for (const line of lines) {
            try {
              const msg = JSON.parse(line)
              this.handleMessage(msg)
            } catch {
              // Ignore unparseable
            }
          }
        }

        this.ws.onclose = (event) => {
          this.connected = false
          if (event.code === 1002 && String(event.reason || '').includes('Expected 101 status code')) {
            this.noteHandshakeFailure(`close code ${event.code}`)
          }
          this.rejectAllPending('Connection closed')
          this.scheduleReconnect()
        }

        this.ws.onerror = (err) => {
          if (!this.connected) {
            if (err.message.includes('Expected 101 status code')) {
              this.noteHandshakeFailure('Expected 101 status code')
            }
            reject(new Error(`WebSocket connection failed: ${err.message}`))
          }
        }
      } catch (err) {
        reject(err)
      }
    })
  }

  async login(username: string, password: string): Promise<LoginResult> {
    this.credentials = { username, password }
    const resp = await this.sendCommand('login', { username, password })
    if (resp.error) {
      return { success: false, error: resp.error.message }
    }
    const result = resp.result as Record<string, unknown> | undefined
    // logged_in payload has player.id, not a top-level player_id
    const player = result?.player as Record<string, unknown> | undefined
    return {
      success: true,
      player_id: (player?.id as string) || (result?.player_id as string | undefined),
    }
  }

  async register(username: string, empire: string, code?: string): Promise<RegisterResult> {
    const args: Record<string, unknown> = { username, empire }
    if (code) args.registration_code = code
    const resp = await this.sendCommand('register', args)
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

  async disconnect(): Promise<void> {
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
      return { error: { code: 'not_connected', message: 'WebSocket not connected' } }
    }

    // Server protocol: { type: "command_name", payload: { ... } } -- no request ID
    const msg = { type: command, payload: args || {} }

    const response = await new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.pendingQueue.findIndex(p => p.timer === timer)
        if (idx !== -1) this.pendingQueue.splice(idx, 1)
        resolve({ error: { code: 'timeout', message: `Command ${command} timed out` } })
      }, COMMAND_TIMEOUT)

      this.pendingQueue.push({ resolve, timer, command })
      this.ws!.send(JSON.stringify(msg))
    })

    if (!response.error || !canRetryAuth) return response
    if (!AUTH_RECOVERABLE_ERRORS.has(response.error.code)) return response
    if (command === 'login' || !this.credentials) return response

    const reauthed = await this.ensureAuthenticated()
    if (!reauthed) return response
    return this.sendCommand(command, args, false)
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string
    const payload = (msg.payload || {}) as Record<string, unknown>

    // If this is a response type and we have a pending command, resolve it
    if (RESPONSE_TYPES.has(type) && this.pendingQueue.length > 0) {
      const pending = this.pendingQueue.shift()!
      clearTimeout(pending.timer)

      if (type === 'error') {
        pending.resolve({
          error: {
            code: (payload.code as string) || 'server_error',
            message: this.mapServerError(payload),
          },
        })
      } else {
        pending.resolve({ result: payload })
      }
      return
    }

    // Server-push notification (welcome, tick, state_update, action_result, etc.)
    for (const handler of this.notificationHandlers) {
      handler(msg)
    }
  }

  private rejectAllPending(reason: string): void {
    for (const pending of this.pendingQueue) {
      clearTimeout(pending.timer)
      pending.resolve({ error: { code: 'disconnected', message: reason } })
    }
    this.pendingQueue = []
  }

  private scheduleReconnect(): void {
    const now = Date.now()
    if (now < this.handshakeBackoffUntil) {
      const delay = Math.max(this.handshakeBackoffUntil - now, RECONNECT_BASE_DELAY)
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        this.scheduleReconnect()
      }, delay)
      return
    }
    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_DELAY
    )
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect()
        // Re-authenticate after reconnect
        if (this.credentials) {
          await this.sendCommand('login', {
            username: this.credentials.username,
            password: this.credentials.password,
          })
        }
      } catch {
        // onclose will fire and schedule next reconnect
      }
    }, delay)
  }

  private noteHandshakeFailure(reason: string): void {
    const until = Date.now() + HANDSHAKE_FAILURE_BACKOFF_MS
    if (until <= this.handshakeBackoffUntil) return
    this.handshakeBackoffUntil = until
  }

  private mapServerError(payload: Record<string, unknown>): string {
    const code = (payload.code as string) || 'server_error'
    const message = (payload.message as string) || 'Unknown error'
    if (code === 'not_authenticated') return 'Authentication required. Re-login and retry.'
    if (code === 'session_expired') return 'Session expired. Re-login and retry.'
    if (code === 'session_invalid') return 'Session invalid. Re-login and retry.'
    return message
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
