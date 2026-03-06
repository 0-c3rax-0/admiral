import { Hono } from 'hono'
import { listProviders, upsertProvider } from '../lib/db'
import { validateApiKey, detectLocalProviders } from '../lib/providers'

const providers = new Hono()

providers.get('/', (c) => c.json(listProviders()))

providers.put('/', async (c) => {
  const { id, api_key, failover_api_key, base_url } = await c.req.json()
  const primaryKey = api_key || ''
  const failoverKey = failover_api_key || ''
  const validationKey = primaryKey || failoverKey
  if (!id) return c.json({ error: 'Missing provider id' }, 400)

  let status = 'unknown'
  if (id === 'google-gemini-cli') {
    // OAuth-backed provider: auth state is managed outside Admiral (local CLI session).
    status = 'valid'
  } else if ((id === 'custom' || id === 'ollama' || id === 'lmstudio') && base_url) {
    try {
      const modelsUrl = id === 'ollama'
        ? base_url.replace(/\/v1\/?$/, '') + '/api/tags'
        : base_url.replace(/\/+$/, '') + '/models'
      const headers: Record<string, string> = {}
      if (validationKey) headers['Authorization'] = `Bearer ${validationKey}`
      const resp = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(5000) })
      status = resp.ok ? 'valid' : 'unreachable'
    } catch { status = 'unreachable' }
  } else if (validationKey) {
    status = (await validateApiKey(id, validationKey)) ? 'valid' : 'invalid'
  }

  upsertProvider(id, primaryKey, failoverKey, base_url || '', status)
  return c.json({ id, status })
})

providers.post('/detect', async (c) => {
  let customUrls: Record<string, string> = {}
  try { const body = await c.req.json(); customUrls = body?.urls || {} } catch {}
  return c.json(await detectLocalProviders(customUrls))
})

export default providers
