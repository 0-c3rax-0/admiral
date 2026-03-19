export interface Provider {
  id: string
  api_key: string
  failover_api_key: string
  base_url: string
  status: 'valid' | 'invalid' | 'unknown' | 'unreachable'
}

export interface Profile {
  id: string
  name: string
  agent_role?: string
  username: string | null
  password: string | null
  empire: string
  player_id: string | null
  provider: string | null
  model: string | null
  failover_provider: string | null
  failover_model: string | null
  base_station: string | null
  mining_location: string | null
  directive: string
  todo: string
  context_budget: number | null
  connection_mode: 'http' | 'http_v2' | 'websocket' | 'websocket_v2' | 'mcp' | 'mcp_v2'
  server_url: string
  autoconnect: boolean
  enabled: boolean
  created_at: string
  updated_at: string
  stats_delta_1h?: {
    latest_ts: string | null
    anchor_ts: string | null
    credits: number
    ore_mined: number
    trades_completed: number
    systems_explored: number
  } | null
  last_storage_snapshot?: {
    ts: string
    station_id: string | null
    station_name: string | null
    wallet_credits: number | null
    storage_credits: number | null
    items: Array<{
      item_id: string
      quantity: number | null
    }>
  } | null
}

export interface LogEntry {
  id: number
  profile_id: string
  timestamp: string
  type: LogType
  summary: string
  detail: string | null
}

export type LogType =
  | 'connection'
  | 'error'
  | 'llm_call'
  | 'llm_thought'
  | 'tool_call'
  | 'tool_result'
  | 'server_message'
  | 'notification'
  | 'system'

export interface AgentStatus {
  profileId: string
  connected: boolean
  mode: 'llm' | 'manual'
  playerData?: Record<string, unknown>
  gameState?: Record<string, unknown> | null
}
