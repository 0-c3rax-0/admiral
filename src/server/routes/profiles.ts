import { Hono } from 'hono'
import { listProfiles, getProfile, createProfile, updateProfile, deleteProfile } from '../lib/db'
import { agentManager } from '../lib/agent-manager'
import { is429PredictionEnabled, predict429Risk } from '../lib/loop'

const profiles = new Hono()

// GET /api/profiles
profiles.get('/', (c) => {
  const all = listProfiles()
  return c.json(all.map(p => ({ ...p, ...agentManager.getStatus(p.id), rate_risk: getRateRiskPayload(p.id) })))
})

// POST /api/profiles
profiles.post('/', async (c) => {
  const body = await c.req.json()
  const { name, username, password, empire, provider, model, directive, connection_mode, server_url, context_budget } = body
  if (!name) return c.json({ error: 'Name is required' }, 400)
  try {
    const profile = createProfile({
      id: crypto.randomUUID(),
      name,
      username: username || null,
      password: password || null,
      empire: empire || '',
      player_id: null,
      provider: provider || null,
      model: model || null,
      failover_provider: null,
      failover_model: null,
      directive: directive || '',
      todo: '',
      context_budget: context_budget ?? null,
      connection_mode: connection_mode || 'http',
      server_url: server_url || 'https://game.spacemolt.com',
      autoconnect: true,
      enabled: true,
    })
    return c.json(profile, 201)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('UNIQUE constraint')) return c.json({ error: 'A profile with that name already exists' }, 409)
    return c.json({ error: msg }, 500)
  }
})

// GET /api/profiles/:id
profiles.get('/:id', (c) => {
  const profile = getProfile(c.req.param('id'))
  if (!profile) return c.json({ error: 'Not found' }, 404)
  const status = agentManager.getStatus(c.req.param('id'))
  return c.json({ ...profile, ...status, rate_risk: getRateRiskPayload(c.req.param('id')) })
})

// PUT /api/profiles/:id
profiles.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const profile = updateProfile(id, body)
  if (!profile) return c.json({ error: 'Not found' }, 404)
  if (body.directive !== undefined) agentManager.restartTurn(id)
  return c.json(profile)
})

// DELETE /api/profiles/:id
profiles.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await agentManager.disconnect(id)
  deleteProfile(id)
  return c.json({ ok: true })
})

// POST /api/profiles/:id/connect
profiles.post('/:id/connect', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const action = (body as Record<string, unknown>).action as string || 'connect'
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  try {
    if (action === 'disconnect') {
      await agentManager.disconnect(id)
      return c.json({ connected: false, running: false })
    }
    await agentManager.connect(id)
    if (action === 'connect_llm' && profile.provider && profile.provider !== 'manual' && profile.model) {
      await agentManager.startLLM(id)
    }
    return c.json(agentManager.getStatus(id))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith('CONNECT_THROTTLED:')) {
      return c.json({ error: msg.replace('CONNECT_THROTTLED:', '').trim() }, 429)
    }
    return c.json({ error: msg }, 500)
  }
})

// POST /api/profiles/:id/command
profiles.post('/:id/command', async (c) => {
  const id = c.req.param('id')
  const { command, args } = await c.req.json()
  if (!command) return c.json({ error: 'Missing command' }, 400)
  const agent = agentManager.getAgent(id)
  if (!agent || !agent.isConnected) return c.json({ error: 'Agent not connected' }, 400)
  try {
    const result = await agent.executeCommand(command, args)
    return c.json(result)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// POST /api/profiles/:id/nudge
profiles.post('/:id/nudge', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const message = (body as Record<string, unknown>).message as string
  if (!message?.trim()) return c.json({ error: 'message is required' }, 400)
  const status = agentManager.getStatus(id)
  if (!status.running) return c.json({ error: 'Agent is not running' }, 400)
  agentManager.nudge(id, message.trim())
  return c.json({ ok: true })
})

// GET /api/profiles/:id/memory
profiles.get('/:id/memory', (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  const content = agentManager.getMemory(id)
  return c.json({ content })
})

// POST /api/profiles/:id/memory/save
profiles.post('/:id/memory/save', (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  const saved = agentManager.saveMemory(id)
  return c.json({ ok: true, saved })
})

// DELETE /api/profiles/:id/memory
profiles.delete('/:id/memory', (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  agentManager.resetMemory(id)
  return c.json({ ok: true })
})

export default profiles

function getRateRiskPayload(profileId: string) {
  if (!is429PredictionEnabled()) return null
  const risk = predict429Risk(profileId)
  return risk.level === 'LOW' ? null : risk
}
