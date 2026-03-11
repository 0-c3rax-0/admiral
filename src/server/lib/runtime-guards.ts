type ZeroFillEntry = {
  expiresAt: number
}

type MarketSnapshotEntry = {
  expiresAt: number
  bestBid: number | null
  bestAsk: number | null
  bidVolume: number | null
  askVolume: number | null
}

type PendingBudgetState = {
  lastPendingSeenAt: number
  lastVerificationAt: number
  verificationCommands: Set<string>
  lastVerificationCommand: string | null
}

type ProfileRuntimeState = {
  zeroFillSellByKey: Map<string, ZeroFillEntry>
  marketByLocationAndItem: Map<string, MarketSnapshotEntry>
  pendingBudget: PendingBudgetState | null
  blockedCommands: Map<string, number>
}

const ZERO_FILL_TTL_MS = 15 * 60_000
const MARKET_SNAPSHOT_TTL_MS = 10 * 60_000
const UNKNOWN_COMMAND_TTL_MS = 30 * 60_000
const PENDING_VERIFY_COOLDOWN_MS = 8_000
const MAX_PENDING_VERIFICATIONS = 2

const stateByProfile = new Map<string, ProfileRuntimeState>()

function getState(profileId: string): ProfileRuntimeState {
  let state = stateByProfile.get(profileId)
  if (!state) {
    state = {
      zeroFillSellByKey: new Map(),
      marketByLocationAndItem: new Map(),
      pendingBudget: null,
      blockedCommands: new Map(),
    }
    stateByProfile.set(profileId, state)
  }
  return state
}

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function rememberUnknownCommand(profileId: string, command: string): void {
  if (!command.trim()) return
  getState(profileId).blockedCommands.set(normalize(command), Date.now() + UNKNOWN_COMMAND_TTL_MS)
}

export function isCommandTemporarilyBlocked(profileId: string, command: string): boolean {
  const expiresAt = getState(profileId).blockedCommands.get(normalize(command))
  if (!expiresAt) return false
  if (expiresAt <= Date.now()) {
    getState(profileId).blockedCommands.delete(normalize(command))
    return false
  }
  return true
}

export function rememberZeroFillSell(profileId: string, itemId: string, locationKey: string): void {
  getState(profileId).zeroFillSellByKey.set(`${normalize(locationKey)}|${normalize(itemId)}`, {
    expiresAt: Date.now() + ZERO_FILL_TTL_MS,
  })
}

export function shouldBlockZeroFillSell(profileId: string, itemId: string, locationKey: string): boolean {
  const key = `${normalize(locationKey)}|${normalize(itemId)}`
  const entry = getState(profileId).zeroFillSellByKey.get(key)
  if (!entry) return false
  if (entry.expiresAt <= Date.now()) {
    getState(profileId).zeroFillSellByKey.delete(key)
    return false
  }
  return true
}

export function rememberMarketSnapshot(
  profileId: string,
  locationKey: string,
  itemId: string,
  snapshot: { bestBid: number | null; bestAsk: number | null; bidVolume: number | null; askVolume: number | null },
): void {
  getState(profileId).marketByLocationAndItem.set(`${normalize(locationKey)}|${normalize(itemId)}`, {
    expiresAt: Date.now() + MARKET_SNAPSHOT_TTL_MS,
    ...snapshot,
  })
}

export function getMarketSnapshot(
  profileId: string,
  locationKey: string,
  itemId: string,
): MarketSnapshotEntry | null {
  const key = `${normalize(locationKey)}|${normalize(itemId)}`
  const entry = getState(profileId).marketByLocationAndItem.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    getState(profileId).marketByLocationAndItem.delete(key)
    return null
  }
  return entry
}

export function markPendingMutationSeen(profileId: string): void {
  const state = getState(profileId)
  state.pendingBudget = {
    lastPendingSeenAt: Date.now(),
    lastVerificationAt: 0,
    verificationCommands: new Set(),
    lastVerificationCommand: null,
  }
}

export function clearPendingMutationSeen(profileId: string): void {
  getState(profileId).pendingBudget = null
}

export function shouldThrottlePendingVerification(profileId: string, command: string): boolean {
  const normalized = normalize(command)
  if (normalized !== 'get_status' && normalized !== 'get_location') return false
  const budget = getState(profileId).pendingBudget
  if (!budget) return false
  if (budget.lastVerificationCommand === normalized && Date.now() - budget.lastVerificationAt < PENDING_VERIFY_COOLDOWN_MS) {
    return true
  }
  if (budget.verificationCommands.has(normalized)) return false
  return budget.verificationCommands.size >= MAX_PENDING_VERIFICATIONS
}

export function notePendingVerification(profileId: string, command: string): void {
  const normalized = normalize(command)
  if (normalized !== 'get_status' && normalized !== 'get_location') return
  const budget = getState(profileId).pendingBudget
  if (!budget) return
  budget.lastVerificationAt = Date.now()
  budget.verificationCommands.add(normalized)
  budget.lastVerificationCommand = normalized
}

export function ingestRuntimeNotification(profileId: string, notification: unknown): void {
  if (!notification || typeof notification !== 'object') return
  const record = notification as Record<string, unknown>
  const type = normalize(record.type || record.msg_type)
  const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : null

  if (type === 'action_result') {
    const command = normalize(payload?.command)
    if (!payload) return
    clearPendingMutationSeen(profileId)
    if (command === 'sell') {
      const quantitySold = Number(payload.result && typeof payload.result === 'object' ? (payload.result as Record<string, unknown>).quantity_sold ?? 0 : 0)
      const itemId = payload.result && typeof payload.result === 'object' ? String((payload.result as Record<string, unknown>).item_id ?? '') : ''
      const locationKey = payload.result && typeof payload.result === 'object'
        ? String((payload.result as Record<string, unknown>).base ?? (payload.result as Record<string, unknown>).station ?? '')
        : ''
      if (quantitySold === 0 && itemId && locationKey) {
        rememberZeroFillSell(profileId, itemId, locationKey)
      }
    }
    return
  }

  if (type === 'action_error') {
    clearPendingMutationSeen(profileId)
  }
}
