import type { CommandResult } from './interface'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

export function normalizeCommandResult(command: string, raw: CommandResult): CommandResult {
  const meta = extractCommandMeta(command, raw.result, raw.notifications)
  if (!meta) return raw
  return { ...raw, meta: { ...(raw.meta || {}), ...meta } }
}

function extractCommandMeta(command: string, result: unknown, notifications?: unknown[]): CommandResult['meta'] | undefined {
  const fromResult = extractFromObject(command, asRecord(result))
  const fromNotifications = extractFromNotifications(command, notifications)
  const merged = { ...(fromResult || {}), ...(fromNotifications || {}) }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function extractFromObject(command: string, record: Record<string, unknown> | null): CommandResult['meta'] | undefined {
  if (!record) return undefined
  const meta: NonNullable<CommandResult['meta']> = {}
  const effectiveCommand = toStringValue(record.command) || command

  if (record.pending === true) {
    meta.accepted = true
    meta.pending = true
    meta.command = effectiveCommand
  }

  const tick = toNumber(record.tick ?? record.current_tick)
  if (tick !== undefined) meta.tick = tick

  const ticks = toNumber(record.ticks ?? record.tick_count ?? record.ticks_remaining ?? record.travel_ticks)
  if (ticks !== undefined) meta.ticks = ticks

  const etaTick = toNumber(record.eta_tick ?? record.arrival_tick)
  if (etaTick !== undefined) meta.eta_tick = etaTick

  const distanceAu = toNumber(record.distance_au ?? record.au ?? record.distance)
  if (distanceAu !== undefined) meta.distance_au = distanceAu

  const destId = toStringValue(record.poi_id ?? record.target_poi ?? record.destination_id)
  if (destId) meta.destination_id = destId

  const destName = toStringValue(record.poi ?? record.destination_name ?? record.target_name)
  if (destName) meta.destination_name = destName

  if ((effectiveCommand === 'travel' || effectiveCommand === 'jump') && toStringValue(record.action) === 'arrived') {
    meta.arrived = true
    meta.command = effectiveCommand
  }

  return Object.keys(meta).length > 0 ? meta : undefined
}

function extractFromNotifications(command: string, notifications?: unknown[]): CommandResult['meta'] | undefined {
  if (!Array.isArray(notifications)) return undefined
  for (const item of notifications) {
    const notif = asRecord(item)
    const type = String(notif?.type || notif?.msg_type || '').toLowerCase()
    const payload = asRecord(notif?.payload ?? notif?.data)
    if (!payload) continue
    if (type !== 'action_result') continue
    const notifCommand = toStringValue(payload.command)
    if (notifCommand && notifCommand !== command) continue
    const result = asRecord(payload.result)
    const meta = extractFromObject(notifCommand || command, result)
    if (meta) {
      meta.command = notifCommand || command
      meta.tick = meta.tick ?? toNumber(payload.tick)
      meta.arrived = meta.arrived ?? (toStringValue(result?.action) === 'arrived')
      return meta
    }
  }
  return undefined
}
