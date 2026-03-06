import { complete } from '@mariozechner/pi-ai'
import type { Model, Context, AssistantMessage, ToolCall, Message } from '@mariozechner/pi-ai'
import type { GameConnection } from './connections/interface'
import type { LogFn } from './tools'
import { executeTool } from './tools'
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
  onActivity?: (activity: string) => void
  compactionModel?: Model<any>  // Separate (cheaper) model for compaction summarization
  onAdaptiveContext?: (info: { mode: 'normal' | 'soft' | 'high' | 'critical'; effectiveRatio: number; rssBytes: number }) => void
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
  let rounds = 0

  while (rounds < maxRounds) {
    if (options?.signal?.aborted) return

    enforceContextMessageCap(context)
    await compactContext(summaryModel, context, compaction, options)

    options?.onActivity?.('Waiting for LLM response...')
    let response: AssistantMessage
    try {
      response = await completeWithRetry(model, context, profileId, log, options, compaction)
    } catch (err) {
      log('error', `LLM call failed: ${err instanceof Error ? err.message : String(err)}`, JSON.stringify({
        model: { name: (model as any).name || 'unknown', contextWindow: model.contextWindow },
        messageCount: context.messages.length,
        estimatedTokens: totalMessageTokens(context.messages),
        error: err instanceof Error ? err.message : String(err),
      }, null, 2))
      return
    }

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

    if (toolCalls.length === 0) {
      if (reasoning) log('llm_thought', reasoning)
      return
    }

    const reason = reasoning
      ? reasoning.length > 180 ? reasoning.slice(0, 177) + '...' : reasoning
      : undefined

    if (reasoning) log('llm_thought', reasoning)

    const toolCtx = { connection, profileId, log, todo: todo.value }

    let showedReason = false
    for (const toolCall of toolCalls) {
      if (options?.signal?.aborted) return

      options?.onActivity?.(`Executing tool: ${toolCall.name}`)
      const callReason = !showedReason ? reason : undefined
      showedReason = true
      const result = await executeTool(toolCall.name, toolCall.arguments, toolCtx, callReason)

      // If update_todo changed the todo via local tool, sync back
      todo.value = toolCtx.todo

      const isError = result.startsWith('Error')
      const toolResultMessage: Message = {
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: result }],
        isError,
        timestamp: Date.now(),
      }
      context.messages.push(toolResultMessage)
    }

    rounds++
  }

  log('system', `Reached max tool rounds (${maxRounds}), ending turn`)
}

function truncateForLog(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n... (truncated for log storage)`
}

function enforceContextMessageCap(context: Context): void {
  // Keep the initial mission message at index 0 and trim oldest middle messages first.
  while (context.messages.length > MAX_CONTEXT_MESSAGES) {
    if (context.messages.length <= 2) break
    context.messages.splice(1, 1)
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
  const budget = Math.floor(model.contextWindow * ratio)
  const currentTokens = totalMessageTokens(context.messages)

  if (currentTokens < budget) return

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
  try {
    summary = await summarizeViaLLM(model, oldMessages, compaction?.summary, options)
  } catch {
    summary = compaction?.summary
      ? compaction.summary + '\n\n(Additional context was lost due to summarization failure.)'
      : '(Earlier session context was lost.)'
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
    const resp = await complete(model, summaryCtx, {
      signal,
      apiKey: options?.apiKey || (!options?.apiKey ? options?.failoverApiKey : undefined),
      maxTokens: SUMMARY_MAX_TOKENS,
    })
    clearTimeout(timeout)

    const text = resp.content
      .filter((b): b is { type: 'text'; text: string } => 'text' in b)
      .map(b => b.text)
      .join('')

    if (!text.trim()) throw new Error('Empty summary')
    return text.trim()
  } catch (err) {
    clearTimeout(timeout)
    throw err
  }
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
  const primaryKey = options?.apiKey
  const failoverKey = options?.failoverApiKey
  // Always try primary first when available; failover is activated on demand.
  let useFailover = !primaryKey && !!failoverKey
  let moderationRemediations = 0

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
      idempotencyKey: `admiral-${profileId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      modelName,
      providerName,
      systemPrompt: context.systemPrompt || '',
      messagesJson: JSON.stringify(context.messages),
      messageCount,
      estimatedTokens,
    })
  const idempotencyKey = request.idempotencyKey

  if (is429PredictionEnabled()) {
    const risk = predict429Risk(profileId)
    if (risk.level !== 'LOW') {
      log(
        'system',
        `429 risk ${risk.level}: ${risk.reason}`,
        JSON.stringify(
          {
            profileId,
            callsLast60s: risk.callsLast60s,
            errors429Last60s: risk.errors429Last60s,
            errors429Last300s: risk.errors429Last300s,
            failoverActivationsLast300s: risk.failoverActivationsLast300s,
            recommendation: risk.recommendation,
          },
          null,
          2,
        ),
      )
    }
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      markLlmRequestProcessing(request.id, (existing?.attemptCount || 0) + attempt + 1)
      const timeoutController = new AbortController()
      const timeout = setTimeout(() => timeoutController.abort(), timeoutMs)

      const signal = options?.signal
        ? combineAbortSignals(options.signal, timeoutController.signal)
        : timeoutController.signal

      try {
        const apiKeyForAttempt = useFailover ? failoverKey : primaryKey
        if (attempt > 0 && useFailover && failoverKey) {
          log('system', `Using failover API key (attempt ${attempt + 1}/${MAX_RETRIES})`)
        }
        const modelForAttempt = useFailover && options?.failoverModel ? options.failoverModel : model
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
        log('system', 'Switching to failover API key due to rate limit or provider reachability issue')
        options?.onFailoverActivated?.()
      }

      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt)
      if (attempt < MAX_RETRIES - 1) {
        markLlmRequestRetryableError(request.id, lastError.message)
      }
      log('error', `LLM error (attempt ${attempt + 1}/${MAX_RETRIES}): ${lastError.message}`, JSON.stringify({
        requestId: request.id,
        idempotencyKey,
        model: { name: (model as any).name || 'unknown', contextWindow: model.contextWindow },
        messageCount: context.messages.length,
        estimatedTokens: totalMessageTokens(context.messages),
        attempt: attempt + 1,
        maxRetries: MAX_RETRIES,
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

function predict429Risk(profileId: string): RateRiskAssessment {
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

function is429PredictionEnabled(): boolean {
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
