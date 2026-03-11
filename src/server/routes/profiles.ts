import { Hono } from 'hono'
import { listProfiles, getProfile, createProfile, updateProfile, deleteProfile } from '../lib/db'
import { overwriteProfileAgentsFromDirective } from '../lib/agent'
import { agentManager } from '../lib/agent-manager'
import { setAgentRole } from '../lib/agent-learning'
import { buildProfileResponse, handleProfileCommandSideEffects } from '../../fork/server'

const profiles = new Hono()

profiles.get('/', (c) => {
  return c.json(listProfiles().map(buildProfileResponse))
})

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
    return c.json(buildProfileResponse(profile), 201)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('UNIQUE constraint')) return c.json({ error: 'A profile with that name already exists' }, 409)
    return c.json({ error: msg }, 500)
  }
})

profiles.get('/:id', (c) => {
  const profile = getProfile(c.req.param('id'))
  if (!profile) return c.json({ error: 'Not found' }, 404)
  return c.json(buildProfileResponse(profile))
})

profiles.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  if (body.agent_role !== undefined) {
    setAgentRole(id, String(body.agent_role))
  }
  const profile = updateProfile(id, body)
  if (!profile) return c.json({ error: 'Not found' }, 404)
  if (body.directive !== undefined) {
    overwriteProfileAgentsFromDirective(profile)
    const tsUtc = new Date().toISOString()
    console.log(`[profiles] Directive updated for "${profile.name}" (${id}) at ${tsUtc}; length=${(profile.directive || '').length}`)
    agentManager.restartTurn(id)
  }
  return c.json(buildProfileResponse(profile))
})

profiles.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await agentManager.disconnect(id)
  deleteProfile(id)
  return c.json({ ok: true })
})

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

profiles.post('/:id/command', async (c) => {
  const id = c.req.param('id')
  const { command, args } = await c.req.json()
  if (!command) return c.json({ error: 'Missing command' }, 400)
  const agent = agentManager.getAgent(id)
  if (!agent || !agent.isConnected) return c.json({ error: 'Agent not connected' }, 400)
  try {
    const result = await agent.executeCommand(command, args)
    handleProfileCommandSideEffects(id, command, args, result)
    return c.json(result)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

profiles.post('/batch', async (c) => {
  const body = await c.req.json()
  const action = body.action as string
  const profileIds = body.ids as string[] | undefined
  const group = body.group as string | undefined

  if (!action || !['connect_llm', 'disconnect'].includes(action)) {
    return c.json({ error: 'action must be connect_llm or disconnect' }, 400)
  }

  let targets = listProfiles()
  if (profileIds && profileIds.length > 0) {
    const idSet = new Set(profileIds)
    targets = targets.filter(p => idSet.has(p.id))
  }
  if (group) {
    targets = targets.filter(p => (p as unknown as Record<string, unknown>).group_name === group)
  }

  const results: Array<{ id: string; name: string; ok: boolean; error?: string }> = []

  for (const profile of targets) {
    try {
      if (action === 'disconnect') {
        await agentManager.disconnect(profile.id)
        results.push({ id: profile.id, name: profile.name, ok: true })
      } else {
        await agentManager.connect(profile.id)
        if (profile.provider && profile.provider !== 'manual' && profile.model) {
          await agentManager.startLLM(profile.id)
        }
        results.push({ id: profile.id, name: profile.name, ok: true })
      }
    } catch (err) {
      results.push({ id: profile.id, name: profile.name, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return c.json({ action, count: results.length, results })
})

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

profiles.get('/:id/memory', (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  return c.json({ content: agentManager.getMemory(id) })
})

profiles.post('/:id/memory/save', (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  return c.json({ ok: true, saved: agentManager.saveMemory(id) })
})

profiles.delete('/:id/memory', (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  agentManager.resetMemory(id)
  return c.json({ ok: true })
})

export default profiles
