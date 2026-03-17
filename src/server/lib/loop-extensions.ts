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

export function extractFallbackToolCalls(response: AssistantMessage): ToolCall[] {
  const text = response.content
    .filter((b: any) => (b.type === 'text' || b.type === 'thinking') && (b.text?.trim() || b.thinking?.trim()))
    .map((b: any) => (typeof b.text === 'string' ? b.text : b.thinking).trim())
    .join('\n')

  if (!text) return []

  const discovered: ToolCall[] = []
  const seen = new Set<string>()
  let syntheticId = 0

  const addCall = (name: string, args: Record<string, unknown>) => {
    const normalizedName = name.trim()
    if (!normalizedName) return
    const fingerprint = `${normalizedName}:${stableStringify(normalizeValue(args))}`
    if (seen.has(fingerprint)) return
    seen.add(fingerprint)
    discovered.push({
      type: 'toolCall',
      id: `fallback-tool-${++syntheticId}`,
      name: normalizedName,
      arguments: args,
    })
  }

  const xmlFunctionRegex = /<function=([a-zA-Z0-9_:-]+)>\s*<\/function>/g
  for (const match of text.matchAll(xmlFunctionRegex)) {
    addCall(match[1], {})
  }

  const xmlToolJsonRegex = /<tool_call>\s*(\{[\s\S]*?"name"\s*:\s*"[^"]+"[\s\S]*?\})\s*<\/tool_call>/g
  for (const match of text.matchAll(xmlToolJsonRegex)) {
    try {
      const parsed = JSON.parse(match[1]) as { name?: unknown; arguments?: unknown }
      if (typeof parsed.name !== 'string') continue
      const args = parsed.arguments && typeof parsed.arguments === 'object'
        ? parsed.arguments as Record<string, unknown>
        : {}
      addCall(parsed.name, args)
    } catch {
      // Ignore malformed JSON fragments; this parser is best-effort.
    }
  }

  const inlineGameRegex = /game\(\s*,\s*command=([a-zA-Z0-9_:-]+)(?:\s+args=(\{[\s\S]*?\}))?\s*\)/g
  for (const match of text.matchAll(inlineGameRegex)) {
    const command = match[1]
    let nestedArgs: Record<string, unknown> = {}
    if (match[2]) {
      try {
        const parsed = JSON.parse(match[2]) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          nestedArgs = parsed as Record<string, unknown>
        }
      } catch {
        // Ignore malformed inline args fragments.
      }
    }
    addCall('game', { command, args: nestedArgs })
  }

  return discovered
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
