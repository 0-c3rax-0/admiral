import type { GameConnection, CommandResult, LoginResult, NotificationHandler, RegisterResult } from './connections/interface'
import {
  DEFAULT_BROKER_URL,
  type BrokerConnectRequest,
  type BrokerEvent,
  type BrokerEventsResponse,
  type BrokerExecuteRequest,
  type BrokerExecuteResponse,
  type BrokerLoginRequest,
  type BrokerLoginResponse,
  type BrokerRegisterRequest,
  type BrokerRegisterResponse,
  type BrokerSessionListResponse,
  type BrokerSessionState,
  type BrokerSessionStateResponse,
} from '../../shared/broker-types'

const EVENT_POLL_INTERVAL_MS = 1000

function getBrokerBaseUrl(): string {
  return (process.env.ADMIRAL_BROKER_URL || DEFAULT_BROKER_URL).replace(/\/$/, '')
}

export async function listBrokerSessions(): Promise<BrokerSessionState[]> {
  const resp = await fetch(`${getBrokerBaseUrl()}/api/broker/sessions`)
  if (!resp.ok) throw new Error(`Broker session list failed: HTTP ${resp.status}`)
  const data = await resp.json() as BrokerSessionListResponse
  return Array.isArray(data.sessions) ? data.sessions : []
}

export async function setBrokerRunningIntent(profileId: string, runningIntent: boolean): Promise<void> {
  const resp = await fetch(`${getBrokerBaseUrl()}/api/broker/sessions/${encodeURIComponent(profileId)}/running-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runningIntent }),
  })
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`Broker running-intent update failed: HTTP ${resp.status}`)
  }
}

export class BrokerWebSocketV2Connection implements GameConnection {
  readonly mode = 'websocket_v2' as const
  private connected = false
  private lastSeq = 0
  private handlers: NotificationHandler[] = []
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private transportLog: ((type: 'info' | 'warn' | 'error', msg: string) => void) | null = null

  constructor(
    private readonly profileId: string,
    private readonly serverUrl: string,
  ) {}

  setTransportLog(fn: (type: 'info' | 'warn' | 'error', msg: string) => void): void {
    this.transportLog = fn
  }

  async connect(): Promise<void> {
    const data = await this.json<BrokerSessionStateResponse>(`/api/broker/sessions/${encodeURIComponent(this.profileId)}`, {
      method: 'PUT',
      body: { serverUrl: this.serverUrl } satisfies BrokerConnectRequest,
    })
    this.applySessionState(data.session)
    this.closed = false
    this.ensurePolling()
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const data = await this.json<BrokerLoginResponse>(`/api/broker/sessions/${encodeURIComponent(this.profileId)}/login`, {
      method: 'POST',
      body: { username, password } satisfies BrokerLoginRequest,
    })
    this.applySessionState(data.session)
    return data.result
  }

  async register(username: string, empire: string, code?: string): Promise<RegisterResult> {
    const data = await this.json<BrokerRegisterResponse>(`/api/broker/sessions/${encodeURIComponent(this.profileId)}/register`, {
      method: 'POST',
      body: { username, empire, code } satisfies BrokerRegisterRequest,
    })
    this.applySessionState(data.session)
    return data.result
  }

  async execute(command: string, args?: Record<string, unknown>): Promise<CommandResult> {
    const data = await this.json<BrokerExecuteResponse>(`/api/broker/sessions/${encodeURIComponent(this.profileId)}/execute`, {
      method: 'POST',
      body: {
        command,
        args,
        requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      } satisfies BrokerExecuteRequest,
    })
    this.applySessionState(data.session)
    return data.result
  }

  onNotification(handler: NotificationHandler): void {
    this.handlers.push(handler)
    this.ensurePolling()
  }

  async disconnect(): Promise<void> {
    this.closed = true
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    const resp = await fetch(`${getBrokerBaseUrl()}/api/broker/sessions/${encodeURIComponent(this.profileId)}`, {
      method: 'DELETE',
    })
    if (resp.ok) {
      const data = await resp.json() as BrokerSessionStateResponse
      this.applySessionState(data.session)
    } else {
      this.connected = false
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  private ensurePolling(): void {
    if (this.closed || this.pollTimer) return
    const tick = async () => {
      this.pollTimer = null
      if (this.closed) return
      try {
        const data = await this.json<BrokerEventsResponse>(`/api/broker/sessions/${encodeURIComponent(this.profileId)}/events?sinceSeq=${this.lastSeq}`)
        this.applySessionState(data.session)
        for (const event of data.events) {
          this.lastSeq = Math.max(this.lastSeq, event.seq)
          this.deliverEvent(event)
        }
      } catch (err) {
        this.transportLog?.('warn', `Broker event poll failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        if (!this.closed) this.pollTimer = setTimeout(tick, EVENT_POLL_INTERVAL_MS)
      }
    }
    this.pollTimer = setTimeout(tick, EVENT_POLL_INTERVAL_MS)
  }

  private deliverEvent(event: BrokerEvent): void {
    if (event.type === 'notification') {
      for (const handler of this.handlers) handler(event.payload)
      return
    }
    const payload = event.payload as Record<string, unknown>
    const connected = payload.connected === true
    const msg = typeof payload.message === 'string' ? payload.message : 'broker connection update'
    const previous = this.connected
    this.connected = connected
    if (previous !== connected || msg) {
      this.transportLog?.(connected ? 'info' : 'warn', `Broker session ${connected ? 'connected' : 'disconnected'}: ${msg}`)
    }
  }

  private applySessionState(session: BrokerSessionState): void {
    this.connected = session.connected
    this.lastSeq = Math.max(this.lastSeq, session.lastSeq || 0)
  }

  private async json<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const resp = await fetch(`${getBrokerBaseUrl()}${path}`, {
      method: init?.method || 'GET',
      headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(text || `HTTP ${resp.status}`)
    }
    return await resp.json() as T
  }
}
