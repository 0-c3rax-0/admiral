import type { Message, ToolCall, AssistantMessage } from '@mariozechner/pi-ai'

export interface AdvisorStallState {
  previousRoundSignature?: string
  previousResultSignature?: string
  repeatedRoundSignatureCount: number
  stalledErrorRounds: number
  stagnantRounds: number
}

export function extractReasoningSummary(response: AssistantMessage): string {
  const textParts = response.content
    .filter((b: any) => b.type === 'text' && b.text?.trim())
    .map((b: any) => b.text.trim())
  let reasoning = textParts.join(' ')
  if (!reasoning) {
    const thinking = response.content
      .filter((b: any) => 'thinking' in b && b.thinking?.trim())
      .map((b: any) => b.thinking.trim())
      .join(' ')
    if (thinking) {
      const sentences = thinking.split(/[.!?\n]/).filter((s: string) => s.trim().length > 10)
      reasoning = sentences.slice(-3).map((s: string) => s.trim()).join('. ')
    }
  }
  return reasoning
}

export function shortenReasoning(reasoning: string): string | undefined {
  if (!reasoning) return undefined
  return reasoning.length > 180 ? reasoning.slice(0, 177) + '...' : reasoning
}

export function buildToolResultMessage(toolCall: ToolCall, result: string): Message {
  return {
    role: 'toolResult',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: 'text', text: result }],
    isError: result.startsWith('Error'),
    timestamp: Date.now(),
  }
}

export function buildImmediateRecoveryMessage(reason: string, suggestedStateCheck: string, verification: string): Message {
  return {
    role: 'user' as const,
    content: [
      '## Immediate Recovery Replan',
      `The just-executed action needs re-evaluation: ${reason}.`,
      `A fresh ${suggestedStateCheck} was executed immediately. Treat its result below as authoritative and revise the plan now instead of repeating the blocked action.`,
      'Verified state/result:',
      verification,
    ].join('\n\n'),
    timestamp: Date.now(),
  }
}

export function updateAdvisorStallState(
  prev: AdvisorStallState,
  round: { toolSignature: string; resultSignature: string; hasErrors: boolean; allErrored: boolean; isStatusOnly: boolean },
): AdvisorStallState {
  const sameTools = Boolean(round.toolSignature) && round.toolSignature === prev.previousRoundSignature
  const sameResults = Boolean(round.resultSignature) && round.resultSignature === prev.previousResultSignature

  return {
    previousRoundSignature: round.toolSignature || prev.previousRoundSignature,
    previousResultSignature: round.resultSignature || prev.previousResultSignature,
    repeatedRoundSignatureCount: !round.isStatusOnly && sameTools ? prev.repeatedRoundSignatureCount + 1 : 0,
    stalledErrorRounds: round.allErrored && sameTools ? prev.stalledErrorRounds + 1 : 0,
    stagnantRounds: !round.isStatusOnly && sameResults ? prev.stagnantRounds + 1 : 0,
  }
}

export function isStatusOnlyRound(toolFingerprints: string[]): boolean {
  if (toolFingerprints.length === 0) return false
  return toolFingerprints.every(fp => fp === 'game:{"command":"get_status"}')
}

export function fingerprintToolCall(name: string, args: Record<string, unknown>): string {
  const normalizedArgs = stableStringify(normalizeValue(args))
  return `${name}:${normalizedArgs}`
}

export function fingerprintResult(result: string): string {
  return result
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 240)
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      out[key] = normalizeValue(record[key])
    }
    return out
  }
  return value
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value) || ''
  } catch {
    return String(value)
  }
}
