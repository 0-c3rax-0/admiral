import { Type, StringEnum } from '@mariozechner/pi-ai'
import type { Tool } from '@mariozechner/pi-ai'
import type { GameConnection } from './connections/interface'
import { getProfile, updateProfile } from './db'
import { fetchGameCommands } from './schema'

// --- Tool Definitions ---

export const allTools: Tool[] = [
  {
    name: 'game',
    description: 'Execute a SpaceMolt game command. See the system prompt for available commands.',
    parameters: Type.Object({
      command: Type.String({ description: 'The game command name (e.g. mine, travel, get_status)' }),
      args: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: 'Command arguments as key-value pairs' })),
    }),
  },
  {
    name: 'save_credentials',
    description: 'Save your login credentials locally. Do this IMMEDIATELY after registering!',
    parameters: Type.Object({
      username: Type.String({ description: 'Your username' }),
      password: Type.String({ description: 'Your password (256-bit hex)' }),
      empire: Type.String({ description: 'Your empire' }),
      player_id: Type.String({ description: 'Your player ID' }),
    }),
  },
  {
    name: 'update_todo',
    description: 'Update your local TODO list to track goals and progress.',
    parameters: Type.Object({
      content: Type.String({ description: 'Full TODO list content (replaces existing)' }),
    }),
  },
  {
    name: 'read_todo',
    description: 'Read your current TODO list.',
    parameters: Type.Object({}),
  },
  {
    name: 'status_log',
    description: 'Log a status message visible to the human watching.',
    parameters: Type.Object({
      category: StringEnum(['mining', 'travel', 'combat', 'trade', 'chat', 'info', 'craft', 'faction', 'mission', 'setup'], {
        description: 'Message category',
      }),
      message: Type.String({ description: 'Status message' }),
    }),
  },
]

const LOCAL_TOOLS = new Set(['save_credentials', 'update_todo', 'read_todo', 'status_log'])

const MAX_RESULT_CHARS = 4000
const MAX_TOOL_RESULT_LOG_DETAIL_CHARS = 8000
const COMMAND_SUGGEST_CACHE_TTL_MS = 5 * 60 * 1000
const commandSuggestCache = new Map<string, { expiresAt: number; names: string[] }>()

export type LogFn = (type: string, summary: string, detail?: string) => void

export interface ImmediateRecoveryHint {
  reason: string
  suggestedStateCheck: 'get_status'
}

interface ToolContext {
  connection: GameConnection
  profileId: string
  log: LogFn
  todo: string
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  reason?: string,
): Promise<string> {
  if (LOCAL_TOOLS.has(name)) {
    ctx.log('tool_call', `${name}(${formatArgs(args)})`)
    return executeLocalTool(name, args, ctx)
  }

  let command: string
  let commandArgs: Record<string, unknown> | undefined
  if (name === 'game') {
    command = String(args.command || '')
    commandArgs = args.args as Record<string, unknown> | undefined
    command = sanitizeCommandName(command)
    if (!command) return 'Error: missing \'command\' argument'
    const resolved = await resolveCommandName(ctx.profileId, command, ctx.connection)
    if (resolved !== command) {
      ctx.log('system', `Adjusted command: ${command} -> ${resolved}`)
      command = resolved
    }
  } else {
    command = name
    commandArgs = Object.keys(args).length > 0 ? args : undefined
  }

  const fmtArgs = commandArgs ? formatArgs(commandArgs) : ''
  ctx.log('tool_call', `game(${command}${fmtArgs ? ', ' + fmtArgs : ''})`)

  try {
    const resp = await ctx.connection.execute(command, commandArgs && Object.keys(commandArgs).length > 0 ? commandArgs : undefined)

    if (resp.error) {
      let errMsg = formatCommandError(command, resp.error.code, resp.error.message)
      if (resp.error.code === 'unknown_command' || resp.error.code === 'invalid_command') {
        const suggestions = await suggestCommands(ctx.profileId, command, ctx.connection)
        if (suggestions.length > 0) {
          errMsg += `\nDid you mean: ${suggestions.join(', ')}`
        }
      }
      ctx.log('tool_result', errMsg)
      return errMsg
    }

    const result = formatToolResult(command, resp.result, resp.notifications)
    ctx.log('tool_result', truncate(result, 200), truncateResultForLog(result))
    return truncateResult(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const errMsg = `Error executing ${command}: ${msg}`
    ctx.log('error', errMsg)
    return errMsg
  }
}

export function detectImmediateRecoveryHint(toolName: string, toolArgs: Record<string, unknown>, result: string): ImmediateRecoveryHint | null {
  const effectiveCommand = toolName === 'game'
    ? sanitizeCommandName(String(toolArgs.command || ''))
    : toolName
  const lower = result.toLowerCase()

  if (!effectiveCommand) return null

  if (lower.includes('error: [not_docked]') && effectiveCommand === 'undock') {
    return { reason: 'undock reported not_docked, so the ship is likely already undocked', suggestedStateCheck: 'get_status' }
  }
  if (lower.includes('error: [already_docked]') && effectiveCommand === 'dock') {
    return { reason: 'dock reported already_docked, so the ship is likely already docked', suggestedStateCheck: 'get_status' }
  }
  if (lower.includes('error: [already_in_system]')) {
    return { reason: 'travel target is already satisfied', suggestedStateCheck: 'get_status' }
  }
  if (lower.includes('error: [cargo_full]')) {
    return { reason: 'cargo capacity is exhausted and the current gather plan is blocked', suggestedStateCheck: 'get_status' }
  }
  if (lower.includes('error: [not_enough_fuel]')) {
    return { reason: 'movement plan is blocked by insufficient fuel', suggestedStateCheck: 'get_status' }
  }
  if (effectiveCommand === 'sell' && (lower.includes('error: [market') || lower.includes('error: [sell'))) {
    return { reason: 'sell action failed due to market constraints', suggestedStateCheck: 'get_status' }
  }

  return null
}

async function suggestCommands(profileId: string, attempted: string, connection: GameConnection): Promise<string[]> {
  const names = await getAvailableCommandNames(profileId, connection)
  const semantic = semanticCommandHints(attempted)
  if (names.length === 0) return semantic
  const ranked = rankCommandSuggestions(attempted, names).slice(0, 5)
  return [...semantic, ...ranked].slice(0, 6)
}

async function resolveCommandName(profileId: string, attempted: string, connection: GameConnection): Promise<string> {
  const names = await getAvailableCommandNames(profileId, connection)
  if (names.length === 0) return attempted
  if (names.includes(attempted)) return attempted

  const attemptedNorm = normalizeCommand(attempted)
  const normalizedMatches = names.filter(name => normalizeCommand(name) === attemptedNorm)
  if (normalizedMatches.length === 1) return normalizedMatches[0]

  const ranked = rankCommandSuggestions(attempted, names)
  if (ranked.length === 0) return attempted

  const best = ranked[0]
  const bestNorm = normalizeCommand(best)
  const distance = levenshtein(attemptedNorm, bestNorm)
  const confidentByEditDistance = distance <= 1
  const confidentByPrefix = bestNorm.startsWith(attemptedNorm) && attemptedNorm.length >= 6

  return (confidentByEditDistance || confidentByPrefix) ? best : attempted
}

async function getAvailableCommandNames(profileId: string, connection: GameConnection): Promise<string[]> {
  const profile = getProfile(profileId)
  if (!profile) return []

  const serverUrl = profile.server_url.replace(/\/$/, '')
  const apiVersion = connection.mode === 'http_v2' || connection.mode === 'mcp_v2' ? 'v2' : 'v1'
  const cacheKey = `${serverUrl}|${apiVersion}`

  const cached = commandSuggestCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.names
  }

  const commands = await fetchGameCommands(`${serverUrl}/api/${apiVersion}`)
  const names = commands.map(c => c.name)
  commandSuggestCache.set(cacheKey, {
    expiresAt: Date.now() + COMMAND_SUGGEST_CACHE_TTL_MS,
    names,
  })
  return names
}

function semanticCommandHints(inputRaw: string): string[] {
  const input = normalizeCommand(inputRaw)
  const hints: string[] = []

  if (input === 'get_recipes' || input === 'get_recipe' || input === 'get_receipe' || input === 'get_receipes') {
    hints.push('catalog(args={ type: "recipes" })')
    hints.push('craft(args={ recipe_id: "..." })')
  }

  if (input === 'recipe' || input === 'recipes') {
    hints.push('catalog(args={ type: "recipes" })')
  }

  return hints
}

function rankCommandSuggestions(inputRaw: string, candidates: string[]): string[] {
  const input = normalizeCommand(inputRaw)
  const scored = candidates
    .map((name) => {
      const n = normalizeCommand(name)
      let score = levenshtein(input, n)
      if (n.startsWith(input)) score -= 2
      if (input.startsWith(n)) score -= 1
      if (n.includes(input)) score -= 1
      if (n.replace('recipe', 'receipe') === input || n.replace('receipe', 'recipe') === input) score -= 3
      return { name, score }
    })
    .sort((a, b) => a.score - b.score || a.name.length - b.name.length || a.name.localeCompare(b.name))

  return scored.map(s => s.name)
}

function normalizeCommand(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function sanitizeCommandName(value: string): string {
  return value
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[>.,;:!?]+$/g, '')
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const prev = new Array(b.length + 1)
  const curr = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      )
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]
  }
  return prev[b.length]
}

function executeLocalTool(name: string, args: Record<string, unknown>, ctx: ToolContext): string {
  switch (name) {
    case 'save_credentials': {
      const creds = {
        username: String(args.username),
        password: String(args.password),
        empire: String(args.empire),
        player_id: String(args.player_id),
      }
      updateProfile(ctx.profileId, {
        username: creds.username,
        password: creds.password,
        empire: creds.empire,
        player_id: creds.player_id,
      })
      ctx.log('system', `Credentials saved for ${creds.username}`)
      return `Credentials saved successfully for ${creds.username}.`
    }
    case 'update_todo': {
      ctx.todo = String(args.content)
      updateProfile(ctx.profileId, { todo: ctx.todo })
      ctx.log('system', 'TODO list updated')
      return 'TODO list updated.'
    }
    case 'read_todo': {
      return ctx.todo || '(empty TODO list)'
    }
    case 'status_log': {
      ctx.log('system', `[${args.category}] ${args.message}`)
      return 'Logged.'
    }
    default:
      return `Unknown local tool: ${name}`
  }
}

function truncateResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text
  return text.slice(0, MAX_RESULT_CHARS) + '\n\n... (truncated)'
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 3) + '...'
}

function truncateResultForLog(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_LOG_DETAIL_CHARS) return text
  return text.slice(0, MAX_TOOL_RESULT_LOG_DETAIL_CHARS) + '\n\n... (truncated for log storage)'
}

const REDACTED_KEYS = new Set(['password', 'token', 'secret', 'api_key'])

function formatArgs(args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    if (REDACTED_KEYS.has(key)) { parts.push(`${key}=XXX`); continue }
    const str = typeof value === 'string' ? value : JSON.stringify(value)
    const t = str.length > 60 ? str.slice(0, 57) + '...' : str
    parts.push(`${key}=${t}`)
  }
  return parts.join(' ')
}

function formatToolResult(name: string, result: unknown, notifications?: unknown[]): string {
  const parts: string[] = []
  const pendingHint = formatPendingHint(name, result)
  if (pendingHint) {
    parts.push(pendingHint)
    parts.push('')
  }
  if (notifications && Array.isArray(notifications) && notifications.length > 0) {
    parts.push('Notifications:')
    for (const n of notifications) {
      const parsed = parseNotification(n)
      if (parsed) parts.push(`  > [${parsed.tag}] ${parsed.text}`)
    }
    parts.push('')
  }
  if (typeof result === 'string') {
    parts.push(result)
  } else {
    parts.push(jsonToYaml(result))
  }
  return parts.join('\n')
}

function parseNotification(n: unknown): { tag: string; text: string } | null {
  if (typeof n === 'string') return { tag: 'EVENT', text: n }
  if (typeof n !== 'object' || n === null) return null

  const notif = n as Record<string, unknown>
  const type = notif.type as string | undefined
  const msgType = notif.msg_type as string | undefined
  let data = notif.data as Record<string, unknown> | string | undefined

  if (typeof data === 'string') {
    try { data = JSON.parse(data) as Record<string, unknown> } catch { /* leave as string */ }
  }

  if (msgType === 'chat_message' && data && typeof data === 'object') {
    const channel = (data.channel as string) || '?'
    const sender = (data.sender as string) || 'Unknown'
    const content = (data.content as string) || ''
    if (sender === '[ADMIN]') return { tag: 'BROADCAST', text: content }
    if (channel === 'private') return { tag: `DM from ${sender}`, text: content }
    return { tag: `CHAT ${channel.toUpperCase()}`, text: `${sender}: ${content}` }
  }

  const tag = (type || msgType || 'EVENT').toUpperCase()
  let message: string
  if (data && typeof data === 'object') {
    message = (data.message as string) || (data.content as string) || JSON.stringify(data)
  } else if (typeof data === 'string') {
    message = data
  } else {
    message = (notif.message as string) || JSON.stringify(n)
  }
  return { tag, text: annotateNotification(tag, message) }
}

function formatPendingHint(command: string, result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const record = result as Record<string, unknown>
  if (record.pending !== true) return null

  const message = typeof record.message === 'string' ? record.message : `${command} accepted and queued for the next tick.`
  return [
    `Pending action accepted: ${message}`,
    'Interpret this as progress, not a stuck server.',
    `Do not repeat "${command}" immediately. Wait for the next tick, then refresh with get_status or interpret resulting notifications before deciding the state.`,
  ].join(' ')
}

function formatCommandError(command: string, code: string, message: string): string {
  const prefix = `Error: [${code}] ${message}`
  const normalized = code.trim().toLowerCase()

  if (normalized === 'not_docked' && command === 'undock') {
    return `${prefix}\nInterpretation: your ship is already undocked, so the previous undock likely already took effect. Do not call this a deadlock. Refresh with get_status and continue from the undocked state.`
  }

  if (normalized === 'already_docked' && command === 'dock') {
    return `${prefix}\nInterpretation: your ship is already docked. Treat the intended dock state as satisfied, refresh with get_status if needed, and continue.`
  }

  if (normalized === 'not_docked' && command !== 'undock') {
    return `${prefix}\nInterpretation: this command requires a docked ship, but the ship is currently not docked. Refresh with get_status and adjust the plan instead of assuming the server is frozen.`
  }

  if (normalized === 'already_in_system') {
    return `${prefix}\nInterpretation: you are already at the intended destination. Treat travel as already satisfied, refresh with get_status if needed, and continue with the next step instead of retrying travel.`
  }

  if (normalized === 'cargo_full') {
    return `${prefix}\nInterpretation: cargo is full. Stop repeating resource-gathering actions. Refresh with get_status or get_cargo and switch to selling, transferring, refining, or another cargo-clearing step.`
  }

  if (normalized === 'not_enough_fuel') {
    return `${prefix}\nInterpretation: the ship lacks fuel for this plan. Stop repeating the same movement action, refresh with get_status, and re-plan around refueling or a shorter route.`
  }

  if ((normalized.includes('market') || normalized.includes('sell')) && command === 'sell') {
    return `${prefix}\nInterpretation: selling failed due to market or sale constraints. Refresh with get_status or market/cargo queries and choose a corrected sell plan instead of repeating the same sell action blindly.`
  }

  return prefix
}

function annotateNotification(tag: string, message: string): string {
  const upperTag = tag.trim().toUpperCase()
  if (upperTag === 'ACTION_ERROR' && /\bnot_docked\b/i.test(message)) {
    return `${message} Interpretation: the ship is already undocked or an earlier undock already completed. Refresh state before retrying and do not infer a stuck mutation queue from this alone.`
  }
  if (upperTag === 'ACTION_ERROR' && /\balready_in_system\b/i.test(message)) {
    return `${message} Interpretation: travel is already satisfied because the ship is already in the target system. Continue with the next step instead of retrying travel.`
  }
  if (upperTag === 'ACTION_ERROR' && /\bcargo_full\b/i.test(message)) {
    return `${message} Interpretation: cargo capacity is exhausted. Stop gathering more resources and switch to unloading, selling, or another cargo-clearing action.`
  }
  if (upperTag === 'ACTION_ERROR' && /\bnot_enough_fuel\b/i.test(message)) {
    return `${message} Interpretation: the current route or action is blocked by fuel. Re-plan around refueling or a nearer destination instead of retrying the same move.`
  }
  if (upperTag === 'OK' && /\b\"action\":\"dock\"\b/i.test(message)) {
    return `${message} Interpretation: docking succeeded; treat the ship as docked.`
  }
  return message
}

function jsonToYaml(value: unknown, indent: number = 0): string {
  const pad = '  '.repeat(indent)

  if (value === null || value === undefined) return `${pad}~`
  if (typeof value === 'boolean') return `${pad}${value}`
  if (typeof value === 'number') return `${pad}${value}`
  if (typeof value === 'string') {
    if (
      value === '' || value === 'true' || value === 'false' ||
      value === 'null' || value === '~' ||
      value.includes('\n') || value.includes(': ') ||
      value.startsWith('{') || value.startsWith('[') ||
      value.startsWith("'") || value.startsWith('"') ||
      value.startsWith('#') || /^[\d.e+-]+$/i.test(value)
    ) {
      return `${pad}"${escapeYamlDoubleQuotedString(value)}"`
    }
    return `${pad}${value}`
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`
    if (value.every(v => v === null || typeof v !== 'object')) {
      const items = value.map(v => {
        if (typeof v === 'string') return `"${escapeYamlDoubleQuotedString(v)}"`
        return String(v ?? '~')
      })
      const oneLine = `${pad}[${items.join(', ')}]`
      if (oneLine.length < 120) return oneLine
    }
    const lines: string[] = []
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        lines.push(`${pad}- ${jsonToYaml(item, indent + 1).trimStart()}`)
      } else {
        lines.push(`${pad}- ${jsonToYaml(item, 0).trimStart()}`)
      }
    }
    return lines.join('\n')
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return `${pad}{}`
    const lines: string[] = []
    for (const [key, val] of entries) {
      if (val !== null && typeof val === 'object') {
        lines.push(`${pad}${key}:`)
        lines.push(jsonToYaml(val, indent + 1))
      } else {
        lines.push(`${pad}${key}: ${jsonToYaml(val, 0).trimStart()}`)
      }
    }
    return lines.join('\n')
  }

  return `${pad}${String(value)}`
}

function escapeYamlDoubleQuotedString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
}
