import { getModel, getModels, getProviders, getOAuthApiKey } from '@mariozechner/pi-ai'
import type { Model, KnownProvider } from '@mariozechner/pi-ai'
import { getPreference, getProvider, setPreference } from './db'

const LOCALHOST = '127.0.0.1'

interface ParsedModel {
  provider: string
  modelId: string
}

function parseModelString(modelStr: string): ParsedModel {
  const slashIdx = modelStr.indexOf('/')
  if (slashIdx === -1) {
    throw new Error(`Invalid model string "${modelStr}". Expected: provider/model-id`)
  }
  return {
    provider: modelStr.slice(0, slashIdx),
    modelId: modelStr.slice(slashIdx + 1),
  }
}

const CUSTOM_BASE_URLS: Record<string, string> = {
  ollama: `http://${LOCALHOST}:11434/v1`,
  lmstudio: `http://${LOCALHOST}:1234/v1`,
  vllm: `http://${LOCALHOST}:8000/v1`,
  minimax: 'https://api.minimax.io/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
}

/**
 * Resolve a model string like "anthropic/claude-sonnet-4-20250514" to a pi-ai Model.
 * Reads API keys from the providers DB table instead of environment variables.
 */
export async function resolveModel(modelStr: string): Promise<{ model: Model<any>; apiKey?: string; failoverApiKey?: string }> {
  const { provider, modelId: rawModelId } = parseModelString(modelStr)

  let modelId = rawModelId
  // Normalize only true double-prefixes like "nvidia/nvidia/model-id".
  // Keep single provider prefixes (for providers that require them, e.g. NVIDIA).
  const doublePrefix = `${provider}/${provider}/`
  if (modelId.startsWith(doublePrefix)) {
    modelId = modelId.slice(provider.length + 1)
  }
  // OpenRouter expects provider-prefixed model ids.
  if (provider === 'openrouter' && !modelId.includes('/')) {
    modelId = `openrouter/${modelId}`
  }

  // OAuth-backed providers (e.g. google-gemini-cli)
  if (provider === 'google-gemini-cli' || provider === 'google-antigravity') {
    const providerId = provider as 'google-gemini-cli' | 'google-antigravity'
    const auth = loadOAuthCredentials()
    const oauth = await getOAuthApiKey(providerId, auth)
    if (!oauth) {
      throw new Error(`No OAuth credentials for ${provider}. Run OAuth setup in Settings.`)
    }
    auth[providerId] = oauth.newCredentials
    saveOAuthCredentials(auth)

    const oauthModel = getModel(provider as KnownProvider, modelId as never)
    if (!oauthModel) {
      throw new Error(`Unknown OAuth model "${provider}/${modelId}"`)
    }
    return { model: oauthModel, apiKey: oauth.apiKey }
  }

  // Try built-in registry first
  const knownProviders = getProviders()
  if (knownProviders.includes(provider as KnownProvider)) {
    const keys = getApiKeysFromDb(provider)

    try {
      const model = getModel(provider as KnownProvider, modelId as never)
      if (model) return { model, apiKey: keys.apiKey, failoverApiKey: keys.failoverApiKey }
    } catch {
      // Fall through
    }

    const providerModels = getModels(provider as KnownProvider)
    if (providerModels.length > 0) {
      const base = providerModels[0]
      const model: Model<any> = { ...base, id: modelId, name: modelId }
      return { model, apiKey: keys.apiKey, failoverApiKey: keys.failoverApiKey }
    }
  }

  // Custom/local provider
  let baseUrl = CUSTOM_BASE_URLS[provider]
  let apiKey: string

  if (baseUrl) {
    // Check if we have a custom base URL or API key in DB
    const dbProvider = getProvider(provider)
    if (dbProvider?.base_url) baseUrl = dbProvider.base_url
    apiKey = dbProvider?.api_key || 'local'
  } else {
    const dbProvider = getProvider(provider)
    if (dbProvider?.base_url) {
      baseUrl = dbProvider.base_url
      apiKey = dbProvider.api_key || 'local'
    } else {
      throw new Error(`Unknown provider "${provider}". Configure it in Admiral settings.`)
    }
  }

  const groqModels = getModels('groq')
  if (groqModels.length === 0) {
    throw new Error('No built-in groq models found for custom model template')
  }
  const base = groqModels[0]
  const model: Model<any> = {
    ...base,
    id: modelId,
    name: modelId,
    provider: provider,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  }

  const keys = getApiKeysFromDb(provider)
  return { model, apiKey: keys.apiKey || apiKey, failoverApiKey: keys.failoverApiKey }
}

function loadOAuthCredentials(): Record<string, any> {
  const raw = getPreference('oauth_auth_json')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveOAuthCredentials(auth: Record<string, any>): void {
  setPreference('oauth_auth_json', JSON.stringify(auth))
}

function getApiKeysFromDb(provider: string): { apiKey?: string; failoverApiKey?: string } {
  const dbProvider = getProvider(provider)
  return {
    apiKey: dbProvider?.api_key || undefined,
    failoverApiKey: dbProvider?.failover_api_key || undefined,
  }
}
