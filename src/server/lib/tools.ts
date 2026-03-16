import { Type, StringEnum } from '@mariozechner/pi-ai'
import type { Tool } from '@mariozechner/pi-ai'
import type { GameConnection, CommandResult } from './connections/interface'
import { getProfile, updateProfile } from './db'
import { fetchGameCommands, parseRuntimeCommandResult } from './schema'
import { getPendingNavigation, reconcilePendingNavigationWithStatus, updatePendingNavigationFromResult } from './navigation-guard'
import { classifyMiningFit } from './mining-fit'
import { classifyPoi, resolvePoiSnapshot } from './poi'
import { lookupKbPoiKind } from './system-kb'
import {
  clearPendingMutationSeen,
  clearNavigationRefreshRequired,
  getMarketSnapshot,
  isCommandTemporarilyBlocked,
  markPendingMutationSeen,
  markNavigationRefreshRequired,
  notePendingVerification,
  requiresNavigationRefresh,
  rememberMarketSnapshot,
  rememberUnknownCommand,
  shouldBlockZeroFillSell,
  shouldThrottlePendingVerification,
} from './runtime-guards'
import { ingestSynchronousTrade } from './agent-extensions'
import { getRecipe, deleteRecipe } from './economy-db'
import { getLatestStorageSnapshot } from './agent-learning'

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
const BLOCKED_GAME_COMMAND_PATTERNS = [
  /\bself_destruct\b/,
  /\bdelete_(account|character|player|profile)\b/,
  /\breset_(account|character|player|profile)\b/,
  /\bwipe_(account|character|player|profile)\b/,
  /\bterminate_(account|character|player|profile)\b/,
] as const

export type LogFn = (type: string, summary: string, detail?: string) => void

export interface ImmediateRecoveryHint {
  reason: string
  suggestedStateCheck: 'get_status' | 'get_location'
}

interface ToolContext {
  connection: GameConnection
  profileId: string
  log: LogFn
  todo: string
  gameState?: Record<string, unknown> | null
  onGameCommandResult?: (command: string, args: Record<string, unknown> | undefined, result: CommandResult) => void
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  reason?: string,
): Promise<string> {
  const normalizedToolArgs = normalizeToolArgs(args)
  if (!normalizedToolArgs.ok) {
    const errMsg = `Error: invalid tool arguments for '${name}'. ${normalizedToolArgs.error}`
    ctx.log('error', errMsg)
    return errMsg
  }

  args = normalizedToolArgs.value

  if (LOCAL_TOOLS.has(name)) {
    ctx.log('tool_call', `${name}(${formatArgs(args)})`)
    return executeLocalTool(name, args, ctx)
  }

  let command: string
  let commandArgs: Record<string, unknown> | undefined
  let originalCommand: string | null = null
  if (name === 'game') {
    command = String(args.command || '')
    const normalizedCommandArgs = normalizeOptionalArgsRecord(args.args)
    if (!normalizedCommandArgs.ok) {
      const errMsg = `Error: invalid 'args' payload for game(${command || 'unknown'}). ${normalizedCommandArgs.error}`
      ctx.log('error', errMsg)
      return errMsg
    }
    commandArgs = normalizedCommandArgs.value
    command = sanitizeCommandName(command)
    originalCommand = command
    if (!command) return 'Error: missing \'command\' argument'
    if (LOCAL_TOOLS.has(command)) {
      const errMsg = `Error: '${command}' is a local Admiral tool, not a game API command. Call ${command}(${formatArgs(commandArgs || {})}) directly instead of game(command=\"${command}\").`
      ctx.log('system', `Blocked local tool wrapped in game(): ${command}`)
      ctx.log('tool_result', errMsg)
      return errMsg
    }
    if (isBlockedGameCommand(command)) {
      const errMsg = `Error: blocked unsafe command '${command}'. Irreversible self-destruction or account-reset actions are never allowed.`
      ctx.log('error', errMsg)
      return errMsg
    }
    const resolved = await resolveCommandName(ctx.profileId, command, ctx.connection)
    if (resolved !== command) {
      ctx.log('system', `Adjusted command: ${command} -> ${resolved}`)
      command = resolved
    }
    const groupedRewrite = rewriteGroupedCommandInvocation(originalCommand, command, commandArgs)
    if (groupedRewrite.changed) {
      command = groupedRewrite.command
      commandArgs = groupedRewrite.args
      ctx.log('system', groupedRewrite.message)
    }
    if (isCommandTemporarilyBlocked(ctx.profileId, command)) {
      const errMsg = `Error: temporarily blocked repeated unknown or invalid command '${command}'. Use a verified command instead of retrying the same unsupported action.`
      ctx.log('error', errMsg)
      return errMsg
    }
    const placeholderResolution = resolveDynamicArgumentPlaceholders(command, commandArgs, ctx.gameState)
    if (placeholderResolution.changed) {
      commandArgs = placeholderResolution.args
      ctx.log('system', placeholderResolution.message)
    }
    const verifiedCommandError = await validateVerifiedGameCommand(ctx.profileId, command, ctx.connection)
    if (verifiedCommandError) {
      ctx.log('system', verifiedCommandError.systemMessage)
      ctx.log('tool_result', verifiedCommandError.errorMessage)
      return verifiedCommandError.errorMessage
    }
    if (isBlockedGameCommand(command)) {
      const errMsg = `Error: blocked unsafe command '${command}'. Irreversible self-destruction or account-reset actions are never allowed.`
      ctx.log('error', errMsg)
      return errMsg
    }
    const normalizedCatalog = normalizeCatalogArgs(command, commandArgs)
    if (normalizedCatalog.changed) {
      commandArgs = normalizedCatalog.args
      ctx.log('system', normalizedCatalog.message)
    }
    const normalizedNavigation = normalizeNavigationArgs(command, commandArgs)
    if (normalizedNavigation.changed) {
      commandArgs = normalizedNavigation.args
      ctx.log('system', normalizedNavigation.message)
    }
    const normalizedSearch = normalizeSearchSystemsArgs(command, commandArgs)
    if (normalizedSearch.changed) {
      commandArgs = normalizedSearch.args
      ctx.log('system', normalizedSearch.message)
    }
    const normalizedSellOrder = normalizeSellOrderArgs(ctx.profileId, command, commandArgs, ctx.gameState)
    if (normalizedSellOrder.changed) {
      commandArgs = normalizedSellOrder.args
      ctx.log('system', normalizedSellOrder.message)
    }
    const reroutedSell = rerouteSellToOrder(ctx.profileId, command, commandArgs, ctx.gameState)
    if (reroutedSell.changed) {
      command = reroutedSell.command
      commandArgs = reroutedSell.args
      ctx.log('system', reroutedSell.message)
    }
    if ((command === 'travel' || command === 'jump')) {
      const pendingNavigation = getPendingNavigation(ctx.profileId)
      if (pendingNavigation) {
        const destination = pendingNavigation.destination ? ` to ${pendingNavigation.destination}` : ''
        const errMsg = `Error: blocked duplicate navigation command '${command}' while previous ${pendingNavigation.command}${destination} is still pending. Wait for get_status/ACTION_RESULT before issuing another navigation mutation.`
        ctx.log('error', errMsg)
        return errMsg
      }
    }

    const localValidationError = await validateLocalGameCommand(ctx.profileId, command, commandArgs, ctx.gameState)
    if (localValidationError) {
      ctx.log('system', localValidationError.systemMessage)
      ctx.log('tool_result', localValidationError.errorMessage)
      return localValidationError.errorMessage
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
      if (command === 'craft' && commandArgs) {
        const recipeId = pickFirstStringArg(commandArgs.recipe_id, commandArgs.recipe, commandArgs.id)
        const errLower = `${resp.error.code} ${resp.error.message}`.toLowerCase()
        if (recipeId && (errLower.includes('unknown') || errLower.includes('invalid') || errLower.includes('not found') || errLower.includes('unsupported') || errLower.includes('access') || errLower.includes('denied'))) {
          deleteRecipe(recipeId)
          ctx.log('system', `Auto-cleanup: removed obsolete or inaccessible recipe '${recipeId}' from database after server rejection.`)
        }
      }

      let errMsg = formatCommandError(command, resp.error.code, resp.error.message)
      const backoffMessage = formatBackoffHint(resp)
      if (backoffMessage) {
        ctx.log('system', backoffMessage)
        errMsg += `\n${backoffMessage}`
      }
      if (resp.error.code === 'unknown_command' || resp.error.code === 'invalid_command') {
        rememberUnknownCommand(ctx.profileId, command)
        const suggestions = await suggestCommands(ctx.profileId, command, ctx.connection)
        if (suggestions.length > 0) {
          errMsg += `\nDid you mean: ${suggestions.join(', ')}`
        }
      }
      ctx.onGameCommandResult?.(command, commandArgs, resp)
      ctx.log('tool_result', errMsg)
      return errMsg
    }

    updatePendingNavigationFromResult(ctx.profileId, command, commandArgs || {}, resp)
    reconcilePendingNavigationWithStatus(ctx.profileId, resp)
    if (resp.meta?.pending || (resp.result && typeof resp.result === 'object' && (resp.result as Record<string, unknown>).pending === true)) {
      markPendingMutationSeen(ctx.profileId)
      if (command === 'jump') markNavigationRefreshRequired(ctx.profileId)
    } else if (command !== 'get_status' && command !== 'get_location') {
      clearPendingMutationSeen(ctx.profileId)
    }
    if (command === 'get_status' || command === 'get_location') {
      clearNavigationRefreshRequired(ctx.profileId)
    }
    const refreshedGameState = mergeGameStateSnapshot(ctx.gameState, resp, command, commandArgs)
    if (refreshedGameState) ctx.gameState = refreshedGameState
    ingestMarketSnapshot(ctx.profileId, command, resp)
    ingestSynchronousTrade(ctx.profileId, command, resp, ctx.gameState ?? null)
    notePendingVerification(ctx.profileId, command)
    ctx.onGameCommandResult?.(command, commandArgs, resp)

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
  if (effectiveCommand === 'travel' && lower.includes('error: [invalid_poi]')) {
    return { reason: 'travel failed because the destination POI was not found, likely because it is in a different system', suggestedStateCheck: 'get_location' }
  }
  if (lower.includes('error: [cargo_full]')) {
    return { reason: 'cargo capacity is exhausted and the current gather plan is blocked', suggestedStateCheck: 'get_status' }
  }
  if (effectiveCommand === 'mine' && lower.includes('error: [no_resources]') && lower.includes('nothing to mine here')) {
    return { reason: 'mining is blocked because the current location is not a valid resource node for the expected material', suggestedStateCheck: 'get_status' }
  }
  if (effectiveCommand === 'mine' && lower.includes('error: [no_equipment]') && lower.includes('ice harvester')) {
    return { reason: 'mining is blocked because the current ship/loadout cannot mine this ice node; replan locally instead of forcing this target', suggestedStateCheck: 'get_status' }
  }
  if (effectiveCommand === 'mine' && lower.includes('error: [unverified_location]')) {
    return { reason: 'mining is blocked because the local state lacks verified POI data', suggestedStateCheck: 'get_location' }
  }
  if (lower.includes('error: [not_enough_fuel]')) {
    return { reason: 'movement plan is blocked by insufficient fuel', suggestedStateCheck: 'get_status' }
  }
  if (effectiveCommand === 'sell' && lower.includes('error: [invalid_payload]') && lower.includes('quantity must be greater than 0')) {
    return { reason: 'sell was attempted with zero quantity or missing inventory', suggestedStateCheck: 'get_status' }
  }
  if (effectiveCommand === 'sell' && (lower.includes('error: [market') || lower.includes('error: [sell'))) {
    return { reason: 'sell action failed due to market constraints', suggestedStateCheck: 'get_status' }
  }
  if (effectiveCommand === 'search_systems' && (lower.includes('looks like a poi') || lower.includes('error: [invalid_query]'))) {
    return { reason: 'search_systems was used with a POI/station name or missing query. The agent is likely confused about its current location.', suggestedStateCheck: 'get_location' }
  }

  return null
}

async function validateLocalGameCommand(
  profileId: string,
  command: string,
  args: Record<string, unknown> | undefined,
  gameState: Record<string, unknown> | null | undefined,
): Promise<{ systemMessage: string; errorMessage: string } | null> {
  if (shouldThrottlePendingVerification(profileId, command)) {
    return {
      systemMessage: 'Blocked repeated pending verification locally: a pending action already consumed its allowed verification poll. Wait for the next tick or notification before polling state again.',
      errorMessage: `Error: [verification_cooldown] ${command} was requested again while a pending action is still being monitored. Wait for the next tick, ACTION_RESULT, or another notification before polling again.`,
    }
  }

  if (command === 'travel') {
    if (requiresNavigationRefresh(profileId)) {
      return {
        systemMessage: 'Blocked travel locally: a successful jump requires one fresh location/status verification before any next navigation mutation.',
        errorMessage: 'Error: [navigation_refresh_required] Refresh with get_location or get_status after the jump before sending travel. Do not chain a POI travel onto a jump without a fresh verified location.',
      }
    }
    const travelGuard = await validateTravelAgainstMiningFit(args, gameState)
    if (travelGuard) return travelGuard
  }

  if (command === 'jump' && requiresNavigationRefresh(profileId)) {
    return {
      systemMessage: 'Blocked jump locally: a successful jump still needs a fresh location/status verification before issuing another navigation mutation.',
      errorMessage: 'Error: [navigation_refresh_required] Refresh with get_location or get_status after the previous jump before issuing another jump.',
    }
  }

  if (command === 'search_systems') {
    return await validateSearchSystemsCommand(args)
  }

  if (command === 'create_sell_order') {
    return validateCreateSellOrderCommand(profileId, args, gameState)
  }

  if (command === 'cancel_order') {
    return validateCancelOrderCommand(args)
  }

  if (command === 'mine') {
    const mineGuard = validateMineAgainstLiveState(profileId, gameState)
    if (mineGuard) return mineGuard
  }

  if (command === 'craft') {
    const craftGuard = validateCraftCommand(profileId, args, gameState)
    if (craftGuard) return craftGuard
  }

  if (command !== 'sell') return null

  if (!args || Object.keys(args).length === 0) {
    return {
      systemMessage: 'Blocked sell locally: sell was attempted without item_id and quantity. Recompute the sale from fresh cargo first.',
      errorMessage: formatCommandError('sell', 'invalid_payload', 'invalid_payload: Sell requires item_id and a quantity greater than 0.'),
    }
  }

  const itemId = pickFirstStringArg(args.item_id, args.item, args.item_name)
  if (!itemId) {
    return {
      systemMessage: 'Blocked sell locally: sell is missing item_id/item. Refresh cargo and choose the exact inventory item before selling.',
      errorMessage: formatCommandError('sell', 'invalid_payload', 'invalid_payload: Sell requires item_id and a quantity greater than 0.'),
    }
  }

  const locationKey = extractSellLocationKey(gameState)
  if (locationKey && shouldBlockZeroFillSell(profileId, itemId, locationKey)) {
    return {
      systemMessage: `Blocked sell locally: ${itemId} recently had zero fill at ${locationKey}. Change market strategy before retrying instant sell here.`,
      errorMessage: `Error: [market_cooldown] Recent sell attempts for ${itemId} at ${locationKey} produced zero fill. Use create_sell_order, choose a different item, or move to a better market instead of repeating sell immediately.`,
    }
  }

  if (locationKey) {
    const market = getMarketSnapshot(profileId, locationKey, itemId)
    if (market && ((market.bidVolume ?? 0) <= 0 || (market.bestBid ?? 0) <= 0)) {
      return {
        systemMessage: `Blocked sell locally: no recent buy-side liquidity seen for ${itemId} at ${locationKey}.`,
        errorMessage: `Error: [market_cooldown] Recent market data at ${locationKey} shows no meaningful instant-buy liquidity for ${itemId}. Check whether a realistic sell order is better, or move to a stronger market.`,
      }
    }
  }

  const quantity = toFiniteNumber(args.quantity ?? args.qty ?? args.amount ?? args.quantity_sold)
  if (quantity === null || quantity > 0) return null

  return {
    systemMessage: 'Blocked sell locally: requested quantity is 0 or negative. Refresh cargo/state before trying to sell again.',
    errorMessage: formatCommandError('sell', 'invalid_payload', 'invalid_payload: Quantity must be greater than 0.'),
  }
}

async function validateVerifiedGameCommand(
  profileId: string,
  command: string,
  connection: GameConnection,
): Promise<{ systemMessage: string; errorMessage: string } | null> {
  const names = await getAvailableCommandNames(profileId, connection)
  if (names.length === 0) return null
  if (names.includes(command)) return null

  rememberUnknownCommand(profileId, command)
  const suggestions = await suggestCommands(profileId, command, connection)
  const suggestionSuffix = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}` : ''
  return {
    systemMessage: `Blocked unverified command locally: '${command}' is not present in the current API command list.`,
    errorMessage: `Error: unsupported command '${command}'. This command is not available in the current API.${suggestionSuffix}`,
  }
}

function extractSellLocationKey(gameState: Record<string, unknown> | null | undefined): string | null {
  const location = (gameState?.location as Record<string, unknown> | undefined) || {}
  return pickFirstStringArg(location.docked_at, location.poi_name, location.poi_id)
}

async function validateSearchSystemsCommand(
  args: Record<string, unknown> | undefined,
): Promise<{ systemMessage: string; errorMessage: string } | null> {
  if (!args) return null

  const query = pickFirstStringArg(args.query, args.search, args.system_name, args.system, args.target, args.text, args.id)
  if (!query) return null

  const normalized = query.trim().toLowerCase()
  let classifiedPoi = classifyPoi(query, query)
  if (classifiedPoi === 'unknown') {
    try {
      classifiedPoi = (await lookupKbPoiKind(query)) || classifiedPoi
    } catch {
      // Ignore KB lookup failure.
    }
  }
  const looksLikeBaseId =
    normalized.includes('command') ||
    normalized.includes('station') ||
    normalized.includes('shipyard') ||
    normalized.includes('base') ||
    normalized.includes('belt') ||
    normalized.includes('asteroid')

  if (classifiedPoi !== 'unknown' || looksLikeBaseId) {
    return {
      systemMessage: `Blocked search_systems locally: '${query}' looks like a POI/base identifier, not a star system name.`,
      errorMessage: `Error: [invalid_payload] search_systems expects a system name query. '${query}' looks like a POI or base identifier; use get_location/get_poi/get_system for the current place, or route using the actual system name instead.`,
    }
  }

  return null
}

function validateCreateSellOrderCommand(
  profileId: string,
  args: Record<string, unknown> | undefined,
  gameState: Record<string, unknown> | null | undefined,
): { systemMessage: string; errorMessage: string } | null {
  if (!args || Object.keys(args).length === 0) {
    return {
      systemMessage: 'Blocked create_sell_order locally: missing item_id, quantity, and price_each.',
      errorMessage: formatCommandError('create_sell_order', 'invalid_payload', 'invalid_payload: create_sell_order requires item_id, quantity greater than 0, and price_each greater than 0.'),
    }
  }

  const itemId = pickFirstStringArg(args.item_id, args.item, args.item_name)
  if (!itemId) {
    return {
      systemMessage: 'Blocked create_sell_order locally: missing item_id/item. Refresh cargo and choose the exact inventory item first.',
      errorMessage: formatCommandError('create_sell_order', 'invalid_payload', 'invalid_payload: create_sell_order requires item_id, quantity greater than 0, and price_each greater than 0.'),
    }
  }

  const quantity = toFiniteNumber(args.quantity ?? args.qty ?? args.amount)
  if (quantity === null || quantity <= 0) {
    return {
      systemMessage: 'Blocked create_sell_order locally: quantity is missing, zero, or negative.',
      errorMessage: formatCommandError('create_sell_order', 'invalid_payload', 'invalid_payload: Quantity must be greater than 0.'),
    }
  }

  const priceEach = toFiniteNumber(args.price_each ?? args.price ?? args.unit_price)
  if (priceEach === null || priceEach <= 0) {
    return {
      systemMessage: 'Blocked create_sell_order locally: price_each is missing, zero, or negative.',
      errorMessage: formatCommandError('create_sell_order', 'invalid_payload', 'invalid_payload: Price must be greater than 0.'),
    }
  }

  const locationKey = extractSellLocationKey(gameState)
  if (locationKey) {
    const market = getMarketSnapshot(profileId, locationKey, itemId)
    if (market) {
      const bestBid = market.bestBid
      const bestAsk = market.bestAsk
      if (bestAsk !== null && priceEach > bestAsk * 1.5) {
        return {
          systemMessage: `Blocked create_sell_order locally: price ${priceEach} is far above the recent best ask ${bestAsk} for ${itemId} at ${locationKey}.`,
          errorMessage: `Error: [price_out_of_range] Proposed sell price ${priceEach} is unrealistically above the recent market ask ${bestAsk} for ${itemId} at ${locationKey}. Choose a more realistic ask.`,
        }
      }
      if (bestBid !== null && priceEach < bestBid * 0.8) {
        return {
          systemMessage: `Blocked create_sell_order locally: price ${priceEach} is too far below the recent best bid ${bestBid} for ${itemId} at ${locationKey}.`,
          errorMessage: `Error: [price_out_of_range] Proposed sell price ${priceEach} is unrealistically below the recent market bid ${bestBid} for ${itemId} at ${locationKey}. Choose a more realistic ask.`,
        }
      }
    }
  }

  return null
}

function validateCancelOrderCommand(
  args: Record<string, unknown> | undefined,
): { systemMessage: string; errorMessage: string } | null {
  if (!args || Object.keys(args).length === 0) {
    return {
      systemMessage: 'Blocked cancel_order locally: missing order_id. Inspect live orders first and cancel by exact order_id only.',
      errorMessage: formatCommandError('cancel_order', 'invalid_payload', 'invalid_payload: cancel_order requires order_id. Use view_orders to inspect your orders and then cancel the exact order_id.'),
    }
  }

  const orderId = pickFirstStringArg(args.order_id, args.id)
  if (!orderId) {
    return {
      systemMessage: 'Blocked cancel_order locally: order fields were provided, but no order_id was included. Do not cancel by item_id, quantity, or price.',
      errorMessage: formatCommandError('cancel_order', 'invalid_payload', 'invalid_payload: cancel_order requires order_id. Use view_orders to inspect your orders and then cancel the exact order_id.'),
    }
  }

  return null
}

function validateCraftCommand(
  profileId: string,
  args: Record<string, unknown> | undefined,
  gameState: Record<string, unknown> | null | undefined,
): { systemMessage: string; errorMessage: string } | null {
  if (!args) return null
  const recipeId = pickFirstStringArg(args.recipe_id, args.recipe, args.id)
  if (!recipeId) {
    return {
      systemMessage: 'Blocked craft locally: missing recipe_id.',
      errorMessage: formatCommandError('craft', 'invalid_payload', 'invalid_payload: craft requires a recipe_id. Use catalog(type="recipes") to find valid recipes.'),
    }
  }

  const locationKey = extractSellLocationKey(gameState)
  if (!locationKey) {
    return {
      systemMessage: 'Blocked craft locally: not docked at a station.',
      errorMessage: 'Error: [not_docked] You must be docked at a base with a crafting facility to craft items. Travel to a station and dock first.',
    }
  }

  const recipe = getRecipe(recipeId)
  if (!recipe) return null // Fallback: falls das Rezept noch nicht importiert wurde, darf der Server entscheiden

  const ship = (gameState?.ship as Record<string, unknown> | undefined) || {}
  const cargo = Array.isArray(ship.cargo) ? ship.cargo : []
  const storage = getLatestStorageSnapshot(profileId)
  
  const location = (gameState?.location as Record<string, unknown> | undefined) || {}
  const currentStationId = location.base_id || location.poi_id
  const storageItems = storage && (storage.station_id === currentStationId || storage.station_name === location.poi_name) 
    ? storage.items 
    : []

  const craftQuantity = toFiniteNumber(args.quantity ?? args.qty ?? args.amount) || 1
  const missing: string[] = []

  for (const input of recipe.inputs) {
    let available = 0
    const required = input.quantity * craftQuantity
    const inputNameLower = input.item_name.toLowerCase()

    for (const item of [...cargo, ...storageItems]) {
      const rec = item as Record<string, unknown>
      const name = String(rec.name || rec.item_name || '').toLowerCase()
      const id = String(rec.item_id || '').toLowerCase()
      if (name === inputNameLower || id === inputNameLower || id.replace(/_/g, ' ') === inputNameLower) {
        available += toFiniteNumber(rec.quantity) || 0
      }
    }

    if (available < required) {
      missing.push(`${required - available}x ${input.item_name}`)
    }
  }

  if (missing.length > 0) {
    return {
      systemMessage: `Blocked craft locally: missing materials for ${craftQuantity}x ${recipe.recipe_name}.`,
      errorMessage: `Error: [insufficient_materials] Cannot craft ${craftQuantity}x ${recipe.recipe_name}. You are missing: ${missing.join(', ')}. Check the market (view_market) and buy the missing materials, or mine them first.`,
    }
  }

  return null
}

function normalizeSellOrderArgs(
  profileId: string,
  command: string,
  args: Record<string, unknown> | undefined,
  gameState: Record<string, unknown> | null | undefined,
): { changed: boolean; args: Record<string, unknown> | undefined; message: string } {
  if (command !== 'create_sell_order' || !args) return { changed: false, args, message: '' }

  const itemId = pickFirstStringArg(args.item_id, args.item, args.item_name)
  const locationKey = extractSellLocationKey(gameState)
  if (!itemId || !locationKey) return { changed: false, args, message: '' }

  const market = getMarketSnapshot(profileId, locationKey, itemId)
  if (!market) return { changed: false, args, message: '' }

  const next = { ...args }
  const currentPrice = toFiniteNumber(next.price_each ?? next.price ?? next.unit_price)
  const suggested = suggestSellOrderPrice(market.bestBid, market.bestAsk)
  if (suggested === null) return { changed: false, args, message: '' }

  const tooLow = currentPrice === null || currentPrice <= 0 || (market.bestBid !== null && currentPrice < market.bestBid * 0.8)
  const tooHigh = currentPrice !== null && market.bestAsk !== null && currentPrice > market.bestAsk * 1.5
  if (!tooLow && !tooHigh) return { changed: false, args, message: '' }

  next.price_each = suggested
  delete next.price
  delete next.unit_price
  return {
    changed: true,
    args: next,
    message: `Normalized create_sell_order price for ${itemId} at ${locationKey}: price_each=${suggested}`,
  }
}

function suggestSellOrderPrice(bestBid: number | null, bestAsk: number | null): number | null {
  if (bestAsk !== null && bestAsk > 0) {
    if (bestBid !== null && bestBid > 0 && bestAsk - bestBid <= 2) {
      return Math.max(1, bestBid + 1)
    }
    return Math.max(1, bestAsk)
  }
  if (bestBid !== null && bestBid > 0) {
    return Math.max(1, bestBid + 1)
  }
  return null
}

function rerouteSellToOrder(
  profileId: string,
  command: string,
  args: Record<string, unknown> | undefined,
  gameState: Record<string, unknown> | null | undefined,
): { changed: boolean; command: string; args: Record<string, unknown> | undefined; message: string } {
  if (command !== 'sell' || !args) return { changed: false, command, args, message: '' }

  const itemId = pickFirstStringArg(args.item_id, args.item, args.item_name)
  const quantity = toFiniteNumber(args.quantity ?? args.qty ?? args.amount ?? args.quantity_sold)
  const locationKey = extractSellLocationKey(gameState)
  if (!itemId || quantity === null || quantity <= 0 || !locationKey) {
    return { changed: false, command, args, message: '' }
  }

  const market = getMarketSnapshot(profileId, locationKey, itemId)
  const zeroFillBlocked = shouldBlockZeroFillSell(profileId, itemId, locationKey)
  if (!market) return { changed: false, command, args, message: '' }
  if (!zeroFillBlocked && (market.bidVolume ?? 0) > 0 && (market.bestBid ?? 0) > 0) {
    return { changed: false, command, args, message: '' }
  }

  const suggestedPrice = suggestSellOrderPrice(market.bestBid, market.bestAsk)
  if (suggestedPrice === null) return { changed: false, command, args, message: '' }

  return {
    changed: true,
    command: 'create_sell_order',
    args: {
      item_id: itemId,
      quantity,
      price_each: suggestedPrice,
    },
    message: zeroFillBlocked
      ? `Rerouted sell -> create_sell_order for ${itemId} at ${locationKey}: recent instant sell attempts produced zero fill, using price_each=${suggestedPrice}`
      : `Rerouted sell -> create_sell_order for ${itemId} at ${locationKey}: no recent instant-buy liquidity, using price_each=${suggestedPrice}`,
  }
}

async function validateTravelAgainstMiningFit(
  args: Record<string, unknown> | undefined,
  gameState: Record<string, unknown> | null | undefined,
): Promise<{ systemMessage: string; errorMessage: string } | null> {
  if (!args) return null

  const targetPoi = pickFirstStringArg(args.target_poi, args.poi_id, args.poi, args.poi_name, args.destination, args.target)
  if (!targetPoi) return null
  if (looksLikeCombinedDestination(targetPoi)) {
    return {
      systemMessage: `Blocked travel locally: target POI '${targetPoi}' looks like a combined system/POI string instead of a single destination id.`,
      errorMessage: `Error: [invalid_payload] Travel expects exactly one POI id or name in target_poi. '${targetPoi}' looks like a combined system/POI string; first jump to the system, then travel using only the POI id or POI name.`,
    }
  }

  let targetKind = classifyPoi(targetPoi, targetPoi)
  if (!['ore', 'ice', 'gas'].includes(targetKind)) {
    try {
      targetKind = (await lookupKbPoiKind(targetPoi)) || targetKind
    } catch {
      // Ignore KB lookup failure and fall back to direct string heuristics only.
    }
  }
  if (!['ore', 'ice', 'gas'].includes(targetKind)) return null

  const modules = Array.isArray(gameState?.modules) ? gameState?.modules : []
  const fitKind = classifyMiningFit(modules)
  if (fitKind === 'none' || fitKind === 'mixed') return null
  if (fitKind === targetKind) return null

  return {
    systemMessage: `Blocked travel locally: target POI (${targetPoi}) looks like ${targetKind}, but the current mining fit is ${fitKind}.`,
    errorMessage: `Error: [fit_location_mismatch] Refusing travel to ${targetPoi} because it looks like a ${targetKind} node and the current mining fit is ${fitKind}. Choose a compatible resource node instead.`,
  }
}

function validateMineAgainstLiveState(
  profileId: string,
  gameState: Record<string, unknown> | null | undefined,
): { systemMessage: string; errorMessage: string } | null {
  const pendingNavigation = getPendingNavigation(profileId)
  if (pendingNavigation) {
    const destination = pendingNavigation.destination ? ` to ${pendingNavigation.destination}` : ''
    return {
      systemMessage: 'Blocked mine locally: navigation is still pending, so the ship may be in transit and not yet at a mineable node.',
      errorMessage: `Error: [navigation_pending] Cannot mine while ${pendingNavigation.command}${destination} is still pending. Refresh with get_location or get_status after arrival before mining.`,
    }
  }

  const player = (gameState?.player as Record<string, unknown> | undefined) || {}
  const location = (gameState?.location as Record<string, unknown> | undefined) || {}
  const modules = Array.isArray(gameState?.modules) ? gameState?.modules : []
  const { type: poiType, name: poiName } = resolvePoiSnapshot(location, player)
  const poiKind = classifyPoi(poiType, poiName)
  const fitKind = classifyMiningFit(modules)

  if (poiKind === 'unknown') {
    return {
      systemMessage: 'Blocked mine locally: the current POI is not verified from live state. This often happens during transit or when only a stale name is available.',
      errorMessage: 'Error: [unverified_location] Cannot mine without a verified live POI type. Refresh with get_location first, then mine only at a confirmed compatible resource node.',
    }
  }

  if (poiKind === 'station') {
    return {
      systemMessage: 'Blocked mine locally: the ship is at a station/base, not a mining node.',
      errorMessage: 'Error: [invalid_location] Cannot mine while docked or at a station/base. Travel or undock to a compatible mining POI first.',
    }
  }

  if (fitKind === 'none') {
    return {
      systemMessage: 'Blocked mine locally: no mining equipment is visible in the current verified ship modules.',
      errorMessage: 'Error: [no_equipment] Cannot mine because no compatible mining equipment is installed on the current ship.',
    }
  }

  if (fitKind !== 'mixed' && poiKind !== 'resource' && fitKind !== poiKind) {
    return {
      systemMessage: `Blocked mine locally: mining fit (${fitKind}) does not match the current live POI (${poiKind}).`,
      errorMessage: `Error: [fit_location_mismatch] Cannot mine at this ${poiKind} node with a ${fitKind} mining fit. Refresh with get_location if needed and move to a compatible resource node.`,
    }
  }

  return null
}

function looksLikeCombinedDestination(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  return /\s\/\s/.test(trimmed) || /\s->\s/.test(trimmed)
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

  const canonicalAlias = findCanonicalAlias(attempted, names)
  if (canonicalAlias) return canonicalAlias

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
  const apiVersion = connection.mode === 'http_v2' || connection.mode === 'websocket_v2' || connection.mode === 'mcp_v2' ? 'v2' : 'v1'
  const cacheKey = `${serverUrl}|${apiVersion}`

  const cached = commandSuggestCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.names
  }

  const commands = await fetchAvailableCommands(connection, serverUrl, apiVersion)
  const names = commands.map(c => c.name)
  commandSuggestCache.set(cacheKey, {
    expiresAt: Date.now() + COMMAND_SUGGEST_CACHE_TTL_MS,
    names,
  })
  return names
}

function rewriteGroupedCommandInvocation(
  originalCommand: string | null,
  resolvedCommand: string,
  args: Record<string, unknown> | undefined,
): { changed: boolean; command: string; args: Record<string, unknown> | undefined; message: string } {
  const original = normalizeCommand(originalCommand || '')

  const bareFacilityActions = new Set([
    'personal_build', 'personal_decorate', 'personal_visit',
    'faction_build', 'faction_upgrade', 'faction_list', 'faction_toggle',
  ])

  if (bareFacilityActions.has(original)) {
    const explicitAction = args && typeof args.action === 'string' ? args.action.trim() : ''
    const actionToUse = explicitAction || original
    return {
      changed: true,
      command: 'facility',
      args: { ...(args || {}), action: actionToUse },
      message: `Expanded bare action alias: ${original} -> facility(action=${actionToUse})`,
    }
  }

  const groupedPrefixes: Array<{ command: string; prefix: string }> = [
    { command: 'storage', prefix: 'storage_' },
    { command: 'facility', prefix: 'facility_' },
    { command: 'facility', prefix: 'station_' },
  ]

  for (const grouped of groupedPrefixes) {
    if (!original.startsWith(grouped.prefix)) continue
    if (resolvedCommand !== grouped.command && resolvedCommand !== original) continue

    const implicitAction = original.slice(grouped.prefix.length)
    if (!implicitAction) continue

    const explicitAction = args && typeof args.action === 'string' ? args.action.trim() : ''
    const actionToUse = explicitAction || implicitAction

    return {
      changed: true,
      command: grouped.command,
      args: { ...(args || {}), action: actionToUse },
      message: `Expanded grouped command alias: ${original} -> ${grouped.command}(action=${actionToUse})`,
    }
  }

  return { changed: false, command: resolvedCommand, args, message: '' }
}

export function expandGroupedCommandAlias(
  command: string,
  args: Record<string, unknown> | undefined,
): { command: string; args: Record<string, unknown> | undefined; changed: boolean; message: string } {
  const rewrite = rewriteGroupedCommandInvocation(command, command, args)
  return {
    command: rewrite.command,
    args: rewrite.args,
    changed: rewrite.changed,
    message: rewrite.message,
  }
}

function resolveDynamicArgumentPlaceholders(
  command: string,
  args: Record<string, unknown> | undefined,
  gameState: Record<string, unknown> | null | undefined,
): { changed: boolean; args: Record<string, unknown> | undefined; message: string } {
  if (!args || !gameState) return { changed: false, args, message: '' }

  const next = Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, resolveDynamicValue(value, gameState)]),
  )
  const changedKeys = Object.keys(next)
    .filter((key) => JSON.stringify(next[key]) !== JSON.stringify(args[key]))
    .map((key) => `${key}=${typeof next[key] === 'string' ? next[key] : JSON.stringify(next[key])}`)

  if (changedKeys.length === 0) return { changed: false, args, message: '' }

  return {
    changed: true,
    args: next,
    message: `Resolved runtime placeholders for ${command}: ${changedKeys.join(', ')}`,
  }
}

async function fetchAvailableCommands(connection: GameConnection, serverUrl: string, apiVersion: 'v1' | 'v2'): Promise<Array<{ name: string }>> {
  if (connection.mode === 'websocket' || connection.mode === 'websocket_v2') {
    try {
      const resp: CommandResult = await connection.execute('get_commands')
      if (!resp.error) {
        const runtimeCommands = parseRuntimeCommandResult(resp.result)
        if (runtimeCommands.length > 0) return runtimeCommands
      }
    } catch {
      // Fall back to OpenAPI when runtime discovery is unavailable.
    }
  }

  const commands = await fetchGameCommands(`${serverUrl}/api/${apiVersion}`)
  return canonicalizeDiscoveredCommands(commands)
}

function canonicalizeDiscoveredCommands(commands: Array<{ name: string }>): Array<{ name: string }> {
  const preferred = new Map<string, { name: string }>()

  for (const command of commands) {
    const shortName = stripNamespacedAlias(command.name)
    if (!preferred.has(shortName)) {
      preferred.set(shortName, { ...command, name: shortName })
      continue
    }

    const existing = preferred.get(shortName)!
    if (existing.name !== shortName && command.name === shortName) {
      preferred.set(shortName, { ...command, name: shortName })
    }
  }

  return [...preferred.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function stripNamespacedAlias(name: string): string {
  const normalized = normalizeCommand(name)
  const segments = normalized.split('_').filter(Boolean)
  if (segments.length < 3) return normalized
  const knownPrefixes = new Set([
    'auth',
    'combat',
    'faction',
    'market',
    'salvage',
    'ship',
    'social',
  ])
  if (!knownPrefixes.has(segments[0])) return normalized
  return segments.slice(1).join('_')
}

function semanticCommandHints(inputRaw: string): string[] {
  const input = normalizeCommand(inputRaw)
  const hints: string[] = []

  if (input === 'get_notifications' || input === 'notifications' || input === 'get_events') {
    hints.push('get_location')
    hints.push('get_cargo')
    hints.push('get_status')
  }

  if (input === 'get_recipes' || input === 'get_recipe' || input === 'get_receipe' || input === 'get_receipes') {
    hints.push('catalog(args={ type: "recipes" })')
    hints.push('craft(args={ recipe_id: "recipe_or_item_id" })')
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

export function findCanonicalAlias(inputRaw: string, names: string[]): string | null {
  const input = normalizeCommand(inputRaw)
  if (!input) return null
  if (names.includes(inputRaw)) return inputRaw
  if (names.includes(input)) return input

  const explicitAlias = resolveExplicitCommandAlias(input, names)
  if (explicitAlias) return explicitAlias

  const variants = new Set<string>()
  const addVariant = (value: string) => {
    const normalized = normalizeCommand(value)
    if (normalized) variants.add(normalized)
  }

  addVariant(input)

  const segments = input.split('_').filter(Boolean)
  for (let i = 1; i < segments.length - 1; i++) {
    addVariant(segments.slice(i).join('_'))
  }

  if (input.startsWith('v2_')) addVariant(input.slice(3))

  let namespaceStripped = input
  while (namespaceStripped.startsWith('spacemolt_')) {
    namespaceStripped = namespaceStripped.slice('spacemolt_'.length)
    addVariant(namespaceStripped)
  }

  for (const variant of variants) {
    if (names.includes(variant)) return variant
  }

  const normalizedNameMap = new Map(names.map((name) => [normalizeCommand(name), name]))
  for (const variant of variants) {
    const mapped = normalizedNameMap.get(variant)
    if (mapped) return mapped
  }

  return null
}

export function resolveExplicitCommandAlias(input: string, names: string[]): string | null {
  const normalizedNameMap = new Map(names.map((name) => [normalizeCommand(name), name]))
  const chooseFirstAvailable = (...candidates: string[]): string | null => {
    for (const candidate of candidates) {
      const mapped = normalizedNameMap.get(normalizeCommand(candidate))
      if (mapped) return mapped
    }
    return null
  }

  if (input === 'get_notifications' || input === 'notifications' || input === 'get_events') {
    return chooseFirstAvailable('get_location', 'get_cargo', 'get_status')
  }

  if (input === 'cancel_mission') {
    return chooseFirstAvailable('abandon_mission')
  }

  if (input === 'get_market') {
    return chooseFirstAvailable('view_market')
  }

  if (input === 'storage_deposit' || input === 'storage_withdraw' || input === 'storage_view') {
    return chooseFirstAvailable(input, 'storage')
  }

  if (
    input === 'personal_build' || input === 'personal_decorate' || input === 'personal_visit' ||
    input === 'faction_build' || input === 'faction_upgrade' || input === 'faction_list' || input === 'faction_toggle' ||
    input.startsWith('facility_') ||
    input.startsWith('station_')
  ) {
    return chooseFirstAvailable(input, 'facility')
  }

  return null
}

function resolveDynamicValue(value: unknown, gameState: Record<string, unknown>): unknown {
  if (typeof value === 'string') return resolveDynamicString(value, gameState)
  if (Array.isArray(value)) return value.map((entry) => resolveDynamicValue(entry, gameState))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, resolveDynamicValue(entry, gameState)]),
    )
  }
  return value
}

function resolveDynamicString(value: string, gameState: Record<string, unknown>): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith('$')) return value

  const location = ((gameState.location as Record<string, unknown> | undefined) || {})
  const player = ((gameState.player as Record<string, unknown> | undefined) || {})
  const poi = ((gameState.poi as Record<string, unknown> | undefined) || {})
  const snapshot = resolvePoiSnapshot(location, player)

  const replacements: Record<string, string | null> = {
    '$current_system': pickFirstStringArg(location.system_name, location.system_id, player.current_system),
    '$current_poi': pickFirstStringArg(location.poi_name, location.poi_id, player.current_poi),
    '$current_poi_id': pickFirstStringArg(location.poi_id, poi.id),
    '$current_poi_name': pickFirstStringArg(location.poi_name, poi.name, player.current_poi),
    '$current_poi_type': pickFirstStringArg(location.poi_type, poi.type, typeof snapshot.type === 'string' ? snapshot.type : null),
    '$docked_station': pickFirstStringArg(location.docked_at, location.poi_name, player.current_poi),
    '$found_poi': pickFirstStringArg(poi.id, poi.name, location.poi_id, location.poi_name, player.current_poi),
    '$found_poi_id': pickFirstStringArg(poi.id, location.poi_id),
    '$found_poi_name': pickFirstStringArg(poi.name, location.poi_name, player.current_poi),
  }

  return replacements[trimmed] ?? value
}

function sanitizeCommandName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[>.,;:!?</]+$/g, '')

  const parenIdx = cleaned.indexOf('(')
  if (parenIdx !== -1) {
    return cleaned.slice(0, parenIdx).trim()
  }
  return cleaned
}

function isBlockedGameCommand(command: string): boolean {
  const normalized = normalizeCommand(command)
  return BLOCKED_GAME_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function normalizeJsonObjectString(value: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!isPlainObject(parsed)) {
      return { ok: false, error: 'Expected a JSON object.' }
    }
    return { ok: true, value: parsed }
  } catch {
    return { ok: false, error: 'Expected an object or a JSON object string.' }
  }
}

function normalizeToolArgs(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (isPlainObject(value)) return { ok: true, value }
  if (typeof value === 'string') return normalizeJsonObjectString(value)
  return { ok: false, error: 'Expected an object payload.' }
}

function normalizeOptionalArgsRecord(value: unknown): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (isPlainObject(value)) return { ok: true, value }
  if (typeof value === 'string') {
    if (value.trim() === '') return { ok: true, value: undefined }
    const parsed = normalizeJsonObjectString(value)
    if (!parsed.ok) {
      return { ok: false, error: `'args' must be an object, not a character string payload.` }
    }
    return parsed
  }
  return { ok: false, error: `'args' must be an object.` }
}

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

export function mergeGameStateSnapshot(
  current: Record<string, unknown> | null | undefined,
  resp: CommandResult,
  command?: string,
  args?: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const payload = (resp.structuredContent ?? resp.result) as Record<string, unknown> | undefined
  if (!payload || typeof payload !== 'object') return current || null

  const next = current && typeof current === 'object' ? { ...current } : {}
  let changed = false

  const player = payload.player
  if (player && typeof player === 'object') {
    next.player = player
    changed = true
  }

  const ship = payload.ship
  if (ship && typeof ship === 'object') {
    next.ship = ship
    changed = true
  }

  const modules = payload.modules
  if (Array.isArray(modules)) {
    next.modules = modules
    changed = true
  }

  const locationWrapper = payload.location
  if (locationWrapper && typeof locationWrapper === 'object') {
    next.location = locationWrapper
    changed = true
  } else if ((payload.poi_id !== undefined || payload.poi_name !== undefined || payload.poi_type !== undefined || payload.system_id !== undefined || payload.system_name !== undefined || payload.in_transit !== undefined) && !('location' in payload)) {
    const prevLoc = (next.location && typeof next.location === 'object' ? next.location : {}) as Record<string, unknown>
    next.location = {
      ...prevLoc,
      system_id: payload.system_id ?? prevLoc.system_id,
      system_name: payload.system_name ?? prevLoc.system_name,
      poi_id: payload.poi_id ?? prevLoc.poi_id,
      poi_name: payload.poi_name ?? prevLoc.poi_name,
      poi_type: payload.poi_type ?? prevLoc.poi_type,
      docked_at: payload.docked_at ?? prevLoc.docked_at,
      in_transit: payload.in_transit ?? prevLoc.in_transit,
      transit_type: payload.transit_type ?? prevLoc.transit_type,
      ticks_remaining: payload.ticks_remaining ?? prevLoc.ticks_remaining,
      transit_dest_system_name: payload.to_system ?? payload.transit_dest_system_name ?? prevLoc.transit_dest_system_name,
      transit_dest_poi_name: payload.to_poi ?? payload.transit_dest_poi_name ?? prevLoc.transit_dest_poi_name,
    }
    changed = true
  }

  const poiBlock = payload.poi
  if (poiBlock && typeof poiBlock === 'object') {
    const isTargetedLookup = command === 'get_poi' && args && Object.keys(args).length > 0
    if (!isTargetedLookup) {
      const poi = poiBlock as Record<string, unknown>
      const prevLoc = (next.location && typeof next.location === 'object' ? next.location : {}) as Record<string, unknown>
      next.location = {
        ...prevLoc,
        poi_id: poi.id ?? prevLoc.poi_id,
        poi_name: poi.name ?? prevLoc.poi_name,
        poi_type: poi.type ?? prevLoc.poi_type,
        system_id: poi.system_id ?? prevLoc.system_id,
      }
      changed = true
    }
  }

  return changed ? next : (current || null)
}

function ingestMarketSnapshot(profileId: string, command: string, resp: CommandResult): void {
  if (command !== 'view_market' && command !== 'analyze_market') return
  const payload = (resp.structuredContent ?? resp.result) as Record<string, unknown> | undefined
  if (!payload || typeof payload !== 'object') return

  const locationKey = pickFirstStringArg(payload.base, payload.station_name, payload.station, payload.base_name)
  if (!locationKey) return

  const candidates = [payload.items, payload.market, (payload.result as Record<string, unknown> | undefined)?.items]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    for (const item of candidate) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const itemId = pickFirstStringArg(record.item_id, record.id, record.name)
      if (!itemId) continue
      const nestedBid = bestOrderPrice(record.buy_orders, 'desc')
      const nestedAsk = bestOrderPrice(record.sell_orders, 'asc')
      const nestedBidVolume = sumOrderVolume(record.buy_orders)
      const nestedAskVolume = sumOrderVolume(record.sell_orders)
      rememberMarketSnapshot(profileId, locationKey, itemId, {
        bestBid: toFiniteNumber(record.best_bid ?? record.bid_price ?? record.buy_price ?? record.highest_buy ?? record.bid ?? nestedBid),
        bestAsk: toFiniteNumber(record.best_ask ?? record.ask_price ?? record.sell_price ?? record.lowest_sell ?? record.ask ?? nestedAsk),
        bidVolume: toFiniteNumber(record.bid_volume ?? record.buy_volume ?? record.demand ?? record.quantity_buy ?? record.buy_quantity ?? nestedBidVolume),
        askVolume: toFiniteNumber(record.ask_volume ?? record.sell_volume ?? record.supply ?? record.quantity_sell ?? record.sell_quantity ?? record.quantity ?? nestedAskVolume),
      })
    }
    return
  }
}

function bestOrderPrice(orders: unknown, direction: 'asc' | 'desc'): number | null {
  if (!Array.isArray(orders)) return null
  let best: number | null = null
  for (const order of orders) {
    if (!order || typeof order !== 'object') continue
    const record = order as Record<string, unknown>
    const price = toFiniteNumber(record.price ?? record.unit_price ?? record.ask_price ?? record.bid_price ?? record.buy_price ?? record.sell_price)
    if (price === null) continue
    if (best === null) {
      best = price
      continue
    }
    if (direction === 'asc' ? price < best : price > best) best = price
  }
  return best
}

function sumOrderVolume(orders: unknown): number | null {
  if (!Array.isArray(orders)) return null
  let total = 0
  let seen = false
  for (const order of orders) {
    if (!order || typeof order !== 'object') continue
    const record = order as Record<string, unknown>
    const volume = toFiniteNumber(record.quantity ?? record.remaining_quantity ?? record.available ?? record.volume)
    if (volume === null) continue
    total += volume
    seen = true
  }
  return seen ? total : null
}

function formatPendingHint(command: string, result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const record = result as Record<string, unknown>
  if (record.pending !== true) return null

  const message = typeof record.message === 'string' ? record.message : `${command} accepted and queued for the next tick.`
  const extras = formatTravelPendingDetails(command, record)
  return [
    `Pending action accepted: ${message}`,
    extras,
    'Interpret this as progress, not a stuck server.',
    `Do not repeat "${command}" immediately. Wait for the next tick, then refresh with get_status or interpret resulting notifications before deciding the state.`,
  ].filter(Boolean).join(' ')
}

function formatTravelPendingDetails(command: string, record: Record<string, unknown>): string {
  if (command !== 'travel' && command !== 'jump') return ''
  const parts: string[] = []
  const au = toFiniteNumber(record.distance_au ?? record.au ?? record.distance)
  const ticks = toFiniteNumber(record.ticks ?? record.tick_count ?? record.ticks_remaining ?? record.travel_ticks)
  const etaTick = toFiniteNumber(record.eta_tick ?? record.arrival_tick)
  if (au !== null) parts.push(`Distance ${au} AU.`)
  if (ticks !== null) parts.push(`Estimated duration ${ticks} ticks.`)
  if (etaTick !== null) parts.push(`ETA tick ${etaTick}.`)
  return parts.join(' ')
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
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

  if (normalized === 'invalid_poi' && command === 'travel') {
    return `${prefix}\nInterpretation: this POI is not in your current star system. The 'travel' command only moves between POIs within the same system. If your destination is in another system, use 'search_systems' and 'find_route' to navigate there using 'jump' first. Refresh with get_location to confirm where you currently are.`
  }

  if (normalized === 'cargo_full') {
    return `${prefix}\nInterpretation: cargo is full. Stop repeating resource-gathering actions. Refresh with get_status or get_cargo and switch to selling, transferring, crafting, or another cargo-clearing step.`
  }

  if (normalized === 'not_enough_fuel') {
    return `${prefix}\nInterpretation: the ship lacks fuel for this plan. Stop repeating the same movement action, refresh with get_status, and re-plan around refueling or a shorter route.`
  }

  if (normalized === 'no_resources' && command === 'mine') {
    return `${prefix}\nInterpretation: mining is not available at this exact in-game location right now. This can mean the spot has no mineable resource, the current POI supports different resources than the one you expect, or you are not at the correct ore/ice/resource node. Refresh with get_status or get_location, confirm the POI/resource type, and move to a valid mining location instead of repeating mine blindly.`
  }

  if (normalized === 'no_equipment' && command === 'mine' && /ice harvester/i.test(message)) {
    return `${prefix}\nInterpretation: this mining spot requires ice-harvesting equipment that the current ship/loadout does not have. With the current equipment, the better short-term plan is usually a compatible non-empty belt or another activity that fits the installed modules. Treat this as a local mismatch between ship and node, not as an instruction to immediately or permanently switch ships/equipment just to get a small amount of ice.`
  }

  if (normalized === 'invalid_payload' && command === 'sell' && /quantity must be greater than 0/i.test(message)) {
    return `${prefix}\nInterpretation: sell was called with quantity 0 or with no matching inventory available. Refresh with get_status or get_cargo, recompute the available amount, and only sell a positive quantity.`
  }

  if ((normalized.includes('market') || normalized.includes('sell')) && command === 'sell') {
    return `${prefix}\nInterpretation: selling failed due to market or sale constraints. Refresh with get_status or market/cargo queries and choose a corrected sell plan instead of repeating the same sell action blindly.`
  }

  if (command === 'craft' && (normalized.includes('invalid') || normalized.includes('unknown') || normalized.includes('access') || normalized.includes('denied'))) {
    return `${prefix}\nInterpretation: this recipe is either obsolete, invalid, or your current faction/account cannot craft it here. It has been removed from your local database. Change your plan and do not attempt to craft it again.`
  }

  if (normalized === 'invalid_query' && command === 'search_systems') {
    return `${prefix}\nInterpretation: search_systems requires a star system name. You cannot search for POIs, asteroid belts, or stations. If you don't know the system name, use get_location to orient yourself.`
  }

  return prefix
}

function formatBackoffHint(resp: CommandResult): string | null {
  if (!resp.error) return null
  const code = String(resp.error.code || '').toLowerCase()
  const message = String(resp.error.message || '').toLowerCase()
  const isRateLimit = code.includes('429') || code.includes('rate') || message.includes('429') || message.includes('rate limit')
  const waitSeconds = toFiniteNumber(resp.error.retry_after ?? resp.error.wait_seconds)

  if (isRateLimit) {
    if (waitSeconds !== null && waitSeconds > 0) {
      return `Backoff hint: the server asked for a ${waitSeconds}s pause before the next retry. Prefer waiting or switching turns instead of repeating the same command immediately.`
    }
    return 'Backoff hint: the server signaled rate pressure. Slow down and avoid immediate retries of nearby commands.'
  }

  if (code === 'action_pending') {
    return 'Backoff hint: the previous mutation is still pending. Wait for the next tick or a fresh notification before sending another mutation.'
  }

  return null
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
  if (upperTag === 'ACTION_ERROR' && /\bno_resources\b/i.test(message) && /nothing to mine here/i.test(message)) {
    return `${message} Interpretation: this exact location is not a valid mining spot for the expected resource right now. The account may be at the wrong ore/ice/resource POI, or this POI may not support mining. Verify the current location and move to a confirmed mining node instead of repeating mine here.`
  }
  if (upperTag === 'ACTION_ERROR' && /\bno_equipment\b/i.test(message) && /ice harvester/i.test(message)) {
    return `${message} Interpretation: this ice location needs equipment the current ship does not have. With the current fit, a compatible non-empty belt is usually a better short-term target than switching equipment just to collect a little ice. Treat it as a short-term location/loadout mismatch, not an immediate long-term refit order.`
  }
  if (upperTag === 'ACTION_ERROR' && /\binvalid_payload\b/i.test(message) && /quantity must be greater than 0/i.test(message)) {
    return `${message} Interpretation: the sell plan used quantity 0 or stale cargo information. Re-check inventory and only sell a positive available amount.`
  }
  if (upperTag === 'OK' && /\b\"action\":\"dock\"\b/i.test(message)) {
    return `${message} Interpretation: docking succeeded; treat the ship as docked.`
  }
  return message
}

function normalizeNavigationArgs(
  command: string,
  args: Record<string, unknown> | undefined,
): { changed: boolean; args: Record<string, unknown> | undefined; message: string } {
  if (!args) return { changed: false, args, message: '' }

  const next = { ...args }
  const changes: string[] = []

  if (command === 'travel') {
    const targetPoi = pickFirstStringArg(next.target_poi, next.poi_id, next.destination_id, next.poi, next.poi_name, next.destination, next.target, next.id, next.text)
    if (targetPoi && next.target_poi !== targetPoi) {
      next.target_poi = targetPoi
      changes.push(`target_poi=${targetPoi}`)
    }
    for (const key of ['poi_id', 'destination_id', 'poi', 'poi_name', 'destination', 'target', 'id', 'text'] as const) {
      if (key in next) delete next[key]
    }
  }

  if (command === 'jump' || command === 'find_route') {
    const targetSystem = pickFirstStringArg(next.target_system, next.system_id, next.destination_id, next.system, next.system_name, next.destination, next.target, next.id, next.text)
    if (targetSystem && next.target_system !== targetSystem) {
      next.target_system = targetSystem
      changes.push(`target_system=${targetSystem}`)
    }
    for (const key of ['system_id', 'destination_id', 'system', 'system_name', 'destination', 'target', 'id', 'text'] as const) {
      if (key in next) delete next[key]
    }
  }

  if (changes.length === 0) return { changed: false, args, message: '' }

  return {
    changed: true,
    args: next,
    message: `Normalized navigation args for ${command}: ${changes.join(', ')}`,
  }
}

function normalizeSearchSystemsArgs(
  command: string,
  args: Record<string, unknown> | undefined,
): { changed: boolean; args: Record<string, unknown> | undefined; message: string } {
  if (command !== 'search_systems' || !args) return { changed: false, args, message: '' }

  const next = { ...args }
  const query = pickFirstStringArg(next.query, next.search, next.system_name, next.system, next.target, next.text, next.id)
  
  if (query && next.query !== query) {
    next.query = query
    for (const key of ['search', 'system_name', 'system', 'target', 'text', 'id'] as const) {
      if (key in next) delete next[key]
    }
    return {
      changed: true,
      args: next,
      message: `Normalized search_systems args: query=${query}`,
    }
  }

  return { changed: false, args, message: '' }
}

function normalizeCatalogArgs(
  command: string,
  args: Record<string, unknown> | undefined,
): { changed: boolean; args: Record<string, unknown> | undefined; message: string } {
  if (command !== 'catalog' || !args) return { changed: false, args, message: '' }
  if (typeof args.type === 'string' && args.type.trim()) return { changed: false, args, message: '' }

  const next = { ...args }
  const category = typeof next.category === 'string' ? next.category.trim().toLowerCase() : ''
  const search = typeof next.search === 'string' ? next.search.trim().toLowerCase() : ''

  const inferredType =
    category === 'skills' ||
    search.includes('skill') ||
    search.includes('train')
      ? 'skills'
      :
    category === 'refining' ||
    category === 'alloy' ||
    search.includes('recipe') ||
    search.includes('blueprint')
      ? 'recipes'
      : 'items'

  next.type = inferredType
  return {
    changed: true,
    args: next,
    message: `Normalized catalog args: injected type=${inferredType}`,
  }
}

function pickFirstStringArg(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
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
