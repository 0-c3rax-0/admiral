import { Agent, clearProfileMemory, readProfileMemory, writeProfileMemory } from './agent'

type SlimGameState = {
  credits?: unknown
  system?: unknown
  poi?: unknown
  ship?: {
    class?: unknown
    hull: string
    shield: string
    fuel: string
    cargo: string
    cargoItems?: string[]
  }
  modules?: { name?: unknown; wear?: unknown; ammo?: string }[]
} | null

function slimGameState(raw: Record<string, unknown> | null): SlimGameState {
  if (!raw) return null
  const gs = raw as Record<string, unknown>
  const player = gs.player as Record<string, unknown> | undefined
  const ship = gs.ship as Record<string, unknown> & { cargo?: unknown[] } | undefined
  const modules = gs.modules as Array<Record<string, unknown>> | undefined
  const cargoItems = ship && Array.isArray(ship.cargo)
    ? ship.cargo.map((c) => {
      const item = c as Record<string, unknown>
      return `${item.item_id} x${item.quantity}`
    })
    : undefined
  return {
    credits: player?.credits,
    system: player?.current_system,
    poi: player?.current_poi,
    ship: ship ? {
      class: ship.class_id,
      hull: `${ship.hull ?? 0}/${ship.max_hull ?? 0}`,
      shield: `${ship.shield ?? 0}/${ship.max_shield ?? 0}`,
      fuel: `${ship.fuel ?? 0}/${ship.max_fuel ?? 0}`,
      cargo: `${ship.cargo_used ?? 0}/${ship.cargo_capacity ?? 0}`,
      cargoItems,
    } : undefined,
    modules: modules?.map(m => ({
      name: m.name,
      wear: m.wear_status,
      ammo: m.current_ammo !== undefined ? `${m.current_ammo}/${m.magazine_size}` : undefined,
    })),
  }
}

class AgentManager {
  private agents = new Map<string, Agent>()
  private connecting = new Map<string, Promise<Agent>>()
  private lastConnectAtByProfile = new Map<string, number>()
  private lastConnectAtGlobal = 0

  private static readonly PROFILE_CONNECT_COOLDOWN_MS = 10_000
  private static readonly GLOBAL_CONNECT_COOLDOWN_MS = 2_000

  getAgent(profileId: string): Agent | undefined {
    return this.agents.get(profileId)
  }

  async connect(profileId: string): Promise<Agent> {
    const now = Date.now()
    const lastProfile = this.lastConnectAtByProfile.get(profileId) || 0
    if (now - lastProfile < AgentManager.PROFILE_CONNECT_COOLDOWN_MS) {
      const waitMs = AgentManager.PROFILE_CONNECT_COOLDOWN_MS - (now - lastProfile)
      throw new Error(`CONNECT_THROTTLED: Profile connect cooldown active (${Math.ceil(waitMs / 1000)}s)`)
    }
    if (now - this.lastConnectAtGlobal < AgentManager.GLOBAL_CONNECT_COOLDOWN_MS) {
      const waitMs = AgentManager.GLOBAL_CONNECT_COOLDOWN_MS - (now - this.lastConnectAtGlobal)
      throw new Error(`CONNECT_THROTTLED: Global connect cooldown active (${Math.ceil(waitMs / 1000)}s)`)
    }

    // If already connected, return existing
    let agent = this.agents.get(profileId)
    if (agent?.isConnected) return agent
    const inFlight = this.connecting.get(profileId)
    if (inFlight) return inFlight

    // Create new agent and dedupe concurrent connect attempts
    const connectPromise = (async () => {
      this.lastConnectAtByProfile.set(profileId, Date.now())
      this.lastConnectAtGlobal = Date.now()

      agent = this.agents.get(profileId)
      if (!agent) {
        agent = new Agent(profileId)
        this.agents.set(profileId, agent)
      }
      await agent.connect()
      return agent
    })()

    this.connecting.set(profileId, connectPromise)
    try {
      return await connectPromise
    } finally {
      this.connecting.delete(profileId)
    }
  }

  async startLLM(profileId: string): Promise<void> {
    const agent = this.agents.get(profileId)
    if (!agent) throw new Error('Agent not connected')
    if (agent.isRunning) return

    // Run in background (don't await)
    agent.startLLMLoop().catch(() => {
      // Loop ended (normal or error) -- agent handles logging
    })
  }

  async disconnect(profileId: string): Promise<void> {
    const agent = this.agents.get(profileId)
    if (!agent) return

    await agent.stop()
    this.agents.delete(profileId)
  }

  restartTurn(profileId: string): void {
    const agent = this.agents.get(profileId)
    if (agent?.isRunning) {
      agent.restartTurn()
    }
  }

  nudge(profileId: string, message: string): void {
    const agent = this.agents.get(profileId)
    if (agent?.isRunning) {
      agent.injectNudge(message)
    }
  }

  getStatus(profileId: string): {
    connected: boolean
    running: boolean
    activity: string
    adaptive_mode: 'normal' | 'soft' | 'high' | 'critical'
    effective_context_budget_ratio: number | null
    gameState: SlimGameState
  } {
    const agent = this.agents.get(profileId)
    return {
      connected: agent?.isConnected ?? false,
      running: agent?.isRunning ?? false,
      activity: agent?.activity ?? 'idle',
      adaptive_mode: agent?.adaptiveMode ?? 'normal',
      effective_context_budget_ratio: agent?.effectiveContextBudgetRatio ?? null,
      gameState: slimGameState(agent?.gameState ?? null),
    }
  }

  async sampleProfileStats(profileId: string): Promise<{
    connected: boolean
    running: boolean
    adaptive_mode: 'normal' | 'soft' | 'high' | 'critical'
    effective_context_budget_ratio: number | null
    credits: number | null
    ore_mined: number | null
    trades_completed: number | null
    systems_explored: number | null
  }> {
    const status = this.getStatus(profileId)
    const agent = this.agents.get(profileId)
    const game = status.connected && agent
      ? await agent.sampleGameStatus()
      : null

    return {
      connected: status.connected,
      running: status.running,
      adaptive_mode: status.adaptive_mode,
      effective_context_budget_ratio: status.effective_context_budget_ratio,
      credits: game?.credits ?? null,
      ore_mined: game?.ore_mined ?? null,
      trades_completed: game?.trades_completed ?? null,
      systems_explored: game?.systems_explored ?? null,
    }
  }

  listActive(): string[] {
    return Array.from(this.agents.entries())
      .filter(([, agent]) => agent.isConnected)
      .map(([id]) => id)
  }

  getMemory(profileId: string): string {
    const agent = this.agents.get(profileId)
    if (agent) return agent.getMemory()
    return readProfileMemory(profileId)
  }

  saveMemory(profileId: string): boolean {
    const agent = this.agents.get(profileId)
    if (agent) return agent.saveMemory()
    const memory = readProfileMemory(profileId)
    if (!memory.trim()) return false
    writeProfileMemory(profileId, memory)
    return true
  }

  resetMemory(profileId: string): void {
    const agent = this.agents.get(profileId)
    if (agent) {
      agent.resetMemory()
      return
    }
    clearProfileMemory(profileId)
  }
}

export const agentManager = new AgentManager()
