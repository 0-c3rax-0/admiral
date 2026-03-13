import type { Hono } from 'hono'
import stats from './server/routes/stats'
import map from './server/routes/map'
import oauth from './server/routes/oauth'
import economy from './server/routes/economy'
import fleet from './server/routes/fleet'
export {
  buildProfileResponse,
  handleProfileCommandSideEffects,
} from '../server/lib/profile-extensions'

export {
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
} from '../server/lib/agent-extensions'

export {
  buildImmediateRecoveryMessage,
  buildToolResultMessage,
  extractFallbackToolCalls,
  extractReasoningSummary,
  fingerprintResult,
  fingerprintToolCall,
  isStatusOnlyRound,
  shortenReasoning,
  updateAdvisorStallState,
  type AdvisorStallState,
} from '../server/lib/loop-extensions'

import { fleetSupervisor } from '../server/lib/supervisor'

export function registerServerForkRoutes(app: Hono): void {
  app.route('/api/stats', stats)
  app.route('/api/map', map)
  app.route('/api/oauth', oauth)
  app.route('/api/economy', economy)
  app.route('/api/fleet', fleet)
}

export function startServerForkServices(): void {
  fleetSupervisor.start()
}
