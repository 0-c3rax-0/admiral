import { complete } from '@mariozechner/pi-ai'
import type { Model, Context, AssistantMessage, ToolCall, Message } from '@mariozechner/pi-ai'
import type { GameConnection, CommandResult } from './connections/interface'
import type { LogFn } from './tools'
import { detectImmediateRecoveryHint, executeTool } from './tools'
import {
  buildImmediateRecoveryMessage,
  buildToolResultMessage,
  extractFallbackToolCalls,
  extractReasoningSummary,
  fingerprintResult,
  fingerprintToolCall,
  isStatusOnlyRound,
  shortenReasoning,
  updateAdvisorStallState,
  type AdvisorStallState,
} from '../../fork/server'
import {
  enqueueLlmRequest,
  getLlmRateWindowStats,
  getPreference,
  markLlmRequestFailed,
  markLlmRequestProcessing,
  markLlmRequestRetryableError,
  markLlmRequestSucceeded,
} from './db'

const DEFAULT_MAX_TOOL_ROUNDS = 30
const MAX_RETRIES = 3
const MAX_MODERATION_REMEDIATIONS = 1
const RETRY_BASE_DELAY = 5000
const DEFAULT_LLM_TIMEOUT_MS = 300_000

const CHARS_PER_TOKEN = 2  // Game JSON tokenizes at ~1.7 chars/token; 2 is a safe approximation
const CONTEXT_BUDGET_RATIO = 0.45  // Trigger compaction earlier to leave room
const MIN_RECENT_MESSAGES = 10
const SUMMARY_MAX_TOKENS = 1024
const MAX_CONTEXT_MESSAGES = 120
const MAX_LLM_LOG_MESSAGES = 24
const MAX_LLM_LOG_TEXT_CHARS = 600
const MAX_LLM_LOG_DETAIL_CHARS = 16_000
const ADAPTIVE_RSS_SOFT_BYTES = 2_200_000_000
const ADAPTIVE_RSS_HIGH_BYTES = 2_800_000_000
const ADAPTIVE_RSS_CRITICAL_BYTES = 3_500_000_000
const REQUEST_OUTPUT_TOKEN_RESERVE = 4096
const REQUEST_TOOL_TOKEN_RESERVE = 512
const REQUEST_TOKEN_SAFETY_MARGIN = 512
const MAX_UNINTERPRETABLE_RESPONSE_RETRIES = 1
const OPENROUTER_FREE_SOFT_COMPACTION_TOKENS = 40_000
const OPENROUTER_FREE_HARD_COMPACTION_TOKENS = 55_000

export interface LoopOptions {
  signal?: AbortSignal
  apiKey?: string
  failoverApiKey?: string
  failoverModel?: Model<any>
  failoverActive?: boolean
  onFailoverActivated?: () => void
  onPrimaryRecovered?: () => void
  maxToolRounds?: number
  llmTimeoutMs?: number
  resumeRequest?: { id: number; idempotencyKey: string; attemptCount?: number }
  contextBudgetRatio?: number
  compactInputEnabled?: boolean
  compactionModel?: Model<any>  // Separate (cheaper) model for compaction summarization
  compactionApiKey?: string
  advisorEnabled?: boolean
  advisorModel?: Model<any>
  advisorApiKey?: string
  gameState?: Record<string, unknown> | null
  onActivity?: (activity: string) => void
  onAdaptiveContext?: (info: { mode: 'normal' | 'soft' | 'high' | 'critical'; effectiveRatio: number; rssBytes: number }) => void
  onGameCommandResult?: (command: string, args: Record<string, unknown> | undefined, result: CommandResult) => void
}

export interface CompactionState {
  summary: string
}

export async function runAgentTurn(
  model: Model<any>,
  context: Context,
  connection: GameConnection,
  profileId: string,
  log: LogFn,
  todo: { value: string },
  options?: LoopOptions,
  compaction?: CompactionState,
): Promise<void> {
  const maxRounds = options?.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS
  const summaryModel = options?.compactionModel || model
  let advisorUnavailable = false
  let switchedToAdvisorModel = false
  let activeModel = model
  let activeApiKey = options?.apiKey
  let rounds = 0
  let uninterpretableResponseRetries = 0
  let advisorState: AdvisorStallState = {
    repeatedRoundSignatureCount: 0,
    stalledErrorRounds: 0,
    stagnantRounds: 0,
  }
  let currentGameState = options?.gameState ?? null

  while (rounds < maxRounds) {
    if (options?.signal?.aborted) return

    if (
      !advisorUnavailable &&
      !switchedToAdvisorModel &&
      options?.advisorEnabled &&
      options?.advisorModel &&
      shouldActivateAdvisor(advisorState, rounds)
    ) {
      activeModel = options.advisorModel
      activeApiKey = options.advisorApiKey || options.apiKey || options.failoverApiKey
      switchedToAdvisorModel = true
      const modelName = ((activeModel as any).name as string | undefined) || ((activeModel as any).id as string | undefined) || 'unknown'
      log('system', `Alternative solver activated after loop/stall detection: ${describeAdvisorTrigger(advisorState)}. Model: ${modelName}`)
    }

    const shouldCompactForMessageCount = context.messages.length > MAX_CONTEXT_MESSAGES
    if (shouldCompactForMessageCount || options?.compactInputEnabled) {
      await compactContext(summaryModel, context, compaction, { ...options, apiKey: activeApiKey }, log)
    }
    enforceContextMessageCap(context)

    options?.onActivity?.('Waiting for LLM response...')
    let response: AssistantMessage
    try {
      response = await completeWithRetry(
        activeModel,
        context,
        profileId,
        log,
        { ...options, apiKey: activeApiKey },
        compaction,
      )
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (switchedToAdvisorModel && shouldFallbackFromAlternativeModel(error)) {
        advisorUnavailable = true
        switchedToAdvisorModel = false
        activeModel = model
        activeApiKey = options?.apiKey
        log(
          'system',
          `Alternative solver failed; reverting to primary model: ${error.message}`,
        )
        continue
      }
      log('error', `LLM call failed: ${err instanceof Error ? err.message : String(err)}`, JSON.stringify({
        model: { name: (activeModel as any).name || 'unknown', contextWindow: activeModel.contextWindow },
        messageCount: context.messages.length,
        estimatedTokens: totalMessageTokens(context.messages),
        error: err instanceof Error ? err.message : String(err),
      }, null, 2))
      return
    }

    sanitizeProviderContextMessages([response as unknown as Message])

    // Log rich LLM call metadata
    {
      const u = response.usage
      const costStr = u.cost.total < 0.001 ? '<$0.001' : `$${u.cost.total.toFixed(3)}`
      const inStr = u.input >= 1000 ? `${(u.input / 1000).toFixed(1)}k` : String(u.input)
      const outStr = u.output >= 1000 ? `${(u.output / 1000).toFixed(1)}k` : String(u.output)
      const summary = `${response.model} | ${inStr}/${outStr} tokens | ${costStr} | ${response.stopReason}`

      const textBlocks = response.content.filter(b => b.type === 'text').length
      const thinkingBlocks = response.content.filter(b => b.type === 'thinking').length
      const toolCallBlocks = response.content.filter(b => b.type === 'toolCall').length

      const detail = JSON.stringify({
        model: response.model,
        provider: response.provider,
        stopReason: response.stopReason,
        usage: {
          input: u.input,
          output: u.output,
          cacheRead: u.cacheRead,
          cacheWrite: u.cacheWrite,
          totalTokens: u.totalTokens,
          cost: u.cost,
        },
        context: {
          messageCount: context.messages.length,
          estimatedTokens: totalMessageTokens(context.messages),
          systemPromptTokens: context.systemPrompt ? estimateTokens(context.systemPrompt) : 0,
          recentMessages: summarizeContextForLog(context.messages),
        },
        content: {
          text: textBlocks,
          thinking: thinkingBlocks,
          toolCalls: toolCallBlocks,
        },
      }, null, 2)

      log('llm_call', summary, truncateForLog(detail, MAX_LLM_LOG_DETAIL_CHARS))
    }

    context.messages.push(response)

    const toolCalls = response.content.filter((c): c is ToolCall => c.type === 'toolCall')
    const fallbackToolCalls = extractFallbackToolCalls(response)
      .filter((fallback) => !toolCalls.some((call) =>
        call.name === fallback.name &&
        JSON.stringify(call.arguments || {}) === JSON.stringify(fallback.arguments || {}),
      ))
    const effectiveToolCalls = [...toolCalls, ...fallbackToolCalls]

    const reasoning = extractReasoningSummary(response)

    if (effectiveToolCalls.length === 0) {
      if (shouldRetryUninterpretableResponse(response) && uninterpretableResponseRetries < MAX_UNINTERPRETABLE_RESPONSE_RETRIES) {
        uninterpretableResponseRetries++
        log('system', 'LLM response was not interpretable; requesting one formatted retry')
        context.messages.push({
          role: 'user',
          content: [
            'Your previous response could not be interpreted reliably.',
            'Retry once now.',
            'If you need a tool, emit a valid tool call only.',
            'If no tool is needed, answer in plain text with one concrete next step.',
          ].join(' '),
          timestamp: Date.now(),
        })
        continue
      }
      if (reasoning) log('llm_thought', reasoning)
      return
    }

    const reason = shortenReasoning(reasoning)

    if (reasoning) log('llm_thought', reasoning)

    const toolCtx = {
      connection,
      profileId,
      log,
      todo: todo.value,
      gameState: currentGameState,
      onGameCommandResult: options?.onGameCommandResult,
    }
    const roundToolFingerprints: string[] = []
    const roundResultFingerprints: string[] = []
    let roundErrorCount = 0

    let showedReason = false
    for (const toolCall of effectiveToolCalls) {
      if (options?.signal?.aborted) return

      options?.onActivity?.(`Executing tool: ${toolCall.name}`)
      const callReason = !showedReason ? reason : undefined
      showedReason = true
      roundToolFingerprints.push(fingerprintToolCall(toolCall.name, toolCall.arguments))
      const result = await executeTool(toolCall.name, toolCall.arguments, toolCtx, callReason)
      currentGameState = toolCtx.gameState ?? null
      roundResultFingerprints.push(fingerprintResult(result))

      // If update_todo changed the todo via local tool, sync back
      todo.value = toolCtx.todo

      const isError = result.startsWith('Error')
      if (isError) roundErrorCount++
      const toolResultMessage: Message = buildToolResultMessage(toolCall, result)
      context.messages.push(toolResultMessage)

      const recoveryHint = detectImmediateRecoveryHint(toolCall.name, toolCall.arguments, result)
      if (recoveryHint) {
        log('system', `Immediate recovery triggered: ${recoveryHint.reason}`)

        const verification = await executeTool('game', { command: recoveryHint.suggestedStateCheck }, toolCtx, 'Immediate recovery state verification')
        const verificationMessage: Message = buildImmediateRecoveryMessage(
          recoveryHint.reason,
          recoveryHint.suggestedStateCheck,
          verification,
        )
        context.messages.push(verificationMessage)
        break
      }
    }

    advisorState = updateAdvisorStallState(advisorState, {
      toolSignature: roundToolFingerprints.join(' || '),
      resultSignature: roundResultFingerprints.join(' || '),
      hasErrors: roundErrorCount > 0,
      allErrored: roundToolFingerprints.length > 0 && roundErrorCount === roundToolFingerprints.length,
      isStatusOnly: isStatusOnlyRound(roundToolFingerprints),
    })

    rounds++

  }

  log('system', `Reached max tool rounds (${maxRounds}), ending turn`)
}

function truncateForLog(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n... (truncated for log storage)`
}

function shouldActivateAdvisor(state: AdvisorStallState, rounds: number): boolean {
  if (rounds < 2) return false
  return (
    state.stalledErrorRounds >= 2 ||
    state.repeatedRoundSignatureCount >= 2 ||
    state.stagnantRounds >= 3
  )
}

function describeAdvisorTrigger(state: AdvisorStallState): string {
  if (state.stalledErrorRounds >= 2) return `repeated blocked error rounds (${state.stalledErrorRounds})`
  if (state.repeatedRoundSignatureCount >= 2) return `repeated command loop (${state.repeatedRoundSignatureCount + 1} similar rounds)`
  if (state.stagnantRounds >= 3) return `stagnant results (${state.stagnantRounds + 1} rounds)`
  return 'stall detection'
}

export function shouldRetryUninterpretableResponse(response: AssistantMessage): boolean {
  const text = response.content
    .filter((block: any) => block.type === 'text' || block.type === 'thinking')
    .map((block: any) => {
      if (typeof block.text === 'string') return block.text
      if (typeof block.thinking === 'string') return block.thinking
      return ''
    })
    .join('\n')
    .trim()

  if (!text) return true

  const malformedToolPatterns = [
    /<tool_call>/i,
    /<function=/i,
    /"name"\s*:\s*"[a-z0-9_:-]+"/i,
    /"arguments"\s*:/i,
  ]
  const plainText = text.replace(/<[^>]+>/g, ' ').replace(/[{}[\]"]/g, ' ').replace(/\s+/g, ' ').trim()
  const looksLikeBrokenToolOutput = malformedToolPatterns.some((pattern) => pattern.test(text))

  return looksLikeBrokenToolOutput && plainText.length < 80
}

export function isSessionHistorySummaryMessage(msg: Message | undefined): boolean {
  return msg?.role === 'user'
    && typeof msg.content === 'string'
    && msg.content.startsWith('## Session History Summary')
}

function enforceContextMessageCap(context: Context): void {
  // Keep the initial mission message at index 0. If a compaction summary exists at
  // index 1, preserve it and trim from the oldest recent messages instead.
  while (context.messages.length > MAX_CONTEXT_MESSAGES) {
    if (context.messages.length <= 2) break
    const trimIndex = isSessionHistorySummaryMessage(context.messages[1]) ? 2 : 1
    if (trimIndex >= context.messages.length) break
    context.messages.splice(trimIndex, 1)
  }
}

function summarizeContextForLog(messages: Message[]): Array<Record<string, unknown>> {
  const recent = messages.slice(-MAX_LLM_LOG_MESSAGES)
  return recent.map(msg => {
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content : '(complex)'
      return { role: 'user', text: truncateForLog(text, MAX_LLM_LOG_TEXT_CHARS) }
    }
    if (msg.role === 'assistant') {
      const parts: string[] = []
      for (const b of msg.content) {
        if ('text' in b && (b as any).text?.trim()) {
          parts.push((b as any).text.trim())
        } else if ('name' in b) {
          const args = JSON.stringify((b as any).arguments || {})
          parts.push(`tool: ${(b as any).name}(${args})`)
        } else if ('thinking' in b && (b as any).thinking?.trim()) {
          parts.push(`thinking: ${(b as any).thinking.trim()}`)
        }
      }
      return { role: 'assistant', text: truncateForLog(parts.join(' | ') || '(empty)', MAX_LLM_LOG_TEXT_CHARS) }
    }
    if (msg.role === 'toolResult') {
      const text = Array.isArray(msg.content) ? msg.content.map((b: any) => b.text || '').join('') : ''
      return {
        role: 'toolResult',
        tool: msg.toolName,
        error: msg.isError || undefined,
        text: truncateForLog(text, MAX_LLM_LOG_TEXT_CHARS),
      }
    }
    return { role: (msg as any).role }
  })
}

// --- Context compaction ---

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function estimateMessageTokens(msg: Message): number {
  if (typeof msg.content === 'string') return estimateTokens(msg.content)
  if (Array.isArray(msg.content)) {
    let total = 0
    for (const block of msg.content) {
      if ('text' in block) total += estimateTokens((block as any).text)
      else if ('name' in block) total += estimateTokens((block as any).name + JSON.stringify((block as any).arguments))
      else if ('thinking' in block) total += estimateTokens((block as any).thinking)
    }
    return total
  }
  return 0
}

function totalMessageTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) total += estimateMessageTokens(msg)
  return total
}

function generateToolCallId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 9; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

function isValidProviderToolCallId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9]{9}$/.test(value)
}

function isValidProviderToolName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function sanitizeMessageToolIdentifiers(messages: Message[]): void {
  const fallbackIds = new Set<string>()
  const currentIds = new Set<string>()

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as any[]) {
      if (block?.type !== 'toolCall') continue
      if (typeof block.id === 'string' && block.id.startsWith('fallback-tool-')) {
        fallbackIds.add(block.id)
      }
      if (typeof block.id === 'string' && block.id.trim()) {
        currentIds.add(block.id)
      }
    }
  }

  const remap = new Map<string, string>()
  const usedIds = new Set(currentIds)
  const nextId = (): string => {
    let candidate = generateToolCallId()
    while (usedIds.has(candidate)) candidate = generateToolCallId()
    usedIds.add(candidate)
    return candidate
  }

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as any[]) {
      if (block?.type !== 'toolCall') continue
      const originalId = typeof block.id === 'string' ? block.id : ''
      if (isValidProviderToolCallId(originalId)) continue
      const replacement = remap.get(originalId) || nextId()
      remap.set(originalId, replacement)
      block.id = replacement
    }
  }

  if (remap.size === 0) return

  for (const msg of messages) {
    if (msg.role !== 'toolResult') continue
    const originalId = typeof (msg as any).toolCallId === 'string' ? (msg as any).toolCallId : ''
    const replacement = remap.get(originalId)
    if (replacement) {
      ;(msg as any).toolCallId = replacement
      continue
    }
    if (!isValidProviderToolCallId(originalId) && (!originalId || fallbackIds.has(originalId))) {
      ;(msg as any).toolCallId = nextId()
    }
  }
}

export function sanitizeAssistantToolCalls(messages: Message[]): void {
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue

    const rewrittenBlocks = (msg.content as any[]).map((block) => {
      if (block?.type !== 'toolCall') return block
      if (isValidProviderToolName(block.name)) return block

      const argsText = (() => {
        try {
          return JSON.stringify(block.arguments ?? {})
        } catch {
          return '{}'
        }
      })()

      return {
        type: 'text',
        text: `Dropped invalid tool call with missing name. Arguments: ${argsText}`,
      }
    })

    ;(msg as any).content = rewrittenBlocks
  }
}

export function sanitizeProviderMessageSequence(messages: Message[]): void {
  for (let i = 1; i < messages.length; i++) {
    const previous = messages[i - 1]
    const current = messages[i]
    if (previous.role !== 'toolResult' || current.role !== 'user') continue

    const text = typeof current.content === 'string'
      ? current.content
      : Array.isArray(current.content)
        ? current.content.map((block: any) => {
          if (typeof block?.text === 'string') return block.text
          if (typeof block?.thinking === 'string') return block.thinking
          return ''
        }).filter(Boolean).join('\n')
        : ''

    messages[i] = {
      role: 'assistant',
      content: [{ type: 'text', text: text || '(system recovery note)' }],
      timestamp: (current as any).timestamp ?? Date.now(),
    } as Message
  }
}

export function sanitizeTerminalAssistantMessage(messages: Message[]): void {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant' || !Array.isArray((last as any).content)) return
  if (messages.length < 2) return

  const previous = messages[messages.length - 2]
  if (previous?.role === 'toolResult') return

  const blocks = (last as any).content as any[]
  const hasToolCalls = blocks.some((block) => block?.type === 'toolCall')
  if (hasToolCalls) return

  messages.pop()
}

export function sanitizeProviderContextMessages(messages: Message[]): void {
  sanitizeAssistantToolCalls(messages)
  sanitizeMessageToolIdentifiers(messages)
  sanitizeProviderMessageSequence(messages)
  sanitizeTerminalAssistantMessage(messages)
}

function estimateRequestTokens(context: Context): number {
  const systemPromptTokens = context.systemPrompt ? estimateTokens(context.systemPrompt) : 0
  return systemPromptTokens
    + totalMessageTokens(context.messages)
    + REQUEST_TOOL_TOKEN_RESERVE
    + REQUEST_OUTPUT_TOKEN_RESERVE
}

function findTurnBoundary(messages: Message[], idx: number): number {
  for (let i = idx; i < messages.length; i++) {
    if (messages[i].role === 'user') return i
  }
  for (let i = idx - 1; i >= 1; i--) {
    if (messages[i].role === 'user') return i
  }
  return idx
}

function formatMessagesForSummary(messages: Message[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content : '(complex)'
      lines.push(`[USER] ${text}`)
    } else if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if ('text' in block && (block as any).text?.trim()) {
          lines.push(`[AGENT] ${(block as any).text.trim()}`)
        } else if ('name' in block) {
          const b = block as any
          const args = Object.entries((b.arguments || {}) as Record<string, unknown>)
            .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join(', ')
          lines.push(`[TOOL CALL] ${b.name}(${args})`)
        }
      }
    } else if (msg.role === 'toolResult') {
      const text = Array.isArray(msg.content)
        ? msg.content.map((b: any) => b.text || '').join('')
        : ''
      const trimmed = text.length > 500 ? text.slice(0, 500) + '...' : text
      const errorTag = msg.isError ? ' [ERROR]' : ''
      lines.push(`[RESULT${errorTag}] ${msg.toolName}: ${trimmed}`)
    }
  }
  return lines.join('\n')
}

async function compactContext(
  model: Model<any>,
  context: Context,
  compaction?: CompactionState,
  options?: LoopOptions,
  log?: LogFn,
  force = false,
): Promise<void> {
  // Proactively truncate oversized tool results to prevent token bloat
  for (const msg of context.messages) {
    if (msg.role === 'toolResult' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ('text' in block) {
          const text = (block as any).text
          if (typeof text === 'string' && text.length > 4000) {
            (block as any).text = text.slice(0, 3000) + '\n...(truncated)'
          }
        }
      }
    }
  }

  const baseRatio = options?.contextBudgetRatio ?? CONTEXT_BUDGET_RATIO
  const adaptive = getAdaptiveContextBudget(baseRatio)
  options?.onAdaptiveContext?.({ mode: adaptive.mode, effectiveRatio: adaptive.ratio, rssBytes: adaptive.rssBytes })
  const ratio = adaptive.ratio
  const effectiveLimit = getEffectiveContextLimit(model)
  const fixedCompactionThresholds = getFixedCompactionThresholds(model)
  const budget = Math.floor(effectiveLimit * ratio)
  const currentTokens = totalMessageTokens(context.messages)
  const estimatedRequestTokens = estimateRequestTokens(context)

  const hitSoftThreshold = fixedCompactionThresholds !== null
    && (currentTokens >= fixedCompactionThresholds.soft || estimatedRequestTokens >= fixedCompactionThresholds.soft)
  const hitHardThreshold = fixedCompactionThresholds !== null
    && estimatedRequestTokens >= fixedCompactionThresholds.hard

  if (
    !force &&
    !hitSoftThreshold &&
    !hitHardThreshold &&
    currentTokens < budget &&
    estimatedRequestTokens < effectiveLimit - REQUEST_TOKEN_SAFETY_MARGIN
  ) return

  const recentBudget = Math.floor(budget * 0.6)
  let recentTokens = 0
  let splitIdx = context.messages.length

  for (let i = context.messages.length - 1; i >= 1; i--) {
    const msgTokens = estimateMessageTokens(context.messages[i])
    if (recentTokens + msgTokens > recentBudget && splitIdx < context.messages.length - MIN_RECENT_MESSAGES) {
      break
    }
    recentTokens += msgTokens
    splitIdx = i
  }

  splitIdx = findTurnBoundary(context.messages, splitIdx)
  if (splitIdx <= 1) return

  const oldMessages = context.messages.slice(1, splitIdx)
  const recentMessages = context.messages.slice(splitIdx)

  let summary: string
  const summaryModel = options?.compactionModel || model
  try {
    summary = await summarizeViaLLM(summaryModel, oldMessages, compaction?.summary, options, log)
  } catch (err) {
    const canFallbackToPrimary = summaryModel !== model
    if (canFallbackToPrimary) {
      try {
        log?.(
          'system',
          'Primary model fallback for compaction activated after summarizer failure',
          JSON.stringify({
            phase: 'compaction_fallback',
            failedModel: ((summaryModel as any).name as string | undefined) || ((summaryModel as any).id as string | undefined) || 'unknown',
            fallbackModel: ((model as any).name as string | undefined) || ((model as any).id as string | undefined) || 'unknown',
            error: err instanceof Error ? err.message : String(err),
          }, null, 2),
        )
        summary = await summarizeViaLLM(model, oldMessages, compaction?.summary, {
          ...options,
          compactionApiKey: options?.apiKey || options?.failoverApiKey,
        }, log)
      } catch {
        summary = compaction?.summary
          ? compaction.summary + '\n\n(Additional context was lost due to summarization failure.)'
          : '(Earlier session context was lost.)'
      }
    } else {
      summary = compaction?.summary
        ? compaction.summary + '\n\n(Additional context was lost due to summarization failure.)'
        : '(Earlier session context was lost.)'
    }
  }

  if (compaction) compaction.summary = summary

  const summaryMessage: Message = {
    role: 'user' as const,
    content: `## Session History Summary\n\n${summary}\n\n---\nNow continue your mission. Recent events follow.`,
    timestamp: Date.now(),
  }

  context.messages = [context.messages[0], summaryMessage, ...recentMessages]
}

function getAdaptiveContextBudget(baseRatio: number): { ratio: number; mode: 'normal' | 'soft' | 'high' | 'critical'; rssBytes: number } {
  const clampedBase = Math.max(0.1, Math.min(baseRatio, 0.9))
  const rss = process.memoryUsage().rss

  // Keep default behavior under normal memory use, compress earlier under pressure.
  if (rss >= ADAPTIVE_RSS_CRITICAL_BYTES) return { ratio: Math.min(clampedBase, 0.20), mode: 'critical', rssBytes: rss }
  if (rss >= ADAPTIVE_RSS_HIGH_BYTES) return { ratio: Math.min(clampedBase, 0.30), mode: 'high', rssBytes: rss }
  if (rss >= ADAPTIVE_RSS_SOFT_BYTES) return { ratio: Math.min(clampedBase, 0.40), mode: 'soft', rssBytes: rss }
  return { ratio: clampedBase, mode: 'normal', rssBytes: rss }
}

async function summarizeViaLLM(
  model: Model<any>,
  oldMessages: Message[],
  previousSummary: string | undefined,
  options?: LoopOptions,
  log?: LogFn,
): Promise<string> {
  const transcript = formatMessagesForSummary(oldMessages)

  let prompt = 'Summarize this game session transcript. '
  prompt += 'Focus on: (1) what the agent was CURRENTLY DOING and what it planned to do next, '
  prompt += '(2) current location, credits, ship status, cargo, '
  prompt += '(3) active goals, key events, relationships. Be concise.\n\n'

  if (previousSummary) {
    prompt += 'Previous summary:\n' + previousSummary + '\n\n'
  }
  prompt += 'Transcript:\n' + transcript

  const summaryCtx: Context = {
    systemPrompt: 'You are a concise summarizer. Output only the summary, no preamble.',
    messages: [{ role: 'user' as const, content: prompt, timestamp: Date.now() }],
  }

  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), 30_000)
  const signal = options?.signal
    ? combineAbortSignals(options.signal, timeoutController.signal)
    : timeoutController.signal

  try {
    const modelName = ((model as any).name as string | undefined) || ((model as any).id as string | undefined) || 'unknown'
    log?.(
      'system',
      `Compacting context with summarizer model: ${modelName}`,
      JSON.stringify({
        phase: 'compaction_start',
        model: modelName,
        provider: resolveProviderName(model),
        baseUrl: resolveBaseUrl(model),
        oldMessageCount: oldMessages.length,
        transcriptTokens: estimateTokens(transcript),
        previousSummaryTokens: previousSummary ? estimateTokens(previousSummary) : 0,
      }, null, 2),
    )
    const resp = await complete(model, summaryCtx, {
      signal,
      apiKey: options?.compactionApiKey || options?.apiKey || (!options?.apiKey ? options?.failoverApiKey : undefined),
      maxTokens: SUMMARY_MAX_TOKENS,
    })
    clearTimeout(timeout)

    const text = resp.content
      .filter((b): b is { type: 'text'; text: string } => 'text' in b)
      .map(b => b.text)
      .join('')

    const normalizedText = text.trim() || extractFallbackSummaryText(resp.content)
    if (!normalizedText) {
      const reusedPreviousSummary = Boolean(previousSummary?.trim())
      const heuristic = buildHeuristicSummary(oldMessages, previousSummary)
      log?.(
        'system',
        reusedPreviousSummary
          ? 'Compaction summarizer returned empty output; reusing previous summary'
          : 'Compaction summarizer returned empty output; reusing heuristic summary',
        JSON.stringify({
          phase: 'compaction_empty_summary',
          model: resp.model,
          provider: resp.provider,
          previousSummaryAvailable: reusedPreviousSummary,
          reusedPreviousSummary,
          heuristicLength: heuristic.length,
          stopReason: resp.stopReason,
          usage: resp.usage,
          responseDiagnostics: extractCompactionResponseDiagnostics(resp.content),
        }, null, 2),
      )
      return heuristic
    }
    log?.(
      'llm_call',
      `compaction/${resp.model} | ${resp.usage.input}/${resp.usage.output} tokens | ${resp.stopReason}`,
      JSON.stringify({
        phase: 'compaction_result',
        model: resp.model,
        provider: resp.provider,
        stopReason: resp.stopReason,
        usage: resp.usage,
        usedFallbackText: !text.trim(),
      }, null, 2),
    )
    return normalizedText
  } catch (err) {
    clearTimeout(timeout)
    log?.(
      'error',
      `Compaction LLM failed: ${err instanceof Error ? err.message : String(err)}`,
      JSON.stringify({
        phase: 'compaction_error',
        model: ((model as any).name as string | undefined) || ((model as any).id as string | undefined) || 'unknown',
        provider: resolveProviderName(model),
        baseUrl: resolveBaseUrl(model),
        error: err instanceof Error ? err.message : String(err),
        responseDiagnostics: extractCompactionErrorDiagnostics(err),
      }, null, 2),
    )
    throw err
  }
}

export function extractFallbackSummaryText(content: AssistantMessage['content']): string {
  const parts: string[] = []
  for (const block of content as any[]) {
    if (typeof block?.thinking === 'string' && block.thinking.trim()) {
      parts.push(block.thinking.trim())
      continue
    }
    if (typeof block?.text === 'string' && block.text.trim()) {
      parts.push(block.text.trim())
      continue
    }
  }

  if (parts.length === 0) return ''

  return parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function buildHeuristicSummary(oldMessages: Message[], previousSummary?: string): string {
  if (previousSummary?.trim()) return previousSummary.trim()

  const lines: string[] = []
  const recent = oldMessages.slice(-12)
  for (const msg of recent) {
    if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
      const compact = truncateForLog(msg.content.trim().replace(/\s+/g, ' '), 220)
      lines.push(`Context: ${compact}`)
      continue
    }
    if (msg.role === 'toolResult') {
      const text = Array.isArray(msg.content)
        ? msg.content.map((block: any) => block.text || '').join(' ').trim()
        : ''
      if (!text) continue
      lines.push(`${msg.toolName}: ${truncateForLog(text.replace(/\s+/g, ' '), 220)}`)
    }
  }

  if (lines.length === 0) return 'Recent session context unavailable; resume from fresh verified state.'
  return lines.slice(-6).join('\n')
}

export function extractCompactionResponseDiagnostics(content: AssistantMessage['content']): Record<string, unknown> | null {
  if (!Array.isArray(content) || content.length === 0) return null

  return {
    blockCount: content.length,
    blockTypes: content.map((block: any) => block?.type || inferBlockType(block)),
    blocks: content.slice(0, 8).map((block: any) => ({
      type: block?.type || inferBlockType(block),
      hasText: typeof block?.text === 'string' && block.text.trim().length > 0,
      textPreview: typeof block?.text === 'string' ? truncateForLog(block.text.trim(), 160) : undefined,
      hasThinking: typeof block?.thinking === 'string' && block.thinking.trim().length > 0,
      thinkingPreview: typeof block?.thinking === 'string' ? truncateForLog(block.thinking.trim(), 160) : undefined,
      hasToolName: typeof block?.name === 'string' && block.name.trim().length > 0,
    })),
  }
}

function extractCompactionErrorDiagnostics(err: unknown): Record<string, unknown> | null {
  const anyErr = err as any
  const resp = anyErr?.response || anyErr?.resp || anyErr?.result
  const content = Array.isArray(resp?.content) ? resp.content : Array.isArray(anyErr?.content) ? anyErr.content : null
  return extractCompactionResponseDiagnostics(content)
}

function inferBlockType(block: any): string {
  if (typeof block?.type === 'string' && block.type) return block.type
  if (typeof block?.text === 'string') return 'text'
  if (typeof block?.thinking === 'string') return 'thinking'
  if (typeof block?.name === 'string') return 'toolCall'
  return 'unknown'
}

// --- LLM call with retry ---

async function completeWithRetry(
  model: Model<any>,
  context: Context,
  profileId: string,
  log: LogFn,
  options?: LoopOptions,
  compaction?: CompactionState,
): Promise<AssistantMessage> {
  let lastError: Error | null = null
  sanitizeProviderContextMessages(context.messages)
  const primaryKey = options?.apiKey
  const failoverKey = options?.failoverApiKey
  // Always try primary first when available; failover is activated on demand.
  let useFailover = !primaryKey && !!failoverKey
  let moderationRemediations = 0
  let contextOverflowRemediations = 0

  const timeoutMs = options?.llmTimeoutMs || DEFAULT_LLM_TIMEOUT_MS
  const messageCount = context.messages.length
  const estimatedTokens = totalMessageTokens(context.messages)
  const modelName = ((model as any).name as string | undefined) || 'unknown'
  const providerName = modelName.includes('/') ? modelName.split('/')[0] : undefined
  const existing = options?.resumeRequest
  const request = existing
    ? { id: existing.id, idempotencyKey: existing.idempotencyKey }
    : enqueueLlmRequest({
      profileId,
      idempotencyKey: `admiral-${profileId}-${Date.now()}-${crypto.randomUUID()}`,
      modelName,
      providerName,
      systemPrompt: context.systemPrompt || '',
      messagesJson: JSON.stringify(context.messages),
      messageCount,
      estimatedTokens,
    })
  const idempotencyKey = request.idempotencyKey

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      sanitizeProviderContextMessages(context.messages)
      if (options?.compactInputEnabled) {
        const beforeEstimatedRequestTokens = estimateRequestTokens(context)
        const effectiveLimit = getEffectiveContextLimit(model)
        const fixedCompactionThresholds = getFixedCompactionThresholds(model)
        const shouldCompactForFixedThreshold = fixedCompactionThresholds !== null
          && beforeEstimatedRequestTokens >= fixedCompactionThresholds.soft
        if (shouldCompactForFixedThreshold || beforeEstimatedRequestTokens >= effectiveLimit - REQUEST_TOKEN_SAFETY_MARGIN) {
          const beforeCount = context.messages.length
          const beforeTokens = totalMessageTokens(context.messages)
          await compactContext(model, context, compaction, options, log, true)
          const afterCount = context.messages.length
          const afterTokens = totalMessageTokens(context.messages)
          const afterEstimatedRequestTokens = estimateRequestTokens(context)
          log(
            'system',
            'Preflight context compaction applied before LLM request',
            JSON.stringify({
              before: {
                messageCount: beforeCount,
                estimatedTokens: beforeTokens,
                estimatedRequestTokens: beforeEstimatedRequestTokens,
              },
              after: {
                messageCount: afterCount,
                estimatedTokens: afterTokens,
                estimatedRequestTokens: afterEstimatedRequestTokens,
              },
              effectiveContextLimit: effectiveLimit,
            }, null, 2),
          )
        }
      }
      sanitizeProviderContextMessages(context.messages)
      markLlmRequestProcessing(request.id, (existing?.attemptCount || 0) + attempt + 1)
      const timeoutController = new AbortController()
      const timeout = setTimeout(() => timeoutController.abort(), timeoutMs)

      const signal = options?.signal
        ? combineAbortSignals(options.signal, timeoutController.signal)
        : timeoutController.signal

      try {
        const apiKeyForAttempt = useFailover ? failoverKey : primaryKey
        const modelForAttempt = useFailover && options?.failoverModel ? options.failoverModel : model
        const modelForAttemptName = ((modelForAttempt as any).name as string | undefined) || ((modelForAttempt as any).id as string | undefined) || 'unknown'
        if (attempt > 0 && useFailover && failoverKey) {
          log('system', `Using profile failover model (attempt ${attempt + 1}/${MAX_RETRIES}): ${modelForAttemptName}`)
        }
        const result = await complete(modelForAttempt, context, {
          signal,
          apiKey: apiKeyForAttempt,
          maxTokens: 4096,
          idempotencyKey,
        })
        clearTimeout(timeout)

        if (result.stopReason === 'error') {
          throw new Error(result.errorMessage || 'LLM returned an error response')
        }
        if (result.content.length === 0) {
          throw new Error('LLM returned empty response')
        }

        if (options?.failoverActive && !useFailover) {
          options.onPrimaryRecovered?.()
        }

        markLlmRequestSucceeded(request.id, result.model, result.stopReason)
        return result
      } catch (err) {
        clearTimeout(timeout)
        if (timeoutController.signal.aborted && !options?.signal?.aborted) {
          throw new Error(`LLM call timed out after ${timeoutMs / 1000}s`)
        }
        throw err
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (options?.signal?.aborted) throw lastError
      const errorType = classifyLlmError(lastError)

      // Emergency compaction: if "prompt is too long", force-compact context
      const isOverflow = lastError.message.includes('prompt is too long') ||
        lastError.message.includes('too many tokens') ||
        lastError.message.includes('maximum context length')
      if (isOverflow && context.messages.length > 4) {
        log('system', `Emergency compaction: context overflow detected (${context.messages.length} messages). Force-compacting...`)
        const compactModel = options?.compactionModel || model
        await emergencyCompact(compactModel, context, compaction, options)
        log('system', `Emergency compaction complete: ${context.messages.length} messages, ~${totalMessageTokens(context.messages)} tokens`)
      }

      if (options?.compactInputEnabled && isContextOverflowError(lastError) && contextOverflowRemediations < 2) {
        const beforeCount = context.messages.length
        const beforeTokens = totalMessageTokens(context.messages)
        try {
          await compactContext(model, context, compaction, options, log, true)
          const afterCount = context.messages.length
          const afterTokens = totalMessageTokens(context.messages)
          if (afterCount < beforeCount || afterTokens < beforeTokens) {
            contextOverflowRemediations++
            log(
              'system',
              'Context overflow detected; summarized context and retrying request',
              JSON.stringify(
                {
                  attempt: attempt + 1,
                  before: { messageCount: beforeCount, estimatedTokens: beforeTokens },
                  after: { messageCount: afterCount, estimatedTokens: afterTokens },
                  error: lastError.message,
                },
                null,
                2,
              ),
            )
            attempt--
            continue
          }
        } catch {
          // fall through to standard retry path
        }
      }

      if (isModerationBlock(lastError)) {
        const moderationInfo = analyzeModerationContext(context)
        log(
          'system',
          `Moderation diagnostic: ${moderationInfo.summary}`,
          JSON.stringify(moderationInfo, null, 2),
        )
        if (moderationRemediations < MAX_MODERATION_REMEDIATIONS) {
          const changed = applyModerationRemediation(context)
          moderationRemediations++
          if (changed) {
            log('system', 'Applied moderation remediation; retrying request with sanitized context')
            attempt--
            continue
          }
        }
      }

      if (!useFailover && primaryKey && failoverKey && shouldFailover(lastError)) {
        useFailover = true
        const failoverModelName = options?.failoverModel
          ? (((options.failoverModel as any).name as string | undefined) || ((options.failoverModel as any).id as string | undefined) || 'unknown')
          : 'unknown'
        log('system', `Switching to profile failover model due to rate limit or provider reachability issue: ${failoverModelName}`)
        options?.onFailoverActivated?.()
      }

      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt)
      if (attempt < MAX_RETRIES - 1) {
        markLlmRequestRetryableError(request.id, lastError.message)
      }
      const providerErrorMeta = errorType === 'provider_error'
        ? extractProviderErrorMeta(lastError)
        : undefined
      const errorLabel = errorType === 'aborted' ? 'LLM aborted'
        : errorType === 'timeout' ? 'LLM timeout'
        : 'LLM error'
      log('error', `${errorLabel} (attempt ${attempt + 1}/${MAX_RETRIES}): ${lastError.message}`, JSON.stringify({
        requestId: request.id,
        idempotencyKey,
        model: { name: (model as any).name || 'unknown', contextWindow: model.contextWindow },
        attemptRouting: {
          path: useFailover ? 'failover' : 'primary',
          provider: resolveProviderName(useFailover && options?.failoverModel ? options.failoverModel : model),
          model: ((useFailover && options?.failoverModel ? options.failoverModel : model) as any).name
            || ((useFailover && options?.failoverModel ? options.failoverModel : model) as any).id
            || 'unknown',
          baseUrl: resolveBaseUrl(useFailover && options?.failoverModel ? options.failoverModel : model),
        },
        messageCount: context.messages.length,
        estimatedTokens: totalMessageTokens(context.messages),
        attempt: attempt + 1,
        maxRetries: MAX_RETRIES,
        errorType,
        providerErrorMeta,
        error: lastError.message,
      }, null, 2))
      await sleep(delay)
    }
  }

  markLlmRequestFailed(request.id, lastError?.message || 'LLM call failed after retries')
  throw lastError || new Error('LLM call failed after retries')
}

/**
 * Emergency compaction: aggressively trim context when API reports overflow.
 * Keeps only the last ~30% of messages and truncates large tool results.
 */
async function emergencyCompact(
  model: Model<any>,
  context: Context,
  compaction?: CompactionState,
  options?: LoopOptions,
): Promise<void> {
  // First, truncate oversized tool results in-place
  for (const msg of context.messages) {
    if (msg.role === 'toolResult' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ('text' in block) {
          const text = (block as any).text
          if (typeof text === 'string' && text.length > 2000) {
            (block as any).text = text.slice(0, 1500) + '\n...(truncated)'
          }
        }
      }
    }
  }

  // Keep only last 30% of messages (at least MIN_RECENT_MESSAGES)
  const keepCount = Math.max(MIN_RECENT_MESSAGES, Math.floor(context.messages.length * 0.3))
  if (context.messages.length <= keepCount + 1) return

  const splitIdx = findTurnBoundary(context.messages, context.messages.length - keepCount)
  if (splitIdx <= 1) return

  const oldMessages = context.messages.slice(1, splitIdx)
  const recentMessages = context.messages.slice(splitIdx)

  let summary: string
  try {
    summary = await summarizeViaLLM(model, oldMessages, compaction?.summary, options)
  } catch {
    // Last resort: just drop old messages without summarizing
    summary = compaction?.summary || '(Earlier session context was dropped due to overflow.)'
  }

  if (compaction) compaction.summary = summary

  const summaryMessage: Message = {
    role: 'user' as const,
    content: `## Session History Summary (emergency compaction)\n\n${summary}\n\n---\nContinue your mission. Recent events follow.`,
    timestamp: Date.now(),
  }

  context.messages = [context.messages[0], summaryMessage, ...recentMessages]
}

function isContextOverflowError(err: Error): boolean {
  const msg = (err.message || '').toLowerCase()
  return msg.includes('context_length_exceeded')
    || msg.includes('too many tokens')
    || msg.includes('maximum context length')
    || msg.includes('prompt is too long')
    || (msg.includes('token') && msg.includes('limit'))
}

type RateRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

interface RateRiskAssessment {
  level: RateRiskLevel
  reason: string
  recommendation: string
  callsLast60s: number
  errors429Last60s: number
  errors429Last300s: number
  failoverActivationsLast300s: number
}

export function predict429Risk(profileId: string): RateRiskAssessment {
  const s = getLlmRateWindowStats(profileId)

  if (s.errors429Last60s >= 1 || s.callsLast60s >= 8) {
    return {
      level: 'HIGH',
      reason: `recent 429=${s.errors429Last60s} in 60s or call rate=${s.callsLast60s}/min`,
      recommendation: 'Throttle this profile for 15-30s before next LLM call.',
      ...s,
    }
  }

  if (s.errors429Last300s >= 2 || s.failoverActivationsLast300s >= 1 || s.callsLast60s >= 5) {
    return {
      level: 'MEDIUM',
      reason: `elevated pressure (calls=${s.callsLast60s}/min, 429/5m=${s.errors429Last300s}, failovers/5m=${s.failoverActivationsLast300s})`,
      recommendation: 'Reduce call frequency and prefer shorter turns for 1-2 minutes.',
      ...s,
    }
  }

  return {
    level: 'LOW',
    reason: 'stable call rate and no recent 429 signals',
    recommendation: 'No throttling needed.',
    ...s,
  }
}

export function is429PredictionEnabled(): boolean {
  const pref = getPreference('predict_429_enabled')
  if (pref == null || pref === '') return true
  return pref === 'true'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function shouldFailover(err: Error): boolean {
  const msg = (err.message || '').toLowerCase()
  if (msg.includes('429')) return true
  if (msg.includes('rate limit')) return true
  if (msg.includes('too many requests')) return true
  if (msg.includes('402')) return true
  if (msg.includes('payment required')) return true
  if (msg.includes('spend limit exceeded')) return true
  if (msg.includes('usd spend limit exceeded')) return true
  if (msg.includes('insufficient credits')) return true

  // Treat transport/connectivity failures as "provider unreachable"
  if (msg.includes('fetch failed')) return true
  if (msg.includes('network error')) return true
  if (msg.includes('network request failed')) return true
  if (msg.includes('timeout')) return true
  if (msg.includes('timed out')) return true
  if (msg.includes('econnrefused')) return true
  if (msg.includes('enotfound')) return true
  if (msg.includes('eai_again')) return true
  if (msg.includes('socket hang up')) return true
  if (msg.includes('connection reset')) return true
  if (msg.includes('no body')) return true
  if (msg.includes('internal server error')) return true
  if (msg.includes('bad gateway')) return true
  if (msg.includes('service unavailable')) return true
  if (msg.includes('gateway timeout')) return true
  if (/\b5\d\d\b/.test(msg)) return true

  return false
}

function shouldFallbackFromAlternativeModel(err: Error): boolean {
  return shouldFailover(err)
}

function isModerationBlock(err: Error): boolean {
  const msg = (err.message || '').toLowerCase()
  return msg.includes('requires moderation on openinference')
    || msg.includes('flagged for "illicit/violent"')
    || (msg.includes('403') && msg.includes('moderation'))
}

function applyModerationRemediation(context: Context): boolean {
  let changed = false

  const riskyWords = [
    ['combat', 'strategy'],
    ['attack', 'engage'],
    ['destroy', 'disable'],
    ['kill', 'eliminate'],
    ['weapon', 'module'],
    ['assault', 'operation'],
    ['war', 'campaign'],
    ['violent', 'aggressive'],
    ['illicit', 'restricted'],
    ['illegal', 'restricted'],
    ['hack', 'optimize'],
    ['exploit', 'optimize'],
    ['steal', 'acquire'],
  ] as const

  const sanitizeText = (input: string): string => {
    let out = input
    for (const [from, to] of riskyWords) {
      const rx = new RegExp(`\\b${from}\\b`, 'gi')
      out = out.replace(rx, to)
    }
    return out
  }

  const remediated: Message[] = []
  for (const msg of context.messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const toolBlocks = msg.content.filter((b: any) => 'name' in b)
      if (toolBlocks.length !== msg.content.length) changed = true
      if (toolBlocks.length > 0) {
        remediated.push({ ...msg, content: toolBlocks as any })
      } else {
        remediated.push({
          ...msg,
          content: [{ type: 'text', text: 'Proceeding with safe, non-sensitive planning.' }] as any,
        })
      }
      continue
    }

    if (msg.role === 'user' && typeof msg.content === 'string') {
      const next = sanitizeText(msg.content)
      if (next !== msg.content) changed = true
      remediated.push({ ...msg, content: next })
      continue
    }

    remediated.push(msg)
  }

  // Additional safety: compress history when context is large.
  if (remediated.length > 40) {
    const head = remediated.slice(0, 1)
    const tail = remediated.slice(-30)
    context.messages = [...head, ...tail]
    changed = true
  } else {
    context.messages = remediated
  }

  return changed
}

interface ModerationDiagnostic {
  summary: string
  messageCount: number
  estimatedTokens: number
  assistantThinkingMessages: number
  violentKeywordHits: number
  illicitKeywordHits: number
  sampleMatches: string[]
  recommendation: string
}

function analyzeModerationContext(context: Context): ModerationDiagnostic {
  const recent = summarizeContextForLog(context.messages)
  const joined = recent
    .map(m => String((m as Record<string, unknown>).text || ''))
    .join('\n')
    .toLowerCase()

  const violentKeywords = [
    'kill', 'weapon', 'attack', 'violent', 'combat', 'destroy',
    'assault', 'war', 'blood', 'murder',
  ]
  const illicitKeywords = [
    'exploit', 'abuse', 'bypass', 'steal', 'hack', 'fraud',
    'illegal', 'illicit', 'cheat',
  ]

  const violentHits = countKeywordHits(joined, violentKeywords)
  const illicitHits = countKeywordHits(joined, illicitKeywords)
  const assistantThinkingMessages = recent.filter(m => {
    const text = String((m as Record<string, unknown>).text || '')
    return text.startsWith('thinking:')
  }).length

  const sampleMatches = collectKeywordMatches(joined, [...violentKeywords, ...illicitKeywords], 6)
  const tokens = totalMessageTokens(context.messages)

  let summary = 'likely false positive from long context/tool transcript'
  let recommendation = 'Reduce context size and keep reasoning text concise.'
  if (violentHits + illicitHits >= 4) {
    summary = 'likely triggered by sensitive wording in recent context'
    recommendation = 'Avoid sensitive wording in directives and assistant reasoning.'
  }

  return {
    summary,
    messageCount: context.messages.length,
    estimatedTokens: tokens,
    assistantThinkingMessages,
    violentKeywordHits: violentHits,
    illicitKeywordHits: illicitHits,
    sampleMatches,
    recommendation,
  }
}

function countKeywordHits(text: string, keywords: string[]): number {
  let hits = 0
  for (const kw of keywords) {
    const rx = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
    const m = text.match(rx)
    hits += m ? m.length : 0
  }
  return hits
}

function collectKeywordMatches(text: string, keywords: string[], limit: number): string[] {
  const out: string[] = []
  for (const kw of keywords) {
    if (out.length >= limit) break
    const rx = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (rx.test(text)) out.push(kw)
  }
  return out
}

function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

function classifyLlmError(err: Error): 'aborted' | 'timeout' | 'provider_error' {
  const msg = (err.message || '').toLowerCase()
  if (msg.includes('timed out')) return 'timeout'
  if (msg.includes('aborted') || msg.includes('aborterror')) return 'aborted'
  return 'provider_error'
}

function extractProviderErrorMeta(err: Error): {
  statusCode?: number
  is5xx?: boolean
  noBody?: boolean
  code?: string
  name?: string
} {
  const anyErr = err as any
  const msg = String(err.message || '')
  const msgLower = msg.toLowerCase()

  // Parse patterns like "500 status code (no body)".
  const statusFromMsg = (() => {
    const m = msg.match(/\b([1-5]\d\d)\b/)
    if (!m) return undefined
    const code = Number(m[1])
    return Number.isFinite(code) ? code : undefined
  })()

  const statusCode =
    (typeof anyErr.status === 'number' ? anyErr.status : undefined)
    ?? (typeof anyErr.statusCode === 'number' ? anyErr.statusCode : undefined)
    ?? statusFromMsg

  return {
    statusCode,
    is5xx: typeof statusCode === 'number' ? statusCode >= 500 && statusCode <= 599 : undefined,
    noBody: msgLower.includes('no body'),
    code: typeof anyErr.code === 'string' ? anyErr.code : undefined,
    name: typeof anyErr.name === 'string' ? anyErr.name : undefined,
  }
}

function resolveProviderName(model: Model<any>): string {
  const provider = (model as any).provider
  if (typeof provider === 'string' && provider.trim()) return provider

  const name = ((model as any).name as string | undefined) || ((model as any).id as string | undefined) || ''
  if (name.includes('/')) return name.split('/')[0]
  return 'unknown'
}

function resolveBaseUrl(model: Model<any>): string | undefined {
  const baseUrl = (model as any).baseUrl
  return typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl : undefined
}

function getEffectiveContextLimit(model: Model<any>): number {
  const configured = typeof model.contextWindow === 'number' && Number.isFinite(model.contextWindow)
    ? model.contextWindow
    : 128_000
  const provider = resolveProviderName(model).toLowerCase()
  const modelName = (((model as any).name as string | undefined) || ((model as any).id as string | undefined) || '').toLowerCase()

  if (provider === 'openrouter' && (modelName.includes('free models router') || modelName.includes('openrouter/free'))) {
    return 40_960
  }

  return configured
}

function getFixedCompactionThresholds(model: Model<any>): { soft: number; hard: number } | null {
  const provider = resolveProviderName(model).toLowerCase()
  const modelName = (((model as any).name as string | undefined) || ((model as any).id as string | undefined) || '').toLowerCase()

  if (provider === 'openrouter' && (modelName.includes('free models router') || modelName.includes('openrouter/free'))) {
    return {
      soft: OPENROUTER_FREE_SOFT_COMPACTION_TOKENS,
      hard: OPENROUTER_FREE_HARD_COMPACTION_TOKENS,
    }
  }

  return null
}
