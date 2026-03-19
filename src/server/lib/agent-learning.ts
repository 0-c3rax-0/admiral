import fs from 'fs'
import path from 'path'
import type { CommandResult } from './connections/interface'
import { getProfile, getProfileSkills, upsertProfileSkills } from './db'
import { isDockedPoi, resolvePoiSnapshot } from './poi'

const AGENTS_DIR = path.join(process.cwd(), 'data', 'agents')
const MAX_EPISODES = 60
const MAX_FAILURES = 40
const MAX_RULES = 24
const QUERY_COMMANDS = new Set([
  'get_status', 'get_location', 'get_system', 'get_poi', 'get_cargo', 'get_ship', 'get_skills',
  'get_missions', 'get_active_missions', 'get_nearby', 'get_action_log', 'view_market', 'analyze_market',
  'estimate_purchase', 'catalog', 'browse_ships', 'list_ships', 'quote', 'wrecks', 'forum_list', 'forum_get_thread',
  'captains_log_list', 'captains_log_get', 'social_captains_log_list', 'social_captains_log_get',
  'get_commands', 'get_base', 'view_orders', 'search_systems', 'find_route', 'storage_view', 'salvage_quote',
  'fleet_status', 'get_chat_history',
])
const MUTATION_COMMANDS = new Set([
  'undock', 'travel', 'jump', 'dock', 'mine', 'sell', 'refuel', 'repair', 'craft', 'install_mod', 'accept_mission',
  'complete_mission', 'create_sell_order', 'cancel_order', 'modify_order', 'buy_listed_ship', 'commission_ship', 'switch_ship',
  'insure', 'loot', 'salvage', 'join', 'chat', 'captains_log_add', 'social_chat', 'social_captains_log_add', 'buy',
  'storage_deposit', 'storage_withdraw', 'market_create_sell_order', 'market_create_buy_order',
  'faction_commerce_create_sell_order', 'faction_commerce_create_buy_order',
  'fleet_create', 'fleet_accept', 'fleet_decline', 'fleet_invite', 'fleet_join', 'fleet_leave', 'fleet_kick', 'fleet_disband',
  'use_item', 'transfer',
])

export interface AgentIdentity {
  version: 1
  role: string
  temperament: string
  priorities: {
    profit: number
    survival: number
    exploration: number
    social: number
  }
  constraints: string[]
  development_focus: string[]
}

export const AGENT_ROLES = [
  'miner',
  'trader',
  'scout',
  'pirate',
  'industrialist',
  'generalist',
] as const

export type AgentRole = typeof AGENT_ROLES[number]

interface Episode {
  id: string
  kind: string
  summary: string
  confidence: number
  reward?: number
  ts: string
}

interface SemanticRule {
  rule: string
  confidence: number
  confirmations: number
  last_confirmed_at: string
}

interface FailurePattern {
  pattern: string
  countermeasure: string
  count: number
  last_seen_at: string
}

interface StatusSnapshot {
  ts: string
  credits: number | null
  ore_mined: number | null
  trades_completed: number | null
  systems_explored: number | null
  current_system: string | null
  current_poi: string | null
  docked: boolean | null
  cargo_used: number | null
  cargo_capacity: number | null
}

interface StorageItemSnapshot {
  item_id: string
  quantity: number | null
}

interface StorageSnapshot {
  ts: string
  station_id: string | null
  station_name: string | null
  wallet_credits: number | null
  storage_credits: number | null
  items: StorageItemSnapshot[]
}

interface LastActionSnapshot {
  command: string
  args?: Record<string, unknown>
  success: boolean
  ts: string
  error_code?: string
}

interface DecisionTelemetry {
  query_streak: number
  same_query_streak: number
  no_progress_streak: number
  last_query_command: string | null
  last_progress_at: string | null
  last_query_at: string | null
  last_mutation_at: string | null
}

export interface DecisionPressureSnapshot {
  queryStreak: number
  sameQueryStreak: number
  noProgressStreak: number
  lastQueryCommand: string | null
  recommendation: string | null
}

export interface StructuredAgentMemory {
  version: 1
  episodic: Episode[]
  semantic: SemanticRule[]
  failures: FailurePattern[]
  last_status: StatusSnapshot | null
  last_storage: StorageSnapshot | null
  last_action: LastActionSnapshot | null
  decision: DecisionTelemetry
}

interface RolePreset {
  temperament: string
  priorities: AgentIdentity['priorities']
  constraints: string[]
  development_focus: string[]
  playstyle: string[]
}

const ROLE_PRESETS: Record<AgentRole, RolePreset> = {
  miner: {
    temperament: 'cautious',
    priorities: { profit: 0.9, survival: 0.8, exploration: 0.2, social: 0.15 },
    constraints: [
      'Favor stable mining loops over speculative detours.',
      'Unload or sell before cargo becomes critically full.',
      'Match the mining target to the installed mining equipment: ore miners to asteroid belts, ice harvesters to ice fields, gas harvesters to gas clouds.',
    ],
    development_focus: ['mining_efficiency', 'inventory_discipline', 'route_planning', 'decision_efficiency'],
    playstyle: [
      'Prefer mining belts and reliable unload stations.',
      'Do not travel to a resource node that the current loadout cannot actually mine.',
      'Optimize credits per tick through steady extraction and clean sell cycles.',
      'If undocked with an ore fit and cargo below 15%, prefer returning to a known compatible ore belt and restarting the mining loop.',
      'If already at a compatible ore belt and cargo is below 95%, keep mining unless the location is depleted, yields collapse, cargo is full, or the fit does not match the node.',
      'If cargo reaches roughly 95%, return to a known unload station, dock, refuel when needed, unload, and only craft items when a supported crafting action is actually available and worthwhile before leaving again.',
    ],
  },
  trader: {
    temperament: 'opportunistic',
    priorities: { profit: 0.95, survival: 0.7, exploration: 0.25, social: 0.35 },
    constraints: [
      'Avoid bad instant sells when orderbook quality is poor.',
      'Check market conditions before committing cargo or route changes.',
    ],
    development_focus: ['market_timing', 'inventory_discipline', 'mission_selection', 'query_discipline'],
    playstyle: [
      'Prefer stations, market reads, and profitable sell/buy timing.',
      'Treat cargo as inventory capital, not something to dump blindly.',
      'When docked with cargo above 15%, process it before leaving again: refuel when needed, unload, only craft items when a supported crafting action is actually available and worthwhile, then choose direct sell versus sell order based on stack size and liquidity.',
      'Prefer direct sell for small stacks or strong buy-side liquidity; prefer create_sell_order for larger stacks or better delayed execution once a configurable quantity or value threshold is reached.',
    ],
  },
  scout: {
    temperament: 'curious',
    priorities: { profit: 0.45, survival: 0.75, exploration: 0.95, social: 0.25 },
    constraints: [
      'Do not start long routes without fuel validation.',
      'Prioritize discovering systems and routes over local grinding.',
    ],
    development_focus: ['route_planning', 'risk_management', 'mission_selection', 'decision_efficiency'],
    playstyle: [
      'Prefer movement, mapping, and discovery of new systems.',
      'Use travel as the main source of progress rather than staying in one loop.',
    ],
  },
  pirate: {
    temperament: 'aggressive',
    priorities: { profit: 0.8, survival: 0.55, exploration: 0.35, social: 0.2 },
    constraints: [
      'Avoid reckless losses when damaged, stranded, or outmatched.',
      'Treat survival and escape options as valid parts of aggression.',
    ],
    development_focus: ['risk_management', 'route_planning', 'mission_selection', 'decision_efficiency'],
    playstyle: [
      'Prefer high-value disruptive opportunities over routine grinding.',
      'Stay opportunistic, but do not self-destruct the account with bad risk control.',
    ],
  },
  industrialist: {
    temperament: 'methodical',
    priorities: { profit: 0.85, survival: 0.8, exploration: 0.2, social: 0.2 },
    constraints: [
      'Prefer production chains with measurable margin.',
      'Check recipe and market viability before crafting or other recipe-based processing.',
    ],
    development_focus: ['market_timing', 'inventory_discipline', 'crafting_efficiency', 'query_discipline'],
    playstyle: [
      'Prefer recipe-based processing, crafting, and ship/equipment progression.',
      'Think in value chains instead of only raw ore liquidation. Refining ore (e.g., Iron to Steel Plates) and listing it via create_sell_order yields much higher profits.',
      'When docked with cargo above 15%, process it before leaving again: refuel when needed, unload, only craft items when a supported crafting action is actually available and worthwhile, then sell or list based on stack size, fees, and liquidity.',
    ],
  },
  generalist: {
    temperament: 'balanced',
    priorities: { profit: 0.75, survival: 0.75, exploration: 0.45, social: 0.2 },
    constraints: [
      'Do not over-commit to one activity when another clearly outperforms it.',
    ],
    development_focus: ['route_planning', 'market_timing', 'risk_management', 'decision_efficiency'],
    playstyle: [
      'Blend mining, travel, trading, and missions based on current opportunity.',
      'Use a practical mining loop when it is the best current option: start from low cargo, mine a compatible belt, return near 95% cargo, then process and sell efficiently while docked.',
    ],
  },
}

export function buildLearningContext(profileId: string): string {
  const identity = ensureAgentIdentity(profileId)
  const memory = loadStructuredMemory(profileId)
  const skills = getProfileSkills(profileId)?.skills || {}

  const strengths = Object.entries(skills)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
  const weaknesses = Object.entries(skills)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
  const activeRules = memory.semantic
    .slice()
    .sort((a, b) => b.confirmations - a.confirmations || b.confidence - a.confidence)
    .slice(0, 4)

  const lines = [
    '## Agent Identity',
    `Role: ${identity.role}`,
    `Temperament: ${identity.temperament}`,
    `Development focus: ${identity.development_focus.join(', ') || 'balanced'}`,
    '',
    '## Priorities',
    `Profit ${pct(identity.priorities.profit)}, Survival ${pct(identity.priorities.survival)}, Exploration ${pct(identity.priorities.exploration)}, Social ${pct(identity.priorities.social)}`,
  ]

  if (identity.constraints.length > 0) {
    lines.push('', '## Hard Constraints', ...identity.constraints.map((item) => `- ${item}`))
  }
  const rolePreset = ROLE_PRESETS[normalizeRole(identity.role)]
  if (rolePreset.playstyle.length > 0) {
    lines.push('', '## Role Playstyle', ...rolePreset.playstyle.map((item) => `- ${item}`))
  }
  if (strengths.length > 0) {
    lines.push('', '## Learned Strengths', ...strengths.map(([name, value]) => `- ${name}: ${Math.round(value)}`))
  }
  if (weaknesses.length > 0) {
    lines.push('', '## Current Weaknesses', ...weaknesses.map(([name, value]) => `- ${name}: ${Math.round(value)}`))
  }
  if (activeRules.length > 0) {
    lines.push('', '## Active Learned Rules', ...activeRules.map((entry) => `- ${entry.rule}`))
  }
  if (memory.last_storage) {
    const storage = memory.last_storage
    const notableItems = storage.items
      .filter((item) => (item.quantity ?? 0) > 0)
      .sort((a, b) => (b.quantity ?? 0) - (a.quantity ?? 0))
      .slice(0, 5)
      .map((item) => `${item.item_id} x${Math.round(item.quantity ?? 0)}`)
    lines.push('', '## Last Known Storage')
    lines.push(`Station: ${storage.station_name || storage.station_id || 'unknown'}`)
    lines.push(`Wallet credits: ${storage.wallet_credits ?? '?'}`)
    if (storage.storage_credits !== null) lines.push(`Storage credits: ${storage.storage_credits}`)
    if (notableItems.length > 0) {
      lines.push(`Stored items: ${notableItems.join(', ')}`)
    }
  }

  return lines.join('\n')
}

export function getAgentRole(profileId: string): AgentRole {
  return normalizeRole(ensureAgentIdentity(profileId).role)
}

export function setAgentRole(profileId: string, role: string): AgentIdentity {
  const identity = applyRolePreset(ensureAgentIdentity(profileId), normalizeRole(role))
  saveAgentIdentity(profileId, identity)
  return identity
}

export function observeGameState(profileId: string, gameState: Record<string, unknown> | null): boolean {
  if (!gameState) return false

  const memory = loadStructuredMemory(profileId)
  const skills = getOrCreateSkillMap(profileId)
  const snapshot = extractStatusSnapshot(gameState)
  const previous = memory.last_status
  let changed = false
  let skillsChanged = false

  if (previous) {
    const creditDelta = safeDelta(snapshot.credits, previous.credits)
    const oreDelta = safeDelta(snapshot.ore_mined, previous.ore_mined)
    const tradeDelta = safeDelta(snapshot.trades_completed, previous.trades_completed)
    const exploreDelta = safeDelta(snapshot.systems_explored, previous.systems_explored)

    if (creditDelta > 0) {
      changed = pushEpisode(memory, {
        id: episodeId('credits'),
        kind: 'credits_gain',
        summary: `Net credits increased by ${creditDelta}${snapshot.current_poi ? ` near ${snapshot.current_poi}` : ''}.`,
        confidence: 0.7,
        reward: creditDelta,
        ts: snapshot.ts,
      }) || changed
    }
    if (oreDelta > 0) {
      changed = pushEpisode(memory, {
        id: episodeId('mining'),
        kind: 'mining_progress',
        summary: `Ore mined increased by ${oreDelta}${snapshot.current_system ? ` in ${snapshot.current_system}` : ''}.`,
        confidence: 0.8,
        ts: snapshot.ts,
      }) || changed
      skillsChanged = adjustSkill(skills, 'mining_efficiency', 1 + oreDelta * 0.02) || skillsChanged
    }
    if (tradeDelta > 0) {
      changed = pushEpisode(memory, {
        id: episodeId('trade'),
        kind: 'trade_success',
        summary: `Completed ${tradeDelta} new trade${tradeDelta === 1 ? '' : 's'}${snapshot.current_poi ? ` at ${snapshot.current_poi}` : ''}.`,
        confidence: 0.85,
        ts: snapshot.ts,
      }) || changed
      skillsChanged = adjustSkill(skills, 'market_timing', 1.5) || skillsChanged
      skillsChanged = adjustSkill(skills, 'inventory_discipline', 1) || skillsChanged
      if (snapshot.current_poi) {
        changed = confirmRule(
          memory,
          `${snapshot.current_poi} is a reliable station for trade execution after fresh status verification.`,
          0.68,
          snapshot.ts,
        ) || changed
      }
    }
    if (exploreDelta > 0) {
      changed = pushEpisode(memory, {
        id: episodeId('explore'),
        kind: 'exploration_progress',
        summary: `Explored ${exploreDelta} new system${exploreDelta === 1 ? '' : 's'}.`,
        confidence: 0.75,
        ts: snapshot.ts,
      }) || changed
      skillsChanged = adjustSkill(skills, 'route_planning', 1.25) || skillsChanged
    }
    const cargoRatio = ratio(snapshot.cargo_used, snapshot.cargo_capacity)
    if (cargoRatio !== null && cargoRatio >= 0.95) {
      changed = confirmFailure(
        memory,
        'cargo_overfill_pressure',
        'When cargo exceeds 95%, prioritize unloading or selling before further mining.',
        snapshot.ts,
      ) || changed
      skillsChanged = adjustSkill(skills, 'inventory_discipline', -0.8) || skillsChanged
    }
    if (snapshot.docked === false && previous.docked === true && snapshot.current_system === previous.current_system) {
      skillsChanged = adjustSkill(skills, 'route_planning', 0.2) || skillsChanged
    }
  }

  memory.last_status = snapshot
  saveStructuredMemory(profileId, memory)
  if (skillsChanged) {
    upsertProfileSkills(profileId, skills)
  }
  return changed || skillsChanged
}

export function recordCommandOutcome(
  profileId: string,
  command: string,
  args: Record<string, unknown> | undefined,
  result: CommandResult,
  gameState: Record<string, unknown> | null,
): boolean {
  const normalized = canonicalizeLearningCommand(String(command || '').trim().toLowerCase(), args)
  if (!normalized) return false

  const memory = loadStructuredMemory(profileId)
  const skills = getOrCreateSkillMap(profileId)
  const ts = new Date().toISOString()
  const isQuery = QUERY_COMMANDS.has(normalized)
  const isMutation = MUTATION_COMMANDS.has(normalized)
  let changed = false
  let skillsChanged = false

  if (isQuery) {
    memory.decision.query_streak += 1
    memory.decision.same_query_streak = memory.decision.last_query_command === normalized
      ? memory.decision.same_query_streak + 1
      : 1
    memory.decision.last_query_command = normalized
    memory.decision.last_query_at = ts
    memory.decision.no_progress_streak += 1
    if (memory.decision.query_streak >= 3) {
      skillsChanged = adjustSkill(skills, 'query_discipline', -0.35 * memory.decision.query_streak) || skillsChanged
      skillsChanged = adjustSkill(skills, 'decision_efficiency', -0.25 * memory.decision.query_streak) || skillsChanged
      changed = confirmRule(
        memory,
        'After a fresh status/location check, avoid long query chains and commit to one concrete next action unless blocked.',
        0.72,
        ts,
      ) || changed
    }
    if (memory.decision.same_query_streak >= 3) {
      skillsChanged = adjustSkill(skills, 'query_discipline', -0.45 * memory.decision.same_query_streak) || skillsChanged
      skillsChanged = adjustSkill(skills, 'decision_efficiency', -0.3 * memory.decision.same_query_streak) || skillsChanged
      changed = confirmFailure(
        memory,
        `same_query_loop:${normalized}`,
        `Stop repeating ${normalized}; switch to a narrower or more action-oriented next step.`,
        ts,
      ) || changed
    }
  }

  if (isMutation) {
    const queryStreak = memory.decision.query_streak
    const prevMutationAt = memory.decision.last_mutation_at
    const secondsSinceMutation = prevMutationAt ? Math.max(0, (Date.parse(ts) - Date.parse(prevMutationAt)) / 1000) : null
    memory.decision.query_streak = 0
    memory.decision.same_query_streak = 0
    memory.decision.last_query_command = null
    memory.decision.last_mutation_at = ts

    if (queryStreak <= 2) {
      skillsChanged = adjustSkill(skills, 'decision_efficiency', 1.1) || skillsChanged
      skillsChanged = adjustSkill(skills, 'query_discipline', 0.8) || skillsChanged
      changed = confirmRule(
        memory,
        'Prefer acting within one or two routine queries when the next step is already clear.',
        0.76,
        ts,
      ) || changed
    } else if (queryStreak >= 5) {
      skillsChanged = adjustSkill(skills, 'decision_efficiency', -1.2) || skillsChanged
      skillsChanged = adjustSkill(skills, 'query_discipline', -1.0) || skillsChanged
      changed = confirmFailure(
        memory,
        'decision_loop_overquery',
        'If the next step is routine and unblocked, stop gathering more context and commit to a mutation after at most 2-3 queries.',
        ts,
      ) || changed
    }

    if (secondsSinceMutation !== null && secondsSinceMutation <= 75) {
      skillsChanged = adjustSkill(skills, 'decision_efficiency', 0.6) || skillsChanged
    } else if (secondsSinceMutation !== null && secondsSinceMutation >= 180) {
      skillsChanged = adjustSkill(skills, 'decision_efficiency', -0.8) || skillsChanged
    }
  }

  if (result.error) {
    memory.last_action = {
      command: normalized,
      args,
      success: false,
      error_code: result.error.code,
      ts,
    }
    changed = confirmFailure(
      memory,
      `${normalized}:${result.error.code}`,
      deriveCountermeasure(normalized, result.error.code),
      ts,
    ) || changed

    if (result.error.code === 'cargo_full') {
      skillsChanged = adjustSkill(skills, 'inventory_discipline', -2) || skillsChanged
    }
    if (result.error.code === 'not_enough_fuel') {
      skillsChanged = adjustSkill(skills, 'risk_management', -2) || skillsChanged
      skillsChanged = adjustSkill(skills, 'route_planning', -1) || skillsChanged
    }
    if (result.error.code === 'already_in_system' || result.error.code === 'invalid_payload') {
      skillsChanged = adjustSkill(skills, 'route_planning', -0.5) || skillsChanged
    }
    if (result.error.code === 'action_pending') {
      skillsChanged = adjustSkill(skills, 'decision_efficiency', -1.5) || skillsChanged
      skillsChanged = adjustSkill(skills, 'query_discipline', -0.8) || skillsChanged
      changed = confirmFailure(
        memory,
        'action_pending_followup',
        'After a pending mutation, refresh state instead of stacking another action too early.',
        ts,
      ) || changed
    }
    if (isRateLimitedResult(result)) {
      const waitSeconds = extractRetryAfterSeconds(result)
      skillsChanged = adjustSkill(skills, 'decision_efficiency', -0.5) || skillsChanged
      changed = confirmFailure(
        memory,
        waitSeconds !== null ? `rate_limit_backoff:${waitSeconds}` : 'rate_limit_backoff',
        waitSeconds !== null
          ? `When the API returns a rate limit, wait at least ${waitSeconds}s before retrying instead of spamming nearby commands.`
          : 'When the API returns a rate limit, slow down and avoid immediate retries.',
        ts,
      ) || changed
    }
    if (normalized === 'craft' && (result.error.code === 'insufficient_materials' || result.error.code === 'not_docked')) {
      skillsChanged = adjustSkill(skills, 'crafting_efficiency', -0.8) || skillsChanged
      changed = confirmFailure(
        memory,
        `craft_blocked:${result.error.code}`,
        result.error.code === 'insufficient_materials'
          ? 'Before crafting, verify missing inputs and decide whether to buy, mine, or abandon the recipe path.'
          : 'Before crafting, verify you are docked at a valid station with crafting access.',
        ts,
      ) || changed
    }
    if (normalized === 'accept_mission' || normalized === 'complete_mission' || normalized === 'abandon_mission') {
      skillsChanged = adjustSkill(skills, 'mission_selection', -0.4) || skillsChanged
    }
  } else {
    memory.last_action = {
      command: normalized,
      args,
      success: true,
      ts,
    }
    memory.decision.no_progress_streak = 0
    memory.decision.last_progress_at = ts
    const location = deriveLocation(gameState)
    if (normalized === 'sell') {
      changed = pushEpisode(memory, {
        id: episodeId('sell'),
        kind: 'sell_execution',
        summary: `Sell action completed${location ? ` at ${location}` : ''}.`,
        confidence: 0.82,
        reward: extractNumeric(result, ['total_earned', 'credits_earned', 'earned']),
        ts,
      }) || changed
      skillsChanged = adjustSkill(skills, 'market_timing', 1.2) || skillsChanged
      skillsChanged = adjustSkill(skills, 'inventory_discipline', 0.8) || skillsChanged
      if (location) {
        changed = confirmRule(memory, `${location} is a viable sell location when cargo is ready and status is fresh.`, 0.65, ts) || changed
      }
    } else if (normalized === 'mine') {
      changed = pushEpisode(memory, {
        id: episodeId('mine'),
        kind: 'mine_execution',
        summary: `Mining action completed${location ? ` near ${location}` : ''}.`,
        confidence: 0.78,
        ts,
      }) || changed
      skillsChanged = adjustSkill(skills, 'mining_efficiency', 0.8) || skillsChanged
    } else if (normalized === 'travel' || normalized === 'jump') {
      changed = pushEpisode(memory, {
        id: episodeId(normalized),
        kind: 'navigation_execution',
        summary: `${normalized} executed${extractDestination(args, result) ? ` toward ${extractDestination(args, result)}` : ''}.`,
        confidence: result.meta?.pending ? 0.7 : 0.8,
        ts,
      }) || changed
      skillsChanged = adjustSkill(skills, 'route_planning', 0.7) || skillsChanged
    } else if (normalized === 'craft') {
      changed = pushEpisode(memory, {
        id: episodeId('craft'),
        kind: 'craft_execution',
        summary: `Crafted items successfully${location ? ` at ${location}` : ''}.`,
        confidence: 0.8,
        ts,
      }) || changed
      skillsChanged = adjustSkill(skills, 'inventory_discipline', 0.8) || skillsChanged
      skillsChanged = adjustSkill(skills, 'crafting_efficiency', 1.5) || skillsChanged
      if (location) {
        changed = confirmRule(memory, `${location} is a reliable station for crafting operations.`, 0.65, ts) || changed
      }
      changed = confirmRule(
        memory,
        'When crafting succeeds, re-check output value versus raw-input sale value before repeating the recipe at scale.',
        0.66,
        ts,
      ) || changed
    } else if (normalized === 'accept_mission') {
      const title = extractMissionTitle(result)
      changed = pushEpisode(memory, {
        id: episodeId('mission_accept'),
        kind: 'mission_accept',
        summary: `Accepted mission${title ? `: ${title}` : ''}${location ? ` at ${location}` : ''}.`,
        confidence: 0.78,
        ts,
      }) || changed
      skillsChanged = adjustSkill(skills, 'mission_selection', 0.8) || skillsChanged
      if (location) {
        changed = confirmRule(memory, `${location} is a viable mission board when docked and capacity exists.`, 0.62, ts) || changed
      }
    } else if (normalized === 'complete_mission') {
      const title = extractMissionTitle(result)
      const credits = extractMissionCredits(result)
      changed = pushEpisode(memory, {
        id: episodeId('mission_complete'),
        kind: 'mission_complete',
        summary: `Completed mission${title ? `: ${title}` : ''}${credits !== null ? ` for ${credits} credits` : ''}.`,
        confidence: 0.84,
        reward: credits ?? undefined,
        ts,
      }) || changed
      skillsChanged = adjustSkill(skills, 'mission_selection', 1.3) || skillsChanged
      skillsChanged = adjustSkill(skills, 'decision_efficiency', 0.4) || skillsChanged
      changed = confirmRule(
        memory,
        'Finish economically ready missions promptly instead of letting slots stay blocked after the objectives are already met.',
        0.74,
        ts,
      ) || changed
    } else if (normalized === 'abandon_mission') {
      changed = pushEpisode(memory, {
        id: episodeId('mission_abandon'),
        kind: 'mission_abandon',
        summary: 'Abandoned a mission to free capacity for a better plan.',
        confidence: 0.68,
        ts,
      }) || changed
      skillsChanged = adjustSkill(skills, 'mission_selection', 0.5) || skillsChanged
      changed = confirmRule(
        memory,
        'Abandon impractical or low-ROI missions promptly so mission slots stay available for better opportunities.',
        0.72,
        ts,
      ) || changed
    } else if (normalized === 'refuel' || normalized === 'repair' || normalized === 'dock') {
      skillsChanged = adjustSkill(skills, 'risk_management', 0.5) || skillsChanged
    } else if (normalized === 'chat' || normalized === 'social_chat') {
      const channel = extractChatChannel(args, result) || 'unknown'
      changed = pushEpisode(memory, {
        id: episodeId('chat'),
        kind: 'social_execution',
        summary: `Sent a ${channel} chat message${location ? ` near ${location}` : ''}.`,
        confidence: 0.7,
        ts,
      }) || changed
      skillsChanged = adjustSkill(skills, 'decision_efficiency', 0.2) || skillsChanged
      if (channel === 'faction') {
        changed = confirmRule(
          memory,
          'Faction chat should carry concise operational updates: route, cargo, threats, prices, mission needs, or requests for help.',
          0.73,
          ts,
        ) || changed
      }
    } else if (normalized === 'storage_view') {
      const storage = extractStorageSnapshot(result, gameState)
      if (storage) {
        const previousStorage = memory.last_storage
        memory.last_storage = storage
        changed = pushEpisode(memory, {
          id: episodeId('storage'),
          kind: 'storage_snapshot',
          summary: `Viewed storage at ${storage.station_name || storage.station_id || 'unknown station'} with ${storage.items.filter((item) => (item.quantity ?? 0) > 0).length} stored item stacks.`,
          confidence: 0.7,
          ts,
        }) || changed

        if (storage.items.some((item) => (item.quantity ?? 0) > 0)) {
          changed = confirmRule(
            memory,
            'Before spending wallet credits on upgrades, check whether station storage already holds useful inventory that can support the next step.',
            0.64,
            ts,
          ) || changed
        }

        if (previousStorage && storage.station_id && previousStorage.station_id === storage.station_id) {
          const previousTotal = sumStorageItems(previousStorage.items)
          const nextTotal = sumStorageItems(storage.items)
          if (nextTotal > previousTotal) {
            changed = confirmRule(
              memory,
              `${storage.station_name || storage.station_id} is a viable batching station for unloading cargo before a later market action.`,
              0.68,
              ts,
            ) || changed
            skillsChanged = adjustSkill(skills, 'inventory_discipline', 0.8) || skillsChanged
          }
        }
      }
    } else if (normalized === 'storage_deposit') {
      skillsChanged = adjustSkill(skills, 'inventory_discipline', 0.9) || skillsChanged
      changed = confirmRule(
        memory,
        'When docked and market conditions are weak, depositing cargo into station storage is usually better than repeating bad instant sells.',
        0.74,
        ts,
      ) || changed
    } else if (normalized === 'storage_withdraw') {
      skillsChanged = adjustSkill(skills, 'inventory_discipline', 0.4) || skillsChanged
    }
  }

  if (isMutation && !result.error && result.meta?.pending !== true) {
    memory.decision.no_progress_streak = 0
    memory.decision.last_progress_at = ts
  }

  if (memory.decision.no_progress_streak >= 4) {
    skillsChanged = adjustSkill(skills, 'decision_efficiency', -0.35 * memory.decision.no_progress_streak) || skillsChanged
    changed = confirmFailure(
      memory,
      'no_progress_query_chain',
      'Break the query chain: verify the narrowest blocker once, then commit to one mutation or end the turn.',
      ts,
    ) || changed
  }

  saveStructuredMemory(profileId, memory)
  if (skillsChanged) {
    upsertProfileSkills(profileId, skills)
  }
  return changed || skillsChanged
}

export function getDecisionPressureSnapshot(profileId: string): DecisionPressureSnapshot {
  const memory = loadStructuredMemory(profileId)
  const decision = memory.decision
  let recommendation: string | null = null

  if (decision.same_query_streak >= 3 && decision.last_query_command) {
    recommendation = `Repeated ${decision.last_query_command} queries detected; avoid another broad refresh and switch to one narrower check or one concrete action.`
  } else if (decision.no_progress_streak >= 4) {
    recommendation = 'Several query steps produced no visible progress; stop gathering context and either execute one fitting mutation or wait for new state.'
  } else if (decision.query_streak >= 4) {
    recommendation = 'Query chain is growing; prefer one concrete next action instead of another routine status check.'
  }

  return {
    queryStreak: decision.query_streak,
    sameQueryStreak: decision.same_query_streak,
    noProgressStreak: decision.no_progress_streak,
    lastQueryCommand: decision.last_query_command,
    recommendation,
  }
}

export function getLatestStorageSnapshot(profileId: string): {
  ts: string
  station_id: string | null
  station_name: string | null
  wallet_credits: number | null
  storage_credits: number | null
  items: Array<{ item_id: string; quantity: number | null }>
} | null {
  return normalizeStorageSnapshot(loadStructuredMemory(profileId).last_storage)
}

function normalizeStorageSnapshot(storage: StorageSnapshot | null): StorageSnapshot | null {
  if (!storage) return null
  const stationId = toText(storage.station_id)
  const stationName = toText(storage.station_name) || prettifyLocationId(stationId)
  return {
    ...storage,
    station_id: stationId,
    station_name: stationName,
  }
}

function prettifyLocationId(value: string | null): string | null {
  if (!value) return null
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function ensureAgentIdentity(profileId: string): AgentIdentity {
  const file = agentIdentityPath(profileId)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as AgentIdentity
    if (parsed && parsed.version === 1) {
      const normalizedRole = normalizeRole(parsed.role)
      const normalized = applyRolePreset({
        ...parsed,
        role: normalizedRole,
      }, normalizedRole)
      if (JSON.stringify(normalized) !== JSON.stringify(parsed)) saveAgentIdentity(profileId, normalized)
      return normalized
    }
  } catch {
    // ignore
  }

  const profile = getProfile(profileId)
  const seed = readProfileAgents(profileId).toLowerCase()
  const identity = applyRolePreset({
    version: 1,
    role: 'miner',
    temperament: inferTemperament(seed),
    priorities: {
      profit: seed.includes('profit') ? 0.9 : 0.7,
      survival: seed.includes('risk') || seed.includes('safe') ? 0.85 : 0.7,
      exploration: seed.includes('explore') || seed.includes('map') ? 0.75 : 0.35,
      social: seed.includes('chat') || seed.includes('join') ? 0.45 : 0.15,
    },
    constraints: inferConstraints(seed),
    development_focus: inferDevelopmentFocus(seed),
  }, 'miner')

  fs.mkdirSync(path.dirname(file), { recursive: true })
  saveAgentIdentity(profileId, identity)
  if (!profile) return identity
  return identity
}

function saveAgentIdentity(profileId: string, identity: AgentIdentity): void {
  const file = agentIdentityPath(profileId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(identity, null, 2) + '\n', 'utf-8')
}

function loadStructuredMemory(profileId: string): StructuredAgentMemory {
  const file = structuredMemoryPath(profileId)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as StructuredAgentMemory
    if (parsed && parsed.version === 1) {
      return {
        version: 1,
        episodic: Array.isArray(parsed.episodic) ? parsed.episodic.slice(0, MAX_EPISODES) : [],
        semantic: Array.isArray(parsed.semantic) ? parsed.semantic.slice(0, MAX_RULES) : [],
        failures: Array.isArray(parsed.failures) ? parsed.failures.slice(0, MAX_FAILURES) : [],
        last_status: parsed.last_status || null,
        last_storage: parsed.last_storage || null,
        last_action: parsed.last_action || null,
        decision: {
          query_streak: parsed.decision?.query_streak || 0,
          same_query_streak: parsed.decision?.same_query_streak || 0,
          no_progress_streak: parsed.decision?.no_progress_streak || 0,
          last_query_command: parsed.decision?.last_query_command || null,
          last_progress_at: parsed.decision?.last_progress_at || null,
          last_query_at: parsed.decision?.last_query_at || null,
          last_mutation_at: parsed.decision?.last_mutation_at || null,
        },
      }
    }
  } catch {
    // ignore
  }
  return {
    version: 1,
    episodic: [],
    semantic: [],
    failures: [],
    last_status: null,
    last_storage: null,
    last_action: null,
    decision: {
      query_streak: 0,
      same_query_streak: 0,
      no_progress_streak: 0,
      last_query_command: null,
      last_progress_at: null,
      last_query_at: null,
      last_mutation_at: null,
    },
  }
}

function saveStructuredMemory(profileId: string, memory: StructuredAgentMemory): void {
  const file = structuredMemoryPath(profileId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(memory, null, 2) + '\n', 'utf-8')
}

function getOrCreateSkillMap(profileId: string): Record<string, number> {
  const existing = getProfileSkills(profileId)?.skills || {}
  return {
    mining_efficiency: 50,
    market_timing: 50,
    route_planning: 50,
    risk_management: 50,
    inventory_discipline: 50,
    mission_selection: 50,
    decision_efficiency: 50,
    query_discipline: 50,
    crafting_efficiency: 50,
    ...existing,
  }
}

function extractStatusSnapshot(gameState: Record<string, unknown>): StatusSnapshot {
  const player = ((gameState.player as Record<string, unknown> | undefined) || {})
  const ship = ((gameState.ship as Record<string, unknown> | undefined) || {})
  const stats = ((player.stats as Record<string, unknown> | undefined) || {})
  return {
    ts: new Date().toISOString(),
    credits: toNum(player.credits),
    ore_mined: toNum(stats.ore_mined),
    trades_completed: toNum(stats.trades_completed),
    systems_explored: toNum(stats.systems_explored),
    current_system: toText(player.current_system),
    current_poi: toText(player.current_poi),
    docked: deriveDockedFromState(gameState),
    cargo_used: toNum(ship.cargo_used),
    cargo_capacity: toNum(ship.cargo_capacity),
  }
}

function deriveDockedFromState(gameState: Record<string, unknown>): boolean | null {
  const location = ((gameState.location as Record<string, unknown> | undefined) || {})
  const player = ((gameState.player as Record<string, unknown> | undefined) || {})
  const poi = resolvePoiSnapshot(location, player)
  const poiType = poi.type
  const poiName = poi.name
  if (!String(poiType || '').trim() && !String(poiName || '').trim()) return null
  return isDockedPoi(poiType, poiName)
}

function deriveLocation(gameState: Record<string, unknown> | null): string | null {
  if (!gameState) return null
  const location = ((gameState.location as Record<string, unknown> | undefined) || {})
  const player = ((gameState.player as Record<string, unknown> | undefined) || {})
  return toText(location.poi_name) || toText(player.current_poi) || toText(player.current_system)
}

function extractMissionTitle(result: CommandResult): string | null {
  const record = ((result.structuredContent ?? result.result) as Record<string, unknown> | undefined) || {}
  return toText(record.title) || toText(record.mission_title) || null
}

function extractMissionCredits(result: CommandResult): number | null {
  const record = ((result.structuredContent ?? result.result) as Record<string, unknown> | undefined) || {}
  return toNum(record.credits_earned ?? record.credits ?? record.reward_credits)
}

function extractChatChannel(args: Record<string, unknown> | undefined, result: CommandResult): string | null {
  const argChannel = toText(args?.channel)
  if (argChannel) return argChannel
  const record = ((result.structuredContent ?? result.result) as Record<string, unknown> | undefined) || {}
  return toText(record.channel)
}

function extractDestination(args: Record<string, unknown> | undefined, result: CommandResult): string | null {
  const fromArgs = toText(args?.destination) || toText(args?.target_system) || toText(args?.system_name)
  const meta = result.meta || {}
  return fromArgs || toText(meta.destination_name) || toText(meta.destination_id)
}

function extractNumeric(result: CommandResult, keys: string[]): number | undefined {
  const record = ((result.structuredContent ?? result.result) as Record<string, unknown> | undefined) || {}
  for (const key of keys) {
    const value = toNum(record[key])
    if (value !== null) return value
  }
  return undefined
}

function deriveCountermeasure(command: string, code: string): string {
  if (code === 'cargo_full') return 'Sell, unload, or change activity before mining again.'
  if (code === 'not_enough_fuel') return 'Check route and fuel before the next navigation mutation.'
  if (code === 'already_in_system') return 'Refresh state before repeating travel or jump.'
  if (code === 'no_base') return 'Move to a valid base or station, dock if needed, and retry only from there.'
  if (command === 'sell') return 'Run fresh get_status, confirm cargo and docked state, then sell once.'
  return `Treat ${command} ${code} as planning feedback, refresh state, and avoid repeating the blocked action.`
}

function canonicalizeLearningCommand(command: string, args?: Record<string, unknown>): string {
  if (command === 'get_market') return 'view_market'
  if (command === 'cancel_mission') return 'abandon_mission'
  if (command === 'get_list_ships') return 'list_ships'
  if (command === 'get_recipes') return 'catalog'
  if (command === 'get_guide') return 'help'
  if (command === 'get_insurance_quote') return 'salvage_quote'
  if (command === 'deposit_items') return 'storage_deposit'
  if (command === 'withdraw_items') return 'storage_withdraw'
  if (command === 'get_storage') return 'storage_view'
  if (command === 'view_storage') return 'storage_view'
  if (command === 'chat_history') return 'get_chat_history'
  if (command === 'storage') {
    const action = typeof args?.action === 'string' ? args.action.trim().toLowerCase() : ''
    if (action === 'deposit') return 'storage_deposit'
    if (action === 'withdraw') return 'storage_withdraw'
    return 'storage_view'
  }
  if (command === 'faction_create_role') return 'faction_admin_create_role'
  if (command === 'faction_intel_status') return 'intel_status'
  if (command === 'faction_query_intel') return 'query_intel'
  if (command === 'faction_query_trade_intel') return 'query_trade_intel'
  if (command === 'faction_trade_intel_status') return 'trade_intel_status'
  return command
}

function confirmRule(memory: StructuredAgentMemory, rule: string, confidence: number, ts: string): boolean {
  const existing = memory.semantic.find((entry) => entry.rule === rule)
  if (existing) {
    existing.confirmations += 1
    existing.confidence = Math.min(0.95, Math.max(existing.confidence, confidence))
    existing.last_confirmed_at = ts
    return true
  }
  memory.semantic.unshift({
    rule,
    confidence,
    confirmations: 1,
    last_confirmed_at: ts,
  })
  memory.semantic = memory.semantic.slice(0, MAX_RULES)
  return true
}

function extractStorageSnapshot(result: CommandResult, gameState: Record<string, unknown> | null): StorageSnapshot | null {
  const record = ((result.structuredContent ?? result.result) as Record<string, unknown> | undefined) || {}
  if (!record || typeof record !== 'object') return null

  const player = ((gameState?.player as Record<string, unknown> | undefined) || {})
  const location = ((gameState?.location as Record<string, unknown> | undefined) || {})
  const itemCandidates = [record.items, record.storage, record.inventory]
  let items: StorageItemSnapshot[] = []
  for (const candidate of itemCandidates) {
    if (!Array.isArray(candidate)) continue
    items = candidate
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((entry) => ({
        item_id: toText(entry.item_id) || toText(entry.id) || toText(entry.name) || 'unknown_item',
        quantity: toNum(entry.quantity ?? entry.amount ?? entry.count),
      }))
    if (items.length > 0) break
  }

  const fallbackStationId = (
    toText(location.docked_at)
    || toText(location.station_id)
    || toText(location.base_id)
    || toText(location.poi_id)
    || toText(player.current_poi)
  )
  const fallbackStationName = (
    toText(location.station_name)
    || toText(location.base_name)
    || toText(location.poi_name)
    || toText(record.location_name)
  )

  return {
    ts: new Date().toISOString(),
    station_id: toText(record.station_id) || toText(record.base_id) || fallbackStationId,
    station_name: toText(record.station_name) || toText(record.base_name) || toText(record.station) || fallbackStationName,
    wallet_credits: toNum(player.credits),
    storage_credits: toNum(record.credits ?? record.storage_credits ?? record.balance),
    items,
  }
}

function sumStorageItems(items: StorageItemSnapshot[]): number {
  return items.reduce((sum, item) => sum + (item.quantity ?? 0), 0)
}

function extractRetryAfterSeconds(result: CommandResult): number | null {
  const direct = toNum(result.error?.retry_after ?? result.error?.wait_seconds)
  if (direct !== null) return direct
  const message = result.error?.message || ''
  const match = message.match(/\b(?:retry[_ ]after|wait(?:_seconds)?)[^\d]{0,8}(\d+)\b/i) || message.match(/\b(\d+)\s*s(?:ec(?:ond)?s?)?\b/i)
  return match ? Number(match[1]) : null
}

function isRateLimitedResult(result: CommandResult): boolean {
  const code = String(result.error?.code || '').toLowerCase()
  const message = String(result.error?.message || '').toLowerCase()
  return code.includes('429') || code.includes('rate') || message.includes('429') || message.includes('rate limit')
}

function confirmFailure(memory: StructuredAgentMemory, pattern: string, countermeasure: string, ts: string): boolean {
  const existing = memory.failures.find((entry) => entry.pattern === pattern)
  if (existing) {
    existing.count += 1
    existing.last_seen_at = ts
    existing.countermeasure = countermeasure
    return true
  }
  memory.failures.unshift({
    pattern,
    countermeasure,
    count: 1,
    last_seen_at: ts,
  })
  memory.failures = memory.failures.slice(0, MAX_FAILURES)
  return true
}

function pushEpisode(memory: StructuredAgentMemory, episode: Episode): boolean {
  if (memory.episodic[0]?.summary === episode.summary) return false
  memory.episodic.unshift(episode)
  memory.episodic = memory.episodic.slice(0, MAX_EPISODES)
  return true
}

function adjustSkill(skills: Record<string, number>, key: string, delta: number): boolean {
  const current = Number.isFinite(skills[key]) ? skills[key] : 50
  const next = clamp(current + delta, 1, 100)
  if (Math.abs(next - current) < 0.01) return false
  skills[key] = Math.round(next * 100) / 100
  return true
}

function agentBaseDir(profileId: string): string {
  const safeId = profileId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(AGENTS_DIR, safeId)
}

function agentIdentityPath(profileId: string): string {
  return path.join(agentBaseDir(profileId), 'agent.json')
}

function structuredMemoryPath(profileId: string): string {
  return path.join(agentBaseDir(profileId), 'memory.json')
}

function readProfileAgents(profileId: string): string {
  try {
    return fs.readFileSync(path.join(agentBaseDir(profileId), 'AGENTS.md'), 'utf-8')
  } catch {
    return ''
  }
}

function normalizeRole(role: string): AgentRole {
  const normalized = String(role || '').trim().toLowerCase()
  if (normalized === 'explorer' || normalized === 'explorer_scout') return 'scout'
  if (normalized === 'miner_trader' || normalized === 'mining') return 'miner'
  if (normalized === 'pirate_raider') return 'pirate'
  if (normalized === 'generalist_operator') return 'generalist'
  if ((AGENT_ROLES as readonly string[]).includes(normalized)) return normalized as AgentRole
  return 'miner'
}

function applyRolePreset(identity: AgentIdentity, role: AgentRole): AgentIdentity {
  const preset = ROLE_PRESETS[role]
  const mergedConstraints = Array.from(new Set([
    ...preset.constraints,
    ...identity.constraints.filter((item) => !preset.constraints.includes(item)),
  ]))
  const mergedFocus = Array.from(new Set([
    ...preset.development_focus,
    ...identity.development_focus.filter((item) => !preset.development_focus.includes(item)),
  ]))
  return {
    ...identity,
    role,
    temperament: preset.temperament,
    priorities: preset.priorities,
    constraints: mergedConstraints,
    development_focus: mergedFocus,
  }
}

function inferTemperament(seed: string): string {
  if (seed.includes('aggressive') || seed.includes('pirate')) return 'aggressive'
  if (seed.includes('safe') || seed.includes('risk')) return 'cautious'
  if (seed.includes('opportun')) return 'opportunistic'
  return 'balanced'
}

function inferConstraints(seed: string): string[] {
  const constraints = [
    'Always verify current status before high-impact sell or route decisions.',
  ]
  if (seed.includes('fuel')) constraints.push('Never start multi-hop navigation without checking fuel feasibility.')
  if (seed.includes('cargo')) constraints.push('Do not continue mining when cargo is critically full.')
  return constraints
}

function inferDevelopmentFocus(seed: string): string[] {
  const focus: string[] = []
  if (seed.includes('profit') || seed.includes('market')) focus.push('market_timing')
  if (seed.includes('travel') || seed.includes('route')) focus.push('route_planning')
  if (seed.includes('mine')) focus.push('mining_efficiency')
  if (seed.includes('risk') || seed.includes('safe')) focus.push('risk_management')
  if (seed.includes('decision') || seed.includes('efficient')) focus.push('decision_efficiency')
  return focus.length > 0 ? focus : ['market_timing', 'route_planning']
}

function episodeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function safeDelta(next: number | null, prev: number | null): number {
  if (next === null || prev === null) return 0
  return next - prev
}

function toNum(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function ratio(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b <= 0) return null
  return a / b
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}
