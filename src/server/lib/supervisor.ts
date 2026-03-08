import { complete } from '@mariozechner/pi-ai'
import type { Context } from '@mariozechner/pi-ai'
import {
  addLogEntry,
  createSupervisorRun,
  getLogEntries,
  getPreference,
  listProfiles,
  markSupervisorRunFailed,
  recordSupervisorRunResponse,
  markSupervisorRunSucceeded,
} from './db'
import { agentManager } from './agent-manager'
import { resolveModel } from './model'
import type { MutationState, NavigationState } from './agent'
import { createGameConnection } from './game-connection'
import type { Profile } from '../../shared/types'

const DEFAULT_INTERVAL_SEC = 45
const MAX_CANDIDATES = 5
const NUDGE_COOLDOWN_MS = 10 * 60_000
const KB_CACHE_TTL_MS = 6 * 60 * 60_000
const SHIP_UPGRADE_CACHE_TTL_MS = 20 * 60_000
const MIN_FITTING_RESERVE_CREDITS = 15_000
const MIN_FITTING_RESERVE_RATIO = 0.2
const SHIP_KB_URL = 'https://rsned.github.io/spacemolt-kb/ships/'

type Candidate = {
  profileId: string
  profileName: string
  mutationState: string
  mutationDetail: string | null
  navigationState: string
  navigationDetail: string | null
  gameState: unknown
  recentSignals: string[]
  routeSignals: string[]
  shipUpgradeSignals: string[]
  adviceSignals: AdviceSignal[]
}

type AdviceSignal = {
  kind: string
  priority: number
  summary: string
  evidence: string[]
  recommendedChecks: string[]
  recommendedActions: string[]
  whyNow?: string
}

type MapSystem = {
  id: string
  name: string
  connections?: string[]
}

type MapResponse = {
  systems?: MapSystem[]
}

type RouteGraph = {
  byId: Map<string, MapSystem>
  byName: Map<string, MapSystem>
}

type GraphCacheEntry = {
  expiresAt: number
  graph: RouteGraph
}

const GRAPH_TTL_MS = 5 * 60_000
const graphCache = new Map<string, GraphCacheEntry>()
let shipCatalogCache: { expiresAt: number; ships: Map<string, ShipCatalogEntry> } | null = null

type ShipCatalogEntry = {
  name: string
  tier: number
  hull: number
  shield: number
  cargo: number
  weaponSlots: number
  defenseSlots: number
  utilitySlots: number
}

type SkillMap = Record<string, number>

type ShipOffer = {
  name: string
  classId: string
  price: number
  requiredSkills: SkillMap
  skillEligible: boolean
}

type ShipUpgradeContext = {
  offers: ShipOffer[]
  skills: SkillMap
}

class FleetSupervisor {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private lastNudgeAtByProfile = new Map<string, number>()
  private lastNudgeTextByProfile = new Map<string, string>()
  private shipUpgradeSignalsCache = new Map<string, { expiresAt: number; signals: string[] }>()

  start(): void {
    if (this.timer) clearTimeout(this.timer)
    setTimeout(() => {
      this.runOnce().catch((err) => {
        console.error(`[supervisor] initial pass failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }, 15_000)
    this.scheduleNext()
  }

  async runOnce(): Promise<void> {
    if (this.running) return

    const provider = (getPreference('supervisor_provider') || '').trim()
    const modelId = (getPreference('supervisor_model') || '').trim()
    if (!isSupervisorEnabled() || !provider || !modelId) {
      this.scheduleNext()
      return
    }

    this.running = true
    let runId: number | null = null
    try {
      const candidates = await this.collectCandidates()
      if (candidates.length === 0) return

      runId = createSupervisorRun({
        providerName: provider,
        modelName: modelId,
        candidateCount: candidates.length,
        candidatesJson: JSON.stringify(candidates),
      })

      const { model, apiKey, failoverApiKey } = await resolveModel(`${provider}/${modelId}`)
      const context: Context = {
        systemPrompt: [
          'You are Admiral Fleet Supervisor.',
          'Your job is to send gentle, non-destructive nudges to game agents when recent evidence suggests confusion, local stalls, or incorrect next-step planning.',
          'Do not issue commands. Do not recommend self-destruct, account reset, logout/login recovery, or any irreversible action.',
          'Use only the supplied adviceSignals when composing a nudge. Do not invent diagnoses or recommendations that are not supported by adviceSignals.',
          'Prefer the single highest-priority actionable signal for each profile.',
          'Preserve specific checks and actions from the selected signal. Do not replace a specific check like get_cargo, market, dock, or find_route with generic get_status unless the signal itself only recommends get_status.',
          'If adviceSignals is empty, omit that profile.',
          'Return strict JSON only: {"nudges":[{"profile":"name","message":"short hint"}]}.',
          'Each message should be one short sentence or two short clauses, grounded in the chosen advice signal evidence.',
          'At most 3 nudges. Omit profiles that do not need intervention.',
        ].join(' '),
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              now: new Date().toISOString(),
              candidates,
            }, null, 2),
            timestamp: Date.now(),
          },
        ],
      }

      const response = await complete(model, context, {
        apiKey: apiKey || failoverApiKey || undefined,
        timeout: 60_000,
      })

      const text = response.content
        .filter((block: any) => block.type === 'text' && typeof block.text === 'string')
        .map((block: any) => block.text.trim())
        .join('\n')
        .trim()

      if (runId !== null && text) {
        recordSupervisorRunResponse(runId, text)
      }

      if (!text) return

      const parsed = parseSupervisorOutput(text)
      if (!parsed) {
        if (runId !== null) markSupervisorRunFailed(runId, 'Supervisor returned no parseable JSON')
        return
      }

      let nudgesSent = 0
      for (const nudge of parsed.nudges.slice(0, 3)) {
        const profile = listProfiles().find((entry) => entry.name === nudge.profile)
        if (!profile) continue

        const status = agentManager.getStatus(profile.id)
        if (!status.running) continue
        if (!shouldSendNudge(this.lastNudgeAtByProfile.get(profile.id), this.lastNudgeTextByProfile.get(profile.id), nudge.message)) continue

        agentManager.nudge(profile.id, nudge.message)
        addLogEntry(profile.id, 'system', `Supervisor nudge: ${nudge.message}`)
        this.lastNudgeAtByProfile.set(profile.id, Date.now())
        this.lastNudgeTextByProfile.set(profile.id, nudge.message)
        nudgesSent++
      }

      if (runId !== null) {
        markSupervisorRunSucceeded(runId, nudgesSent, JSON.stringify(parsed.nudges.slice(0, 3)))
      }
    } catch (err) {
      if (runId !== null) {
        markSupervisorRunFailed(runId, err instanceof Error ? err.message : String(err))
      }
      throw err
    } finally {
      this.running = false
      this.scheduleNext()
    }
  }

  private async collectCandidates(): Promise<Candidate[]> {
    const candidates: Candidate[] = []

    for (const profile of listProfiles().filter((entry) => entry.enabled)) {
      const status = agentManager.getStatus(profile.id)
      if (!status.running) continue

      const logs = getLogEntries(profile.id, undefined, 14)
      const recentSignals = buildRecentSignals(logs.map((entry) => entry.summary))
      const routeSignals = await this.buildRouteSignals(profile.server_url, status)
      const shipUpgradeSignals = await this.buildShipUpgradeSignals(profile, status)
      const adviceSignals = buildAdviceSignals(status, recentSignals, routeSignals, shipUpgradeSignals)
      const noisyState =
        status.mutation_state !== 'idle' ||
        recentSignals.length > 0 ||
        routeSignals.length > 0 ||
        shipUpgradeSignals.length > 0 ||
        adviceSignals.length > 0
      if (!noisyState) continue

      candidates.push({
        profileId: profile.id,
        profileName: profile.name,
        mutationState: status.mutation_state as MutationState,
        mutationDetail: status.mutation_state_detail,
        navigationState: status.navigation_state as NavigationState,
        navigationDetail: status.navigation_state_detail,
        gameState: status.gameState,
        recentSignals,
        routeSignals,
        shipUpgradeSignals,
        adviceSignals,
      })

      if (candidates.length >= MAX_CANDIDATES) break
    }

    return candidates
  }

  private async buildShipUpgradeSignals(
    profile: Profile,
    status: ReturnType<typeof agentManager.getStatus>,
  ): Promise<string[]> {
    const cached = this.shipUpgradeSignalsCache.get(profile.id)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.signals
    }

    const signals = await computeShipUpgradeSignals(profile, status)
    this.shipUpgradeSignalsCache.set(profile.id, {
      expiresAt: Date.now() + SHIP_UPGRADE_CACHE_TTL_MS,
      signals,
    })
    return signals
  }

  private async buildRouteSignals(
    serverUrl: string | undefined,
    status: ReturnType<typeof agentManager.getStatus>,
  ): Promise<string[]> {
    const signals: string[] = []
    const destinationRaw = extractPendingDestination(status.mutation_state_detail || status.navigation_state_detail)
    if (!destinationRaw) return signals

    const currentSystemRaw = status.gameState?.system
    if (typeof currentSystemRaw !== 'string' || !currentSystemRaw.trim()) return signals

    const graph = await getRouteGraph(serverUrl)
    if (!graph) return signals

    const current = resolveSystem(graph, currentSystemRaw)
    const target = resolveSystem(graph, destinationRaw)
    if (!current || !target) {
      signals.push(`pending navigation target '${destinationRaw}' could not be validated against the system graph`)
      return signals
    }

    const currentConnections = new Set((current.connections || []).map(normalizeSystemKey))
    if (!currentConnections.has(normalizeSystemKey(target.id))) {
      const hops = estimateHopCount(graph, current.id, target.id)
      if (hops !== null && hops > 1) {
        signals.push(`current system '${current.name}' is not directly connected to '${target.name}'; direct jump should not be possible and the route needs about ${hops} jumps`)
      } else {
        signals.push(`current system '${current.name}' is not directly connected to '${target.name}'; direct jump should not be possible`)
      }
    }

    return signals
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer)
    const delayMs = getSupervisorIntervalSec() * 1000
    this.timer = setTimeout(() => {
      this.runOnce().catch((err) => {
        console.error(`[supervisor] pass failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }, delayMs)
  }
}

function buildRecentSignals(summaries: string[]): string[] {
  const signals: string[] = []
  const add = (label: string) => {
    if (!signals.includes(label)) signals.push(label)
  }

  for (const summary of summaries) {
    const lower = summary.toLowerCase()
    if (lower.includes('blocked duplicate navigation command')) add('duplicate navigation was blocked recently')
    if (lower.includes('navigation deadlock')) add('agent described a navigation deadlock recently')
    if (lower.includes('server freeze')) add('agent described a server freeze recently')
    if (lower.includes('error: [not_docked]')) add('not_docked error observed recently')
    if (lower.includes('error: [no_base]')) add('no_base error observed recently')
    if (lower.includes('error: [already_in_system]')) add('already_in_system error observed recently')
    if (lower.includes('[action_result]')) add('recent action_result observed')
    if (lower.includes('"action":"jumped"')) add('recent jumped confirmation observed')
    if (lower.includes('pending action accepted')) add('recent mutation accepted as pending')
  }

  return signals.slice(0, 8)
}

function buildAdviceSignals(
  status: ReturnType<typeof agentManager.getStatus>,
  recentSignals: string[],
  routeSignals: string[],
  shipUpgradeSignals: string[],
): AdviceSignal[] {
  const signals: AdviceSignal[] = []
  const ship = status.gameState?.ship
  const cargo = parseUsagePair(ship?.cargo)
  const credits = toFiniteNumber(status.gameState?.credits)
  const poi = typeof status.gameState?.poi === 'string' ? status.gameState.poi.trim() : ''
  const system = typeof status.gameState?.system === 'string' ? status.gameState.system.trim() : ''
  const cargoItems = Array.isArray(ship?.cargoItems)
    ? ship.cargoItems.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
  const isDocked = looksDocked(poi) || status.navigation_state === 'docked'

  if (cargo && cargo.capacity > 0 && cargo.used >= cargo.capacity) {
    signals.push({
      kind: 'cargo_full_sell',
      priority: isDocked ? 95 : 88,
      summary: isDocked
        ? 'Cargo is full and the ship is docked; clear inventory instead of gathering more.'
        : 'Cargo is full; stop gathering and clear inventory before continuing.',
      evidence: [
        `cargo=${cargo.used}/${cargo.capacity}`,
        ...(poi ? [`poi=${poi}`] : []),
        ...(cargoItems.length > 0 ? [`cargo_items=${cargoItems.slice(0, 4).join(', ')}`] : []),
      ],
      recommendedChecks: isDocked ? ['get_cargo', 'market'] : ['get_cargo'],
      recommendedActions: isDocked ? ['sell cargo'] : ['dock before selling or transferring cargo'],
      whyNow: 'the gather plan is blocked until cargo capacity is freed',
    })
  }

  if (routeSignals.length > 0) {
    signals.push({
      kind: 'route_needs_find_route',
      priority: 92,
      summary: 'The pending navigation target is not a direct hop; re-plan the route before jumping again.',
      evidence: routeSignals.slice(0, 2),
      recommendedChecks: ['find_route'],
      recommendedActions: ['jump only to the next hop from the returned route'],
      whyNow: 'repeating the same jump will keep failing or stalling',
    })
  }

  if (recentSignals.includes('not_docked error observed recently')) {
    signals.push({
      kind: 'dock_before_docked_actions',
      priority: 85,
      summary: 'A docked-only action was attempted while undocked; correct the state first.',
      evidence: [
        'recent not_docked error observed',
        ...(poi ? [`poi=${poi}`] : []),
        ...(system ? [`system=${system}`] : []),
      ],
      recommendedChecks: ['get_status'],
      recommendedActions: ['dock before retrying sell, refuel, repair, or upgrade actions'],
      whyNow: 'the current plan is using the wrong ship state',
    })
  }

  if (recentSignals.includes('already_in_system error observed recently')) {
    signals.push({
      kind: 'travel_already_satisfied',
      priority: 76,
      summary: 'Travel is already satisfied; skip the repeated movement and continue with the next local step.',
      evidence: [
        'recent already_in_system error observed',
        ...(system ? [`system=${system}`] : []),
        ...(poi ? [`poi=${poi}`] : []),
      ],
      recommendedChecks: ['get_status'],
      recommendedActions: ['continue with the local post-arrival step instead of retrying travel'],
      whyNow: 'repeating the same travel adds no progress',
    })
  }

  if (shipUpgradeSignals.length > 0) {
    signals.push({
      kind: 'upgrade_ship',
      priority: 72,
      summary: 'A materially better ship appears affordable with reserve left for fitting.',
      evidence: shipUpgradeSignals.slice(0, 1),
      recommendedChecks: ['shipyard_showroom', 'browse_ships'],
      recommendedActions: ['consider upgrading the hull before further grinding'],
      whyNow: credits !== null ? `current credits=${credits}` : 'an affordable upgrade window is available',
    })
  }

  return signals.sort((a, b) => b.priority - a.priority)
}

function parseSupervisorOutput(text: string): { nudges: Array<{ profile: string; message: string }> } | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { nudges?: Array<{ profile?: unknown; message?: unknown }> }
    if (!Array.isArray(parsed.nudges)) return null
    return {
      nudges: parsed.nudges
        .map((entry) => ({
          profile: typeof entry.profile === 'string' ? entry.profile.trim() : '',
          message: typeof entry.message === 'string' ? entry.message.trim() : '',
        }))
        .filter((entry) => entry.profile && entry.message),
    }
  } catch {
    return null
  }
}

function shouldSendNudge(lastAt: number | undefined, lastText: string | undefined, nextText: string): boolean {
  if (!nextText.trim()) return false
  if (lastText && lastText.trim() === nextText.trim()) {
    return !lastAt || (Date.now() - lastAt) >= NUDGE_COOLDOWN_MS
  }
  return !lastAt || (Date.now() - lastAt) >= 60_000
}

function isSupervisorEnabled(): boolean {
  return (getPreference('supervisor_enabled') || '').trim() === 'true'
}

function getSupervisorIntervalSec(): number {
  const raw = (getPreference('supervisor_interval_sec') || '').trim()
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_INTERVAL_SEC
  return Math.max(10, Math.floor(parsed))
}

export const fleetSupervisor = new FleetSupervisor()

function parseUsagePair(value: unknown): { used: number; capacity: number } | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(\d+)\s*\/\s*(\d+)$/)
  if (!match) return null
  const used = Number(match[1])
  const capacity = Number(match[2])
  if (!Number.isFinite(used) || !Number.isFinite(capacity)) return null
  return { used, capacity }
}

function looksDocked(poi: string): boolean {
  const normalized = poi.toLowerCase()
  return normalized.includes('station') || normalized.includes('base') || normalized.includes('shipyard')
}

async function computeShipUpgradeSignals(
  profile: Profile,
  status: ReturnType<typeof agentManager.getStatus>,
): Promise<string[]> {
  const poi = typeof status.gameState?.poi === 'string' ? status.gameState.poi.toLowerCase() : ''
  if (!poi || (!poi.includes('shipyard') && !poi.includes('base') && !poi.includes('station'))) return []
  if (!profile.username || !profile.password) return []

  const credits = typeof status.gameState?.credits === 'number' ? status.gameState.credits : null
  if (credits === null || credits < MIN_FITTING_RESERVE_CREDITS) return []

  const shipRecord = status.gameState?.ship
  const shipName = stringifyShipValue(shipRecord?.name) || stringifyShipValue(shipRecord?.class)
  const currentShip = shipName ? await getShipCatalogEntry(shipName) : null
  if (!currentShip) return []

  const upgradeContext = await fetchShipUpgradeContext(profile)
  if (upgradeContext.offers.length === 0) return []

  const reserveBudget = Math.max(MIN_FITTING_RESERVE_CREDITS, Math.floor(credits * MIN_FITTING_RESERVE_RATIO))
  const best = await pickUpgradeOffer(currentShip, upgradeContext.offers, credits, reserveBudget, upgradeContext.skills)
  if (!best) return []

  const spareCredits = credits - best.price
  const totalSlotsCurrent = currentShip.weaponSlots + currentShip.defenseSlots + currentShip.utilitySlots
  const totalSlotsNext = best.ship.weaponSlots + best.ship.defenseSlots + best.ship.utilitySlots
  const requiredSkillsSummary = formatRequiredSkills(best.requiredSkills)
  return [
    `affordable ship upgrade available: ${currentShip.name} -> ${best.ship.name} for ${best.price} cr; reserve after hull purchase stays ${spareCredits} cr for fitting; skill check passed${requiredSkillsSummary ? ` (${requiredSkillsSummary})` : ''}; cargo ${currentShip.cargo}->${best.ship.cargo}, durability ${currentShip.hull + currentShip.shield}->${best.ship.hull + best.ship.shield}, total slots ${totalSlotsCurrent}->${totalSlotsNext}, tier ${currentShip.tier}->${best.ship.tier}`,
  ]
}

async function pickUpgradeOffer(
  currentShip: ShipCatalogEntry,
  offers: ShipOffer[],
  credits: number,
  reserveBudget: number,
  skills: SkillMap,
): Promise<{ ship: ShipCatalogEntry; price: number; score: number; requiredSkills: SkillMap } | null> {
  const candidates: Array<{ ship: ShipCatalogEntry; price: number; score: number; requiredSkills: SkillMap }> = []

  for (const offer of offers) {
    if (!offer.skillEligible) continue
    const ship = await getShipCatalogEntry(offer.name || offer.classId)
    if (!ship) continue
    if (normalizeShipKey(ship.name) === normalizeShipKey(currentShip.name)) continue
    if (offer.price + reserveBudget > credits) continue
    if (!hasRequiredSkills(skills, offer.requiredSkills)) continue

    const improvesCargo = ship.cargo > currentShip.cargo
    const improvesDurability = ship.hull + ship.shield > currentShip.hull + currentShip.shield
    const improvesSlots =
      ship.weaponSlots + ship.defenseSlots + ship.utilitySlots >
      currentShip.weaponSlots + currentShip.defenseSlots + currentShip.utilitySlots
    const improvesTier = ship.tier > currentShip.tier
    if (!improvesCargo && !improvesDurability && !improvesSlots && !improvesTier) continue

    const score =
      (ship.tier - currentShip.tier) * 10_000 +
      (ship.cargo - currentShip.cargo) * 10 +
      ((ship.hull + ship.shield) - (currentShip.hull + currentShip.shield)) +
      ((ship.weaponSlots + ship.defenseSlots + ship.utilitySlots) - (currentShip.weaponSlots + currentShip.defenseSlots + currentShip.utilitySlots)) * 250 -
      offer.price / 100
    candidates.push({ ship, price: offer.price, score, requiredSkills: offer.requiredSkills })
  }

  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  return best || null
}

async function fetchShipUpgradeContext(profile: Profile): Promise<ShipUpgradeContext> {
  const connection = createGameConnection(profile)
  try {
    await connection.connect()
    const login = await connection.login(profile.username || '', profile.password || '')
    if (!login.success) return { offers: [], skills: {} }

    const responses = await Promise.all([
      connection.execute('catalog', { type: 'ships', commissionable: true }),
      connection.execute('get_skills', {}),
      connection.execute('shipyard_showroom', {}),
      connection.execute('browse_ships', {}),
    ])

    const commissionable = responses[0]
    const skillsResp = responses[1]
    const offerResponses = responses.slice(2)
    const skills = extractSkillLevels((skillsResp.structuredContent ?? skillsResp.result) as Record<string, unknown> | undefined)
    const commissionableOffers = extractShipOffers((commissionable.structuredContent ?? commissionable.result) as Record<string, unknown> | undefined)
    const commissionableClassIds = new Set(
      commissionableOffers
        .map((offer) => normalizeShipKey(offer.classId || offer.name))
        .filter(Boolean),
    )

    const offers = dedupeShipOffers(
      offerResponses.flatMap((resp) => {
        if (resp.error) return []
        return extractShipOffers((resp.structuredContent ?? resp.result) as Record<string, unknown> | undefined)
      }),
    )

    return {
      offers: offers
        .filter((offer): offer is { name: string; classId: string; price: number; requiredSkills: SkillMap } => typeof offer.price === 'number' && Number.isFinite(offer.price))
        .map((offer) => ({
          name: offer.name,
          classId: offer.classId,
          price: offer.price,
          requiredSkills: offer.requiredSkills,
          skillEligible:
            commissionableClassIds.has(normalizeShipKey(offer.classId || offer.name)) ||
            hasRequiredSkills(skills, offer.requiredSkills),
        })),
      skills,
    }
  } catch {
    return { offers: [], skills: {} }
  } finally {
    await connection.disconnect().catch(() => {})
  }
}

async function getShipCatalogEntry(nameOrClass: string): Promise<ShipCatalogEntry | null> {
  const ships = await getShipCatalog()
  return ships.get(normalizeShipKey(nameOrClass)) || null
}

async function getShipCatalog(): Promise<Map<string, ShipCatalogEntry>> {
  if (shipCatalogCache && shipCatalogCache.expiresAt > Date.now()) {
    return shipCatalogCache.ships
  }

  const resp = await fetch(SHIP_KB_URL, { signal: AbortSignal.timeout(15_000) })
  if (!resp.ok) throw new Error(`failed to load ship catalog: ${resp.status}`)
  const html = await resp.text()
  const ships = parseShipCatalog(html)
  shipCatalogCache = { expiresAt: Date.now() + KB_CACHE_TTL_MS, ships }
  return ships
}

function parseShipCatalog(html: string): Map<string, ShipCatalogEntry> {
  const ships = new Map<string, ShipCatalogEntry>()
  const rowPattern = /<tr>\s*<td>([^<]+)<\/td>\s*<td class="num">(\d+)<\/td>\s*<td class="num">(\d+)<\/td>\s*<td class="num">\d+<\/td>\s*<td class="num">(\d+)<\/td>\s*<td class="num">[^<]+<\/td>\s*<td class="num">[^<]+<\/td>\s*<td class="num">\d+<\/td>\s*<td class="num">(\d+)<\/td>\s*<td class="num">(\d+)<\/td>\s*<td class="num">(\d+)<\/td>\s*<td class="num">(\d+)<\/td>\s*<\/tr>/g
  for (const match of html.matchAll(rowPattern)) {
    const entry: ShipCatalogEntry = {
      name: match[1].trim(),
      tier: Number(match[2]),
      hull: Number(match[3]),
      shield: Number(match[4]),
      cargo: Number(match[5]),
      weaponSlots: Number(match[6]),
      defenseSlots: Number(match[7]),
      utilitySlots: Number(match[8]),
    }
    ships.set(normalizeShipKey(entry.name), entry)
  }
  return ships
}

function normalizeShipKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function stringifyShipValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function extractShipOffers(data: Record<string, unknown> | undefined): Array<{ name: string; classId: string; price: number | null; requiredSkills: SkillMap }> {
  if (!data) return []
  const candidates = [
    data.ships,
    data.listings,
    data.offers,
    data.items,
    (data.result as Record<string, unknown> | undefined)?.ships,
    (data.result as Record<string, unknown> | undefined)?.items,
  ]

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const offers = candidate
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        const name = String(record.name || record.ship_name || record.class_name || '').trim()
        const classId = String(record.ship_class || record.class_id || record.ship_class_id || '').trim()
        const price = toFiniteNumber(record.price ?? record.ask_price ?? record.cost ?? record.sale_price)
        const requiredSkills = extractRequiredSkills(record)
        if (!name && !classId) return null
        return { name, classId, price, requiredSkills }
      })
      .filter((offer): offer is { name: string; classId: string; price: number | null; requiredSkills: SkillMap } => Boolean(offer))
    if (offers.length > 0) return offers
  }

  return []
}

function dedupeShipOffers(offers: Array<{ name: string; classId: string; price: number | null; requiredSkills: SkillMap }>): Array<{ name: string; classId: string; price: number | null; requiredSkills: SkillMap }> {
  const deduped = new Map<string, { name: string; classId: string; price: number | null; requiredSkills: SkillMap }>()
  for (const offer of offers) {
    const key = `${offer.classId.toLowerCase()}|${offer.name.toLowerCase()}`
    const existing = deduped.get(key)
    if (
      !existing ||
      (existing.price !== null && offer.price !== null && offer.price < existing.price) ||
      (existing.price === null && offer.price !== null) ||
      (Object.keys(existing.requiredSkills).length === 0 && Object.keys(offer.requiredSkills).length > 0)
    ) {
      deduped.set(key, offer)
    }
  }
  return [...deduped.values()]
}

function extractSkillLevels(data: Record<string, unknown> | undefined): SkillMap {
  const rawSkills = (data?.skills || (data?.result as Record<string, unknown> | undefined)?.skills) as Record<string, unknown> | undefined
  if (!rawSkills || typeof rawSkills !== 'object') return {}
  const entries = Object.entries(rawSkills)
    .map(([skillId, value]) => {
      if (!value || typeof value !== 'object') return null
      const level = toFiniteNumber((value as Record<string, unknown>).level)
      if (level === null) return null
      return [normalizeShipKey(skillId), level] as const
    })
    .filter((entry): entry is readonly [string, number] => Boolean(entry))
  return Object.fromEntries(entries)
}

function extractRequiredSkills(record: Record<string, unknown>): SkillMap {
  const raw = record.required_skills
  if (!raw || typeof raw !== 'object') return {}
  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([skillId, value]) => {
      const level = toFiniteNumber(value)
      if (level === null) return null
      return [normalizeShipKey(skillId), level] as const
    })
    .filter((entry): entry is readonly [string, number] => Boolean(entry))
  return Object.fromEntries(entries)
}

function hasRequiredSkills(skills: SkillMap, requiredSkills: SkillMap): boolean {
  for (const [skillId, level] of Object.entries(requiredSkills)) {
    if ((skills[normalizeShipKey(skillId)] || 0) < level) return false
  }
  return true
}

function formatRequiredSkills(requiredSkills: SkillMap): string {
  const parts = Object.entries(requiredSkills)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([skillId, level]) => `${skillId} ${level}`)
  return parts.join(', ')
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeSystemKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function extractPendingDestination(detail: string | null | undefined): string | null {
  if (!detail) return null
  const match = detail.match(/\b(?:jump|travel)\s+to\s+(.+?)\s+pending\b/i)
  return match?.[1]?.trim() || null
}

function resolveSystem(graph: RouteGraph, raw: string): MapSystem | null {
  const key = normalizeSystemKey(raw)
  return graph.byId.get(key) || graph.byName.get(key) || null
}

function estimateHopCount(graph: RouteGraph, fromId: string, toId: string): number | null {
  const start = normalizeSystemKey(fromId)
  const goal = normalizeSystemKey(toId)
  if (start === goal) return 0

  const visited = new Set<string>([start])
  const queue: Array<{ id: string; hops: number }> = [{ id: start, hops: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()!
    const node = graph.byId.get(current.id)
    if (!node) continue
    for (const nextRaw of node.connections || []) {
      const next = normalizeSystemKey(nextRaw)
      if (visited.has(next)) continue
      const hops = current.hops + 1
      if (next === goal) return hops
      visited.add(next)
      queue.push({ id: next, hops })
    }
  }
  return null
}

async function getRouteGraph(serverUrl: string | undefined): Promise<RouteGraph | null> {
  const normalizedUrl = (serverUrl || 'https://game.spacemolt.com').trim().replace(/\/$/, '')
  const cached = graphCache.get(normalizedUrl)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.graph
  }

  try {
    const graph = await fetchRouteGraph(normalizedUrl)
    graphCache.set(normalizedUrl, { expiresAt: Date.now() + GRAPH_TTL_MS, graph })
    return graph
  } catch {
    return null
  }
}

async function fetchRouteGraph(serverUrl: string): Promise<RouteGraph> {
  const resp = await fetch(`${serverUrl}/api/map`, {
    headers: { 'User-Agent': 'SpaceMolt-Admiral' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!resp.ok) {
    throw new Error(`map request failed (${resp.status})`)
  }

  const parsed = await resp.json() as MapResponse
  const systems = Array.isArray(parsed.systems) ? parsed.systems : []
  const byId = new Map<string, MapSystem>()
  const byName = new Map<string, MapSystem>()
  for (const system of systems) {
    if (!system?.id || !system?.name) continue
    byId.set(normalizeSystemKey(system.id), system)
    byName.set(normalizeSystemKey(system.name), system)
  }
  return { byId, byName }
}
