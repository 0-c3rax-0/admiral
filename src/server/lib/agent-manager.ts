import { Agent, clearProfileMemory, readProfileMemory, writeProfileMemory } from './agent'

class AgentManager {
  private agents = new Map<string, Agent>()

  getAgent(profileId: string): Agent | undefined {
    return this.agents.get(profileId)
  }

  async connect(profileId: string): Promise<Agent> {
    // If already connected, return existing
    let agent = this.agents.get(profileId)
    if (agent?.isConnected) return agent

    // Create new agent
    agent = new Agent(profileId)
    this.agents.set(profileId, agent)

    await agent.connect()
    return agent
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
  } {
    const agent = this.agents.get(profileId)
    return {
      connected: agent?.isConnected ?? false,
      running: agent?.isRunning ?? false,
      activity: agent?.activity ?? 'idle',
      adaptive_mode: agent?.adaptiveMode ?? 'normal',
      effective_context_budget_ratio: agent?.effectiveContextBudgetRatio ?? null,
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
