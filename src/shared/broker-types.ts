import type { CommandResult, LoginResult, RegisterResult } from '../server/lib/connections/interface'

export const DEFAULT_BROKER_URL = 'http://127.0.0.1:3032'

export type BrokerSessionMode = 'websocket_v2'

export interface BrokerEvent {
  seq: number
  profileId: string
  ts: number
  type: 'notification' | 'connection'
  payload: unknown
}

export interface BrokerSessionState {
  profileId: string
  mode: BrokerSessionMode
  serverUrl: string
  connected: boolean
  loggedIn: boolean
  connectedIntent: boolean
  runningIntent: boolean
  lastSeq: number
  lastSnapshot: Record<string, unknown> | null
  lastError: string | null
  updatedAt: number
}

export interface BrokerConnectRequest {
  serverUrl: string
}

export interface BrokerLoginRequest {
  username: string
  password: string
}

export interface BrokerRegisterRequest {
  username: string
  empire: string
  code?: string
}

export interface BrokerExecuteRequest {
  command: string
  args?: Record<string, unknown>
  requestId: string
}

export interface BrokerRunningIntentRequest {
  runningIntent: boolean
}

export interface BrokerSessionStateResponse {
  session: BrokerSessionState
}

export interface BrokerSessionListResponse {
  sessions: BrokerSessionState[]
}

export interface BrokerEventsResponse {
  events: BrokerEvent[]
  session: BrokerSessionState
}

export interface BrokerExecuteResponse {
  result: CommandResult
  session: BrokerSessionState
}

export interface BrokerLoginResponse {
  result: LoginResult
  session: BrokerSessionState
}

export interface BrokerRegisterResponse {
  result: RegisterResult
  session: BrokerSessionState
}
