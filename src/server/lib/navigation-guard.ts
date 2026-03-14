import type { CommandResult } from './connections/interface'
import { clearPendingMutation, getPendingMutation, setPendingMutation } from './db'

type PendingNavigation = {
  command: 'travel' | 'jump'
  destination?: string
  createdAtMs: number
  etaTick?: number
}

const pendingByProfile = new Map<string, PendingNavigation>()
const STALE_PENDING_WITHOUT_DESTINATION_MS = 15_000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function normalizeValue(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/\s+/g, '_')
    : ''
}

function pickFirstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function matchesDestination(destination: string | undefined, ...candidates: unknown[]): boolean {
  const normalizedDestination = normalizeValue(destination)
  if (!normalizedDestination) return false
  return candidates.some((candidate) => normalizeValue(candidate) === normalizedDestination)
}

export function getPendingNavigation(profileId: string): PendingNavigation | null {
  const inMemory = pendingByProfile.get(profileId)
  if (inMemory) return inMemory
  const persisted = getPendingMutation(profileId)
  if (!persisted) return null
  const restored: PendingNavigation = {
    command: persisted.command as 'travel' | 'jump',
    destination: persisted.destination || undefined,
    createdAtMs: Date.parse(persisted.updated_at || persisted.created_at || '') || Date.now(),
  }
  pendingByProfile.set(profileId, restored)
  return restored
}

export function clearPendingNavigation(profileId: string): void {
  pendingByProfile.delete(profileId)
  clearPendingMutation(profileId)
}

export function updatePendingNavigationFromResult(profileId: string, command: string, args: Record<string, unknown>, result: CommandResult): void {
  if (command !== 'travel' && command !== 'jump') return

  if (result.meta?.arrived) {
    clearPendingNavigation(profileId)
    return
  }

  if (result.meta?.pending) {
    const pending: PendingNavigation = {
      command: command as 'travel' | 'jump',
      destination: resolveDestination(command, args),
      createdAtMs: Date.now(),
      etaTick: result.meta?.eta_tick,
    }
    pendingByProfile.set(profileId, pending)
    setPendingMutation(profileId, pending.command, pending.destination)
  }
}

export function updatePendingNavigationFromNotification(profileId: string, notification: unknown): void {
  const notif = asRecord(notification)
  const type = String(notif?.type || notif?.msg_type || '').toLowerCase()
  const pending = getPendingNavigation(profileId)
  if (!pending) return

  const payload = asRecord(notif?.payload ?? notif?.data)
  const command = String(payload?.command || '')

  if (type === 'action_result' || type === 'action_error') {
    if (command !== 'travel' && command !== 'jump') return
    clearPendingNavigation(profileId)
    return
  }

  if (type !== 'ok' || !payload) return

  if (
    pending.command === 'jump' &&
    normalizeValue(payload.action) === 'jumped' &&
    matchesDestination(
      pending.destination,
      payload.system_id,
      payload.destination,
      payload.system,
    )
  ) {
    clearPendingNavigation(profileId)
    return
  }

  if (
    pending.command === 'travel' &&
    matchesDestination(
      pending.destination,
      payload.poi_id,
      payload.destination_id,
      payload.poi,
      payload.destination_name,
    )
  ) {
    clearPendingNavigation(profileId)
  }
}

export function reconcilePendingNavigationWithStatus(profileId: string, result: CommandResult): void {
  const pending = getPendingNavigation(profileId)
  if (!pending) return

  const data = asRecord(result.structuredContent ?? result.result)
  if (!data) return

  const queue = asRecord(data.queue)
  if (queue?.has_pending === false) {
    clearPendingNavigation(profileId)
    return
  }

  const player = asRecord(data.player)
  const location = asRecord(data.location)
  const systemId = pickFirstString(location?.system_id, player?.current_system_id)
  const systemName = pickFirstString(location?.system_name, player?.current_system)
  const poiId = pickFirstString(location?.poi_id, player?.current_poi_id)
  const poiName = pickFirstString(location?.poi_name, player?.current_poi)
  const inTransit = Boolean(
    location?.in_transit === true ||
    data.in_transit === true ||
    pickFirstString(location?.transit_type, data.transit_type),
  )

  if (pending.command === 'jump' && matchesDestination(pending.destination, systemId, systemName)) {
    clearPendingNavigation(profileId)
    return
  }

  if (pending.command === 'travel' && matchesDestination(pending.destination, poiId, poiName)) {
    clearPendingNavigation(profileId)
    return
  }

  // If a nav mutation was persisted without a target and the ship is clearly not
  // in transit anymore, do not let that orphaned pending flag block the agent forever.
  if (!pending.destination && !inTransit && Date.now() - pending.createdAtMs >= STALE_PENDING_WITHOUT_DESTINATION_MS) {
    clearPendingNavigation(profileId)
  }
}

function resolveDestination(command: string, args: Record<string, unknown>): string | undefined {
  if (command === 'travel') {
    const value = args.target_poi ?? args.poi_id ?? args.destination_id ?? args.poi ?? args.target ?? args.id ?? args.text
    return typeof value === 'string' && value.trim() ? value : undefined
  }
  if (command === 'jump') {
    const value = args.target_system ?? args.system_id ?? args.destination_system ?? args.system ?? args.target ?? args.id ?? args.text
    return typeof value === 'string' && value.trim() ? value : undefined
  }
  return undefined
}
