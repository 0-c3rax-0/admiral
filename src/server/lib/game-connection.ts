import type { Profile } from '../../shared/types'
import type { GameConnection } from './connections/interface'
import { HttpConnection } from './connections/http'
import { HttpV2Connection } from './connections/http_v2'
import { WebSocketConnection } from './connections/websocket'
import { WebSocketV2Connection } from './connections/websocket_v2'
import { McpConnection } from './connections/mcp'
import { McpV2Connection } from './connections/mcp_v2'
import { BrokerWebSocketV2Connection } from './broker-client'

export function createGameConnection(profile: Profile): GameConnection {
  switch (profile.connection_mode) {
    case 'websocket':
      return new WebSocketConnection(profile.server_url)
    case 'websocket_v2':
      return process.env.ADMIRAL_DISABLE_BROKER === 'true'
        ? new WebSocketV2Connection(profile.server_url)
        : new BrokerWebSocketV2Connection(profile.id, profile.server_url)
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
