export type RuntimeStatus = {
  connected: boolean
  running: boolean
  mutation_state?: 'idle' | 'mutation_pending' | 'navigation_pending' | 'local_stall'
  mutation_state_detail?: string | null
  navigation_state?: 'docked' | 'undocked' | 'at_resource_poi' | 'navigation_pending' | 'local_stall' | 'unknown'
  navigation_state_detail?: string | null
  adaptive_mode?: 'normal' | 'soft' | 'high' | 'critical'
  effective_context_budget_ratio?: number | null
  rate_risk?: {
    level: 'LOW' | 'MEDIUM' | 'HIGH'
    reason: string
    recommendation: string
    callsLast60s: number
    errors429Last60s: number
    errors429Last300s: number
    failoverActivationsLast300s: number
  } | null
}

const WEBSOCKET_STATUS_GRACE_MS = 15_000

export function buildRuntimeStatuses(
  data: Array<Record<string, unknown>>,
  lastConnectedAt: Record<string, number>,
): {
  statuses: Record<string, RuntimeStatus>
  playerData: Record<string, Record<string, unknown>>
  nextLastConnectedAt: Record<string, number>
} {
  const statuses: Record<string, RuntimeStatus> = {}
  const playerData: Record<string, Record<string, unknown>> = {}
  const nextLastConnectedAt = { ...lastConnectedAt }

  for (const profile of data) {
    const id = profile.id as string
    const rawConnected = !!profile.connected
    const connectionMode = typeof profile.connection_mode === 'string' ? profile.connection_mode : 'http'
    const isWebSocketMode = connectionMode === 'websocket' || connectionMode === 'websocket_v2'
    if (rawConnected) {
      nextLastConnectedAt[id] = Date.now()
    }
    const withinGrace = isWebSocketMode
      && !rawConnected
      && typeof nextLastConnectedAt[id] === 'number'
      && (Date.now() - nextLastConnectedAt[id]) < WEBSOCKET_STATUS_GRACE_MS

    statuses[id] = {
      connected: rawConnected || withinGrace,
      running: !!profile.running,
      adaptive_mode: (profile.adaptive_mode as RuntimeStatus['adaptive_mode']) || 'normal',
      mutation_state: (profile.mutation_state as RuntimeStatus['mutation_state']) || 'idle',
      mutation_state_detail: typeof profile.mutation_state_detail === 'string' ? profile.mutation_state_detail : null,
      navigation_state: (profile.navigation_state as RuntimeStatus['navigation_state']) || 'unknown',
      navigation_state_detail: typeof profile.navigation_state_detail === 'string' ? profile.navigation_state_detail : null,
      effective_context_budget_ratio: typeof profile.effective_context_budget_ratio === 'number'
        ? profile.effective_context_budget_ratio
        : null,
      rate_risk: (profile.rate_risk as RuntimeStatus['rate_risk']) || null,
    }

    if (profile.gameState && typeof profile.gameState === 'object') {
      playerData[id] = profile.gameState as Record<string, unknown>
    }
  }

  return { statuses, playerData, nextLastConnectedAt }
}

export function mergePlayerDataSnapshots(
  current: Record<string, Record<string, unknown>>,
  incoming: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const next = { ...current }
  for (const [id, snapshot] of Object.entries(incoming)) {
    const existing = next[id]
    const existingHasFullStatus = !!(existing && typeof existing === 'object' && 'player' in existing)
    const incomingHasFullStatus = !!(snapshot && typeof snapshot === 'object' && 'player' in snapshot)
    if (existingHasFullStatus && !incomingHasFullStatus) continue
    next[id] = snapshot
  }
  return next
}

export function extractSkills(data: unknown): Record<string, number> | null {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  const direct = record.skills
  const nested = record.result && typeof record.result === 'object'
    ? (record.result as Record<string, unknown>).skills
    : null
  const raw = direct && typeof direct === 'object' ? direct : nested && typeof nested === 'object' ? nested : null
  if (!raw) return null

  const skills = Object.entries(raw as Record<string, unknown>)
    .map(([skill, level]) => {
      const numericLevel = typeof level === 'object' && level && 'level' in level
        ? Number((level as Record<string, unknown>).level)
        : Number(level)
      return [skill, numericLevel] as const
    })
    .filter(([, level]) => Number.isFinite(level))
  if (skills.length === 0) return null
  return Object.fromEntries(skills)
}

export function formatSkillLabel(skill: string): string {
  return skill
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

export function mergeSkillsIntoPlayerData(
  existing: Record<string, unknown> | undefined,
  skills: Record<string, number>
): Record<string, unknown> {
  return {
    ...(existing || {}),
    skills: {
      ...((((existing || {}).skills) && typeof (existing || {}).skills === 'object')
        ? ((existing || {}).skills as Record<string, unknown>)
        : {}),
      ...skills,
    },
  }
}
