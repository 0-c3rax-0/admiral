import { complete } from '@mariozechner/pi-ai'
import type { Context } from '@mariozechner/pi-ai'
import {
  addLogEntry,
  createSupervisorRun,
  getLogEntries,
  getPreference,
  listProfiles,
  markSupervisorRunFailed,
  markSupervisorRunSucceeded,
} from './db'
import { agentManager } from './agent-manager'
import { resolveModel } from './model'
import type { MutationState, NavigationState } from './agent'

const DEFAULT_INTERVAL_SEC = 45
const MAX_CANDIDATES = 5
const NUDGE_COOLDOWN_MS = 10 * 60_000

type Candidate = {
  profileId: string
  profileName: string
  mutationState: string
  mutationDetail: string | null
  navigationState: string
  navigationDetail: string | null
  gameState: unknown
  recentSignals: string[]
}

class FleetSupervisor {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private lastNudgeAtByProfile = new Map<string, number>()
  private lastNudgeTextByProfile = new Map<string, string>()

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
      const candidates = this.collectCandidates()
      if (candidates.length === 0) return

      runId = createSupervisorRun({
        providerName: provider,
        modelName: modelId,
        candidateCount: candidates.length,
      })

      const { model, apiKey, failoverApiKey } = await resolveModel(`${provider}/${modelId}`)
      const context: Context = {
        systemPrompt: [
          'You are Admiral Fleet Supervisor.',
          'Your job is to send gentle, non-destructive nudges to game agents when recent evidence suggests confusion, local stalls, or incorrect next-step planning.',
          'Do not issue commands. Do not recommend self-destruct, account reset, logout/login recovery, or any irreversible action.',
          'Prefer short guidance like: verify with get_status, trust recent ACTION_RESULT, re-plan after not_docked/no_base, avoid calling a local stall a server-wide deadlock.',
          'Return strict JSON only: {"nudges":[{"profile":"name","message":"short hint"}]}.',
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

      if (runId !== null) markSupervisorRunSucceeded(runId, nudgesSent)
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

  private collectCandidates(): Candidate[] {
    const candidates: Candidate[] = []

    for (const profile of listProfiles().filter((entry) => entry.enabled)) {
      const status = agentManager.getStatus(profile.id)
      if (!status.running) continue

      const logs = getLogEntries(profile.id, undefined, 14)
      const recentSignals = buildRecentSignals(logs.map((entry) => entry.summary))
      const noisyState = status.mutation_state !== 'idle' || recentSignals.length > 0
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
      })

      if (candidates.length >= MAX_CANDIDATES) break
    }

    return candidates
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
