import { getPreference, setPreference } from './db'

export interface GameCommandParam {
  name: string
  type: string
  required: boolean
  description: string
}

export interface GameCommandInfo {
  name: string
  description: string
  isMutation: boolean | null
  params: GameCommandParam[]
}

interface RuntimeCommandEntry {
  name: string
  description: string
  is_mutation?: boolean
  format?: string
}

// Cache TTL: 1 hour
const SPEC_CACHE_TTL_MS = 60 * 60 * 1000
const CANONICAL_V2_SPEC_URL = 'https://game.spacemolt.com/api/v2/openapi.json'

export type SpecLogFn = (type: 'info' | 'warn' | 'error', message: string) => void

const GENERIC_TOOL_ACTIONS = new Set([
  'accept',
  'advance',
  'build',
  'cancel',
  'claim',
  'create',
  'delete',
  'deposit',
  'edit',
  'engage',
  'help',
  'info',
  'join',
  'list',
  'login',
  'logout',
  'policies',
  'quote',
  'read',
  'register',
  'release',
  'reload',
  'retreat',
  'salvage',
  'scrap',
  'sell',
  'status',
  'toggle',
  'tow',
  'transfer',
  'types',
  'upgrade',
  'upgrades',
  'view',
  'visit',
  'withdraw',
  'write',
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function parseParamsFromFormat(format: string | undefined): GameCommandParam[] {
  if (!format) return []
  const payloadMatch = format.match(/"payload"\s*:\s*\{(.*)\}/s)
  if (!payloadMatch) return []
  const objectBody = payloadMatch[1]
  const paramNames = [...objectBody.matchAll(/"([^"]+)"\s*:/g)]
    .map((match) => match[1])
    .filter((name) => name !== 'action')

  return [...new Set(paramNames)].map((name) => ({
    name,
    type: 'unknown',
    required: true,
    description: '',
  }))
}

export function parseRuntimeCommandResult(result: unknown): GameCommandInfo[] {
  const record = asRecord(result)
  const rawCommands = Array.isArray(record?.commands) ? record.commands : []
  return rawCommands
    .map((entry) => {
      const item = asRecord(entry) as RuntimeCommandEntry | null
      if (!item || typeof item.name !== 'string') return null
      return {
        name: item.name,
        description: typeof item.description === 'string' && item.description.trim() ? item.description : item.name,
        isMutation: typeof item.is_mutation === 'boolean' ? item.is_mutation : null,
        params: parseParamsFromFormat(typeof item.format === 'string' ? item.format : undefined),
      } satisfies GameCommandInfo
    })
    .filter((item): item is GameCommandInfo => item !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function getOpenApiSpecUrls(baseUrl: string): string[] {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '')
  const urls: string[] = []
  const addUrl = (url: string) => {
    if (!urls.includes(url)) urls.push(url)
  }

  if (/\/api\/v2$/.test(normalizedBaseUrl)) {
    addUrl(`${normalizedBaseUrl}/openapi.json`)
    addUrl(CANONICAL_V2_SPEC_URL)
    return urls
  }

  if (/\/api\/v\d+$/.test(normalizedBaseUrl)) {
    const versionedSpecUrl = `${normalizedBaseUrl}/openapi.json`
    if (/\/api\/v1$/.test(normalizedBaseUrl)) {
      addUrl(normalizedBaseUrl.replace(/\/api\/v1$/, '/api/v2/openapi.json'))
      addUrl(CANONICAL_V2_SPEC_URL)
      addUrl(versionedSpecUrl)
      return urls
    }
    addUrl(versionedSpecUrl)
    return urls
  }

  if (/\/v\d+$/.test(normalizedBaseUrl)) {
    addUrl(`${normalizedBaseUrl}/openapi.json`)
    if (/\/v2$/.test(normalizedBaseUrl)) addUrl(CANONICAL_V2_SPEC_URL)
    return urls
  }

  addUrl(`${normalizedBaseUrl}/api/v2/openapi.json`)
  addUrl(CANONICAL_V2_SPEC_URL)
  addUrl(`${normalizedBaseUrl}/openapi.json`)
  return urls
}

function resolveSchemaRef(spec: Record<string, unknown>, ref: string): Record<string, unknown> | null {
  if (!ref.startsWith('#/')) return null
  const parts = ref.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  let current: unknown = spec
  for (const part of parts) {
    if (!current || typeof current !== 'object') return null
    current = (current as Record<string, unknown>)[part]
  }
  return asRecord(current)
}

function dereferenceSchema(spec: Record<string, unknown>, schema: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!schema) return null
  if (typeof schema.$ref === 'string') {
    return dereferenceSchema(spec, resolveSchemaRef(spec, schema.$ref))
  }
  return schema
}

function mergeObjectSchema(spec: Record<string, unknown>, schema: Record<string, unknown> | null): {
  properties: Record<string, Record<string, unknown>>
  required: string[]
} {
  const properties: Record<string, Record<string, unknown>> = {}
  const required = new Set<string>()

  const mergeFrom = (candidate: Record<string, unknown> | null) => {
    const resolved = dereferenceSchema(spec, candidate)
    if (!resolved) return

    for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
      const variants = resolved[key]
      if (Array.isArray(variants)) {
        for (const variant of variants) mergeFrom(asRecord(variant))
      }
    }

    const nextProps = asRecord(resolved.properties)
    if (nextProps) {
      for (const [name, value] of Object.entries(nextProps)) {
        properties[name] = {
          ...(properties[name] || {}),
          ...(dereferenceSchema(spec, asRecord(value)) || {}),
        }
      }
    }

    if (Array.isArray(resolved.required)) {
      for (const name of resolved.required) {
        if (typeof name === 'string') required.add(name)
      }
    }
  }

  mergeFrom(schema)
  return { properties, required: [...required] }
}

function aliasToolName(tool: string): string {
  if (tool === 'spacemolt') return ''
  return tool.replace(/^spacemolt_?/, '')
}

export function buildNamespacedActionAlias(tool: string, action: string): string | null {
  const alias = aliasToolName(tool)
  if (!alias) return null
  return `${alias}_${action}`
}

export function shouldAliasToolAction(tool: string, action: string): boolean {
  return tool !== 'spacemolt' && (GENERIC_TOOL_ACTIONS.has(action) || tool !== 'spacemolt')
}

function deriveCommandName(path: string, operationId: string | undefined, toolPrefixes: string[]): string | null {
  const segments = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const effectiveSegments = segments[0] === 'api' && /^v\d+$/.test(segments[1] || '')
    ? segments.slice(2)
    : segments

  if (effectiveSegments.length === 2) {
    const [tool, action] = effectiveSegments
    const alias = shouldAliasToolAction(tool, action) ? buildNamespacedActionAlias(tool, action) : null
    return alias || action
  }

  if (effectiveSegments.length === 1) {
    const segment = effectiveSegments[0]
    for (const prefix of [...toolPrefixes].sort((a, b) => b.length - a.length)) {
      if (segment.startsWith(prefix + '_') && segment.length > prefix.length + 1) {
        return segment.slice(prefix.length + 1)
      }
    }
    return segment
  }

  return operationId || effectiveSegments[effectiveSegments.length - 1] || null
}

/**
 * Fetch an OpenAPI spec by URL, with local SQLite caching and error surfacing.
 * Returns the parsed spec or null if both fetch and cache miss.
 */
export async function fetchOpenApiSpec(
  specUrl: string,
  log?: SpecLogFn,
): Promise<Record<string, unknown> | null> {
  const cacheKey = `openapi_cache:${specUrl}`
  const cacheTimeKey = `openapi_cache_time:${specUrl}`

  // Try fetching from the server
  try {
    const resp = await fetch(specUrl, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'SpaceMolt-Admiral' } })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      if (resp.status === 429) {
        log?.('warn', `OpenAPI spec rate-limited (429) at ${specUrl}: ${body}`)
      } else {
        log?.('warn', `OpenAPI spec fetch failed (HTTP ${resp.status}) at ${specUrl}: ${body}`)
      }
      throw new Error(`HTTP ${resp.status}`)
    }
    const spec = asRecord(await resp.json())
    if (!spec) throw new Error('Invalid OpenAPI spec payload')
    // Cache on success
    try {
      setPreference(cacheKey, JSON.stringify(spec))
      setPreference(cacheTimeKey, String(Date.now()))
    } catch {
      // Non-fatal -- caching is best-effort
    }
    log?.('info', `Fetched OpenAPI spec from ${specUrl}`)
    return spec
  } catch {
    // Fetch failed -- try cache
  }

  // Try cached spec
  try {
    const cached = getPreference(cacheKey)
    const cachedTime = getPreference(cacheTimeKey)
    if (cached) {
      const age = cachedTime ? Date.now() - Number(cachedTime) : Infinity
      const ageMin = Math.round(age / 60_000)
      if (age < SPEC_CACHE_TTL_MS) {
        log?.('info', `Using cached OpenAPI spec for ${specUrl} (${ageMin}m old)`)
      } else {
        log?.('warn', `Using stale cached OpenAPI spec for ${specUrl} (${ageMin}m old, fetch failed)`)
      }
      return asRecord(JSON.parse(cached))
    }
  } catch {
    // Cache parse failed
  }

  log?.('error', `No OpenAPI spec available for ${specUrl} (fetch failed, no cache)`)
  return null
}

/**
 * Fetch the OpenAPI spec from the gameserver and extract commands with params.
 */
export function extractGameCommandsFromOpenApiSpec(spec: Record<string, unknown>): GameCommandInfo[] {
  const paths = (spec.paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>
  const commands: GameCommandInfo[] = []
  const toolPrefixes = new Set<string>()

  for (const path of Object.keys(paths)) {
    const segments = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
    const effectiveSegments = segments[0] === 'api' && /^v\d+$/.test(segments[1] || '')
      ? segments.slice(2)
      : segments
    if (effectiveSegments.length === 2) toolPrefixes.add(effectiveSegments[0])
  }

  for (const [path, methods] of Object.entries(paths)) {
    const op = methods?.post
    if (!op) continue

    const operationId = typeof op.operationId === 'string' ? op.operationId : undefined
    const name = deriveCommandName(path, operationId, [...toolPrefixes])
    if (!name) continue
    if (
      name === 'createSession' ||
      name === 'session' ||
      path === '/session' ||
      path.endsWith('/session') ||
      name === 'agentlogs' ||
      name === 'notifications'
    ) {
      continue
    }

    const isMutation = typeof op['x-is-mutation'] === 'boolean' ? op['x-is-mutation'] as boolean : null
    const description = (op.summary as string) || operationId || name

    const params: GameCommandParam[] = []
    const rb = op.requestBody as Record<string, unknown> | undefined
    if (rb) {
      const content = (rb.content as Record<string, Record<string, unknown>>)?.['application/json']
      const schema = mergeObjectSchema(spec, asRecord(content?.schema))
      if (Object.keys(schema.properties).length > 0) {
        const props = schema.properties
        const required = new Set(schema.required)
        for (const [pname, pinfo] of Object.entries(props)) {
          if (pname === 'action') continue
          params.push({
            name: pname,
            type: (pinfo.type as string) || 'string',
            required: required.has(pname),
            description: (pinfo.description as string) || '',
          })
        }
      }
    }

    commands.push({ name, description, isMutation, params })
  }

  return commands
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((cmd, index, list) => list.findIndex((other) => other.name === cmd.name) === index)
}

export async function fetchGameCommands(baseUrl: string, log?: SpecLogFn): Promise<GameCommandInfo[]> {
  let spec: Record<string, unknown> | null = null
  for (const specUrl of getOpenApiSpecUrls(baseUrl)) {
    spec = await fetchOpenApiSpec(specUrl, log)
    if (spec) break
  }
  if (!spec) return []

  return extractGameCommandsFromOpenApiSpec(spec)
}

/**
 * Format a single command as a compact signature line for the system prompt.
 * Examples:
 *   mine -- Mine resources at current location
 *   storage(action="deposit", item_id, quantity?, target?) -- Move items from cargo to station storage or into a carrier bay when target=self
 *   storage(action="view", station_id?) -- View your storage at a station
 */
function formatCommandSignature(cmd: GameCommandInfo): string {
  let sig = cmd.name
  if (cmd.params.length > 0) {
    const paramList = cmd.params.map(p => p.required ? p.name : `${p.name}?`).join(', ')
    sig += `(${paramList})`
  }
  return `  ${sig} -- ${cmd.description}`
}

/**
 * Format commands with parameter signatures and descriptions for the system prompt.
 */
export function formatCommandList(commands: GameCommandInfo[]): string {
  const queries = commands.filter(c => c.isMutation === false)
  const mutations = commands.filter(c => c.isMutation === true)
  const unknown = commands.filter(c => c.isMutation == null)

  const lines: string[] = []
  if (queries.length > 0) {
    lines.push('Query commands (free, no tick cost):')
    for (const cmd of queries) lines.push(formatCommandSignature(cmd))
  }
  if (mutations.length > 0) {
    lines.push('Action commands (costs 1 tick):')
    for (const cmd of mutations) lines.push(formatCommandSignature(cmd))
  }
  if (unknown.length > 0) {
    lines.push('Unclassified commands (tick cost not exposed by current API metadata):')
    for (const cmd of unknown) lines.push(formatCommandSignature(cmd))
  }
  return lines.join('\n')
}
export function mergeCommandMetadata(
  base: GameCommandInfo[],
  runtime: GameCommandInfo[],
): GameCommandInfo[] {
  const merged = new Map<string, GameCommandInfo>()
  for (const command of base) {
    merged.set(command.name.trim(), command)
  }

  for (const command of runtime) {
    const key = command.name.trim()
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, command)
      continue
    }
    merged.set(key, {
      ...existing,
      description: command.description || existing.description,
      isMutation: command.isMutation ?? existing.isMutation,
      params: command.params.length > 0 ? command.params : existing.params,
    })
  }

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}
