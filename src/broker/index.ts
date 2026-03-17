import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { BrokerSessionManager } from './session-manager'
import type {
  BrokerConnectRequest,
  BrokerExecuteRequest,
  BrokerLoginRequest,
  BrokerRegisterRequest,
  BrokerRunningIntentRequest,
} from '../shared/broker-types'

const app = new Hono()
app.use('*', cors())

const manager = new BrokerSessionManager()
void manager.restorePersistedSessions().catch((err) => {
  console.error(`[broker] restore failed: ${err instanceof Error ? err.message : String(err)}`)
})

app.get('/api/broker/health', (c) => c.json({ ok: true }))

app.get('/api/broker/sessions', (c) => {
  return c.json({ sessions: manager.listSessions() })
})

app.get('/api/broker/sessions/:id', (c) => {
  const session = manager.getSession(c.req.param('id'))
  if (!session) return c.json({ error: 'Session not found' }, 404)
  return c.json({ session })
})

app.put('/api/broker/sessions/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json() as BrokerConnectRequest
  if (!body?.serverUrl) return c.json({ error: 'serverUrl is required' }, 400)
  try {
    const session = await manager.connect(id, body)
    return c.json({ session })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.post('/api/broker/sessions/:id/login', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json() as BrokerLoginRequest
  if (!body?.username || !body?.password) return c.json({ error: 'username and password are required' }, 400)
  try {
    return c.json(await manager.login(id, body))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.post('/api/broker/sessions/:id/register', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json() as BrokerRegisterRequest
  if (!body?.username || !body?.empire) return c.json({ error: 'username and empire are required' }, 400)
  try {
    return c.json(await manager.register(id, body))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.post('/api/broker/sessions/:id/execute', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json() as BrokerExecuteRequest
  if (!body?.command || !body?.requestId) return c.json({ error: 'command and requestId are required' }, 400)
  try {
    return c.json(await manager.execute(id, body))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.get('/api/broker/sessions/:id/events', (c) => {
  const id = c.req.param('id')
  const sinceSeq = Number(c.req.query('sinceSeq') || '0')
  const response = manager.getEvents(id, Number.isFinite(sinceSeq) ? sinceSeq : 0)
  if (!response) return c.json({ error: 'Session not found' }, 404)
  return c.json(response)
})

app.post('/api/broker/sessions/:id/running-intent', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json() as BrokerRunningIntentRequest
  if (typeof body?.runningIntent !== 'boolean') return c.json({ error: 'runningIntent must be boolean' }, 400)
  const session = manager.setRunningIntent(id, body.runningIntent)
  if (!session) return c.json({ error: 'Session not found' }, 404)
  return c.json({ session })
})

app.delete('/api/broker/sessions/:id', async (c) => {
  const session = await manager.disconnect(c.req.param('id'))
  if (!session) return c.json({ error: 'Session not found' }, 404)
  return c.json({ session })
})

const port = parseInt(process.env.ADMIRAL_BROKER_PORT || '3032')
console.log(`Admiral broker listening on http://0.0.0.0:${port}`)

export default {
  port,
  hostname: '0.0.0.0',
  fetch: app.fetch,
}
