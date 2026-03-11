import { addTradeEvent } from './economy-db'
import { isDockedPoi, isResourcePoi } from './poi'

export type MutationState = 'idle' | 'mutation_pending' | 'navigation_pending' | 'local_stall'
export type NavigationState = 'docked' | 'undocked' | 'at_resource_poi' | 'navigation_pending' | 'local_stall' | 'unknown'

export function formatNotificationSummary(n: unknown): string {
  if (typeof n === 'string') return n
  if (typeof n !== 'object' || n === null) return JSON.stringify(n)

  const notif = n as Record<string, unknown>
  const type = (notif.type as string) || (notif.msg_type as string) || 'event'
  let data = getNotificationBody(notif)
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch { /* leave as string */ }
  }

  if (data && typeof data === 'object') {
    const msg = (data.message as string) || (data.content as string)
    if (msg) return `[${type.toUpperCase()}] ${msg}`
  }

  return `[${type.toUpperCase()}] ${JSON.stringify(n).slice(0, 200)}`
}

export function shouldForceStateRefreshFromNotifications(notifications: unknown[]): boolean {
  return notifications.some((n) => {
    const parsed = parseNotificationMeta(n)
    if (!parsed) return false
    return isRecoveryRelevantNotification(parsed)
  })
}

export function buildMutationStallNudge(
  pendingMutationObserved: boolean,
  loopsSincePendingMutation: number,
  loopsSinceActionResult: number,
  gameState: Record<string, unknown> | null,
  threshold: number,
): string | null {
  if (!pendingMutationObserved) return null
  if (loopsSincePendingMutation < threshold) return null

  return [
    '## Mutation Stall Recovery',
    `A previous mutation has remained unresolved for ${loopsSincePendingMutation} verification cycles without an ACTION_RESULT notification.`,
    'Do not label this a global deadlock or server freeze.',
    'Assume the evidence is still local and incomplete unless multiple independent observations prove otherwise.',
    'Remember that jump and travel now legitimately take multiple ticks based on ship speed and distance. Navigation delay alone is not enough to diagnose a stall.',
    'Stop passive monitoring loops. Try an active recovery plan based on the verified state below.',
    'Recovery priority order:',
    '1. Refresh with get_status if you need a newer snapshot.',
    '2. If the unresolved action was jump or travel, first consider whether the ship may still be in transit under the new multi-tick navigation rules.',
    '3. Prefer get_location to inspect transit destination and arrival tick while moving.',
    '4. Check whether the intended effect already happened.',
    '5. If docked/undocked state is unclear, use get_status and then a single corrected dock or undock.',
    '6. If the state looks stable but still seems stuck, test exactly one simple low-risk mutation that matches the verified state before declaring continued stall.',
    `7. Recommended probe from current state: ${describeRecoveryProbe(gameState)}`,
    '8. If travel is blocked, verify fuel, current POI, system, route feasibility, and current ship speed before choosing a different reachable action.',
    '9. Prefer productive local actions or information gathering over repeating the same mutation or declaring a freeze.',
    `Current unresolved-action evidence age: ${loopsSinceActionResult} cycles since last ACTION_RESULT.`,
    'Verified current state:',
    formatVerifiedGameState(gameState),
  ].join('\n\n')
}

export function buildMutationStateNudge(
  mutationState: MutationState,
  detail: string | null,
  gameState: Record<string, unknown> | null,
): string | null {
  if (mutationState === 'idle') return null
  return [
    '## Mutation State',
    `Current mutation state: ${mutationState}`,
    detail ? `Detail: ${detail}` : '',
    'Use this label exactly when reasoning about the current situation. Do not escalate it to a global server-wide deadlock claim unless separate evidence proves that.',
    'Verified current state:',
    formatVerifiedGameState(gameState),
  ].filter(Boolean).join('\n\n')
}

export function buildNavigationStateNudge(
  navigationState: NavigationState,
  detail: string | null,
  gameState: Record<string, unknown> | null,
): string | null {
  if (navigationState === 'unknown') return null
  const transitGuidance = navigationState === 'navigation_pending'
    ? buildTransitWaitGuidance(gameState)
    : null
  return [
    '## Navigation State',
    `Current navigation state: ${navigationState}`,
    detail ? `Detail: ${detail}` : '',
    'This is a derived planning hint from recent state, not a perfect guarantee.',
    'Use it to form a hypothesis, then verify with fresh get_status before major navigation, docking, or mining choices if the situation is unclear.',
    'Typical interpretation: docked => sell/refuel/upgrade, undocked => travel or mine, at_resource_poi => mine or leave, navigation_pending => the ship may still be traveling/jumping; prefer get_location plus get_status before treating it as blocked.',
    transitGuidance || '',
    'Verified current state:',
    formatVerifiedGameState(gameState),
  ].filter(Boolean).join('\n\n')
}

export function buildLocalMutationStuckSummary(
  loopsSincePendingMutation: number,
  loopsSinceActionResult: number,
  gameState: Record<string, unknown> | null,
  threshold: number,
): string | null {
  if (loopsSincePendingMutation < threshold) return null

  return [
    '[local-stall] Account-specific mutation stall detected.',
    `Pending mutation unresolved for ${loopsSincePendingMutation} verification cycles.`,
    `No ACTION_RESULT observed for ${loopsSinceActionResult} cycles.`,
    'Treat this as a local account/session problem unless other accounts show the same evidence.',
    `Next recovery probe should be: ${describeRecoveryProbe(gameState)}.`,
    formatVerifiedGameState(gameState),
  ].join(' ')
}

export function buildRecoveryNudge(notifications: unknown[], gameState: Record<string, unknown> | null): string {
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

export function formatVerifiedGameState(gameState: Record<string, unknown> | null): string {
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
  const navigationState = deriveNavigationState(gameState)
  const navigationDetail = describeNavigationState(gameState, navigationState, null)
  const transitSummary = describeTransitState(gameState)

  return [
    `- Location: ${systemName} / ${poiName}`,
    `- Navigation state: ${navigationState}${navigationDetail ? ` (${navigationDetail})` : ''}`,
    transitSummary ? `- Transit: ${transitSummary}` : '',
    `- Credits: ${credits}`,
    `- Ship: ${shipName}`,
    `- Cargo: ${cargoUsed}/${cargoCapacity}`,
    `- Fuel: ${fuel}/${maxFuel}`,
    `- Hull: ${hull}/${maxHull}`,
  ].join('\n')
}

export function deriveNavigationState(gameState: Record<string, unknown> | null): NavigationState {
  if (!gameState) return 'unknown'
  const player = (gameState.player as Record<string, unknown> | undefined) || {}
  const location = (gameState.location as Record<string, unknown> | undefined) || {}
  if (isTransitState(gameState)) return 'navigation_pending'
  const poiType = location.poi_type || player.current_poi_type
  const poiName = location.poi_name || player.current_poi

  if (isDockedPoi(poiType, poiName)) return 'docked'
  if (isResourcePoi(poiType, poiName)) return 'at_resource_poi'
  if (String(poiName || '').trim() || String(poiType || '').trim()) return 'undocked'
  return 'unknown'
}

export function describeNavigationState(
  gameState: Record<string, unknown> | null,
  navigationState: NavigationState,
  overrideDetail: string | null,
): string | null {
  if (overrideDetail) return overrideDetail
  if (!gameState) return null
  const player = (gameState.player as Record<string, unknown> | undefined) || {}
  const location = (gameState.location as Record<string, unknown> | undefined) || {}
  const systemName = stringifyStateValue(player.current_system ?? location.system_name) || '?'
  const poiName = stringifyStateValue(player.current_poi ?? location.poi_name) || '?'

  switch (navigationState) {
    case 'navigation_pending':
      return describeTransitState(gameState) || 'navigation mutation accepted; ship may still be in transit'
    case 'docked':
      return `currently at base/station in ${systemName} / ${poiName}`
    case 'at_resource_poi':
      return `currently at likely mining POI in ${systemName} / ${poiName}`
    case 'undocked':
      return `currently in space at ${systemName} / ${poiName}`
    default:
      return null
  }
}

export function isActionResultNotification(n: unknown): boolean {
  const parsed = parseNotificationMeta(n)
  return parsed?.type.toUpperCase() === 'ACTION_RESULT'
}

export function isPendingMutationNotification(n: unknown): boolean {
  const parsed = parseNotificationMeta(n)
  if (!parsed) return false
  const type = parsed.type.toUpperCase()
  const message = parsed.message.toLowerCase()
  return type === 'PENDING_ACTION' || (type === 'OK' && message.includes('"pending":true'))
}

export function isReconnectNotification(n: unknown): boolean {
  const parsed = parseNotificationMeta(n)
  return parsed?.type.toLowerCase() === 'reconnected'
}

export function formatReconnectDetail(n: unknown): string | null {
  if (typeof n !== 'object' || n === null) return null
  const notif = n as Record<string, unknown>
  const body = getNotificationBody(notif)
  if (!body || typeof body !== 'object') return null

  const payload = body as Record<string, unknown>
  const details: string[] = []
  if (typeof payload.message === 'string' && payload.message.trim()) {
    details.push(payload.message.trim())
  }
  if (typeof payload.was_pilotless === 'boolean') {
    details.push(`was_pilotless=${payload.was_pilotless}`)
  }
  const ticksRemaining = toFiniteNumber(payload.ticks_remaining)
  if (ticksRemaining !== null) {
    details.push(`ticks_remaining=${ticksRemaining}`)
  }

  return details.length > 0 ? details.join(' | ') : null
}

export function ingestTradeNotification(profileId: string, notification: unknown, gameState: Record<string, unknown> | null): void {
  if (!notification || typeof notification !== 'object') return
  const record = notification as Record<string, unknown>
  const type = String(record.type || record.msg_type || '').toLowerCase()
  if (type !== 'action_result') return

  const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : null
  const command = String(payload?.command || '').toLowerCase()
  if (command !== 'buy' && command !== 'sell') return

  const result = payload?.result && typeof payload.result === 'object' ? payload.result as Record<string, unknown> : null
  if (!result) return

  const quantity = toFiniteNumber(result.quantity_sold ?? result.quantity_bought ?? result.quantity ?? result.filled_quantity ?? result.amount)
  if (quantity === null || quantity <= 0) return

  const itemName = String(result.item ?? result.item_name ?? result.name ?? result.item_id ?? '').trim()
  if (!itemName) return

  const unitPrice = toFiniteNumber(result.price_each ?? result.unit_price ?? result.price ?? result.executed_price)
  const totalPrice = toFiniteNumber(result.total_earned ?? result.total_spent ?? result.total_price)

  addTradeEvent({
    profile_id: profileId,
    trade_type: command as 'buy' | 'sell',
    item_id: typeof result.item_id === 'string' ? result.item_id : null,
    item_name: itemName,
    quantity,
    unit_price: unitPrice,
    total_price: totalPrice ?? (unitPrice !== null ? unitPrice * quantity : null),
    system_name: extractGameStateLocation(gameState, 'system'),
    poi_name: extractGameStateLocation(gameState, 'poi'),
    source_command: command,
    raw_json: JSON.stringify(notification),
  })
}

function isRecoveryRelevantNotification(parsed: { type: string; message: string }): boolean {
  const type = parsed.type.toUpperCase()
  const message = parsed.message.toLowerCase()

  if (type === 'ACTION_ERROR' && (
    message.includes('not_docked') ||
    message.includes('already_docked') ||
    message.includes('already_in_system') ||
    message.includes('cargo_full') ||
    message.includes('no_resources') ||
    message.includes('no_equipment') ||
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

function stringifyStateValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function describeRecoveryProbe(gameState: Record<string, unknown> | null): string {
  const navigationState = deriveNavigationState(gameState)
  switch (navigationState) {
    case 'docked':
      return 'prefer exactly one undock() if your plan requires leaving the station, or exactly one sell/refuel only if that is the intended next step'
    case 'at_resource_poi':
      return 'prefer exactly one dock() if a station/base is reachable from here, otherwise exactly one mine() if cargo space exists and mining is the intended next step'
    case 'undocked':
      return 'prefer exactly one dock() if you are already at a base/station, otherwise exactly one travel() to a clearly valid nearby destination'
    case 'navigation_pending':
      return 'do not stack more navigation; inspect transit ETA with get_location if needed, wait until arrival tick or a fresh arrival signal, then verify with get_status before sending at most one corrected follow-up action'
    case 'local_stall':
      return 'refresh with get_status, then send at most one simple mutation consistent with the verified state instead of repeating passive stall messages'
    default:
      return 'refresh with get_status, pick one simple mutation consistent with the verified state, and test it exactly once'
  }
}

function buildTransitWaitGuidance(gameState: Record<string, unknown> | null): string | null {
  const transit = extractTransitInfo(gameState)
  if (!transit) {
    return 'If this pending state comes from travel or jump, prefer waiting for the queued arrival instead of sending another navigation mutation. Use get_location sparingly to confirm transit progress.'
  }

  const parts = [
    'Transit handling:',
    `- Current transit type: ${transit.type || 'navigation'}`,
    transit.destination ? `- Destination: ${transit.destination}` : '',
    transit.ticksRemaining !== null ? `- Ticks remaining: ${transit.ticksRemaining}` : '',
    transit.arrivalTick !== null ? `- Arrival tick: ${transit.arrivalTick}` : '',
    '- Treat this as progress. Do not send another travel/jump while this remains active.',
    '- Prefer waiting until the arrival tick or a fresh arrival/result notification before re-planning.',
    '- If you need one verification query while waiting, prefer get_location first. Use get_cargo instead when the only open question is whether mining changed cargo. Reserve get_status for broader reconciliation after arrival or when the evidence conflicts.',
  ]
  return parts.filter(Boolean).join('\n')
}

function describeTransitState(gameState: Record<string, unknown> | null): string | null {
  const transit = extractTransitInfo(gameState)
  if (!transit) return null
  const parts = [
    transit.type ? `${transit.type} in progress` : 'transit in progress',
    transit.destination ? `to ${transit.destination}` : '',
    transit.ticksRemaining !== null ? `${transit.ticksRemaining} ticks remaining` : '',
    transit.arrivalTick !== null ? `arrival tick ${transit.arrivalTick}` : '',
  ]
  return parts.filter(Boolean).join(', ')
}

function isTransitState(gameState: Record<string, unknown> | null): boolean {
  return extractTransitInfo(gameState) !== null
}

function extractTransitInfo(gameState: Record<string, unknown> | null): {
  type: string | null
  destination: string | null
  ticksRemaining: number | null
  arrivalTick: number | null
} | null {
  if (!gameState) return null
  const location = (gameState.location as Record<string, unknown> | undefined) || {}
  const data = gameState
  const type = stringifyStateValue(location.transit_type ?? data.transit_type) || null
  const inTransit =
    location.in_transit === true ||
    data.in_transit === true ||
    Boolean(type)

  if (!inTransit) return null

  const destination = stringifyStateValue(
    location.transit_dest_system_name ??
    location.transit_dest_system_id ??
    location.destination_name ??
    location.destination_id ??
    data.transit_dest_system_name ??
    data.transit_dest_system_id ??
    data.destination_name ??
    data.destination_id,
  ) || null

  return {
    type,
    destination,
    ticksRemaining: toFiniteNumber(location.ticks_remaining ?? data.ticks_remaining),
    arrivalTick: toFiniteNumber(location.transit_arrival_tick ?? data.transit_arrival_tick ?? location.arrival_tick ?? data.arrival_tick),
  }
}

function parseNotificationMeta(n: unknown): { type: string; message: string } | null {
  if (typeof n !== 'object' || n === null) return null

  const notif = n as Record<string, unknown>
  const type = String((notif.type as string) || (notif.msg_type as string) || 'event')
  let data = getNotificationBody(notif)
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

function getNotificationBody(notif: Record<string, unknown>): Record<string, unknown> | string | undefined {
  return notif.payload as Record<string, unknown> | string | undefined
    ?? notif.data as Record<string, unknown> | string | undefined
}

function extractGameStateLocation(gameState: Record<string, unknown> | null, type: 'system' | 'poi'): string | null {
  const player = gameState?.player && typeof gameState.player === 'object' ? gameState.player as Record<string, unknown> : null
  const location = gameState?.location && typeof gameState.location === 'object' ? gameState.location as Record<string, unknown> : null
  if (type === 'system') {
    const value = player?.current_system ?? location?.system_name
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }
  const value = player?.current_poi ?? location?.poi_name
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
