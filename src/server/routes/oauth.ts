import { Hono } from 'hono'
import { loginGeminiCli } from '@mariozechner/pi-ai'
import { getPreference, getProvider, setPreference, upsertProvider } from '../lib/db'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

type SessionStatus = 'starting' | 'awaiting_auth' | 'running' | 'completed' | 'error'

interface OAuthSession {
  id: string
  provider: 'google-gemini-cli'
  status: SessionStatus
  createdAt: number
  updatedAt: number
  authUrl?: string
  instructions?: string
  progress: string[]
  error?: string
}

const oauth = new Hono()
const sessions = new Map<string, OAuthSession>()
const manualInputResolvers = new Map<string, (redirectUrl: string) => void>()
const SESSION_TTL_MS = 30 * 60 * 1000

function now(): number {
  return Date.now()
}

function pruneSessions(): void {
  const cutoff = now() - SESSION_TTL_MS
  for (const [id, s] of sessions.entries()) {
    if (s.updatedAt < cutoff) {
      sessions.delete(id)
      manualInputResolvers.delete(id)
    }
  }
}

function findActiveSession(provider: OAuthSession['provider']): OAuthSession | null {
  for (const s of sessions.values()) {
    if (s.provider !== provider) continue
    if (s.status === 'starting' || s.status === 'awaiting_auth' || s.status === 'running') return s
  }
  return null
}

function loadOAuthAuthMap(): Record<string, any> {
  const raw = getPreference('oauth_auth_json')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveOAuthAuthMap(value: Record<string, any>): void {
  setPreference('oauth_auth_json', JSON.stringify(value))
}

function getGeminiCliCurrentAuth(): { connected: boolean; projectId: string | null; email: string | null; expires: number | null } {
  const auth = loadOAuthAuthMap()
  const creds = auth['google-gemini-cli'] as Record<string, unknown> | undefined
  if (!creds || typeof creds !== 'object') {
    return { connected: false, projectId: null, email: null, expires: null }
  }
  return {
    connected: true,
    projectId: typeof creds.projectId === 'string' ? creds.projectId : null,
    email: typeof creds.email === 'string' ? creds.email : null,
    expires: typeof creds.expires === 'number' ? creds.expires : null,
  }
}

oauth.post('/google-gemini-cli/start', async (c) => {
  pruneSessions()
  const active = findActiveSession('google-gemini-cli')
  if (active) {
    return c.json({
      error: 'OAuth session already running',
      sessionId: active.id,
      status: active.status,
    }, 409)
  }
  const id = `oauth-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`
  const session: OAuthSession = {
    id,
    provider: 'google-gemini-cli',
    status: 'starting',
    createdAt: now(),
    updatedAt: now(),
    progress: [],
  }
  sessions.set(id, session)

  ;(async () => {
    let lastProgressAt = now()
    let hintSent = false
    const hintTimer = setInterval(() => {
      const current = sessions.get(id)
      if (!current) return
      if (current.status !== 'running' && current.status !== 'awaiting_auth') return
      const idleMs = now() - lastProgressAt
      if (!hintSent && idleMs > 90_000) {
        hintSent = true
        current.progress = [
          ...current.progress.slice(-19),
          'Still waiting on Google Cloud Code Assist project check. If this stalls, set GOOGLE_CLOUD_PROJECT (or GOOGLE_CLOUD_PROJECT_ID) on the Admiral server and retry.',
        ]
        current.updatedAt = now()
      }
    }, 5000)
    try {
      const creds = await loginGeminiCli(
        ({ url, instructions }) => {
          const current = sessions.get(id)
          if (!current) return
          current.status = 'awaiting_auth'
          current.authUrl = url
          current.instructions = instructions
          current.updatedAt = now()
          lastProgressAt = now()
        },
        (message) => {
          const current = sessions.get(id)
          if (!current) return
          current.status = current.status === 'awaiting_auth' ? 'awaiting_auth' : 'running'
          current.progress = [...current.progress.slice(-19), message]
          current.updatedAt = now()
          lastProgressAt = now()
        },
        () =>
          new Promise<string>((resolve) => {
            manualInputResolvers.set(id, resolve)
          }),
      )

      const auth = loadOAuthAuthMap()
      auth['google-gemini-cli'] = { type: 'oauth', ...creds }
      saveOAuthAuthMap(auth)

      const existing = getProvider('google-gemini-cli')
      upsertProvider(
        'google-gemini-cli',
        existing?.api_key || '',
        existing?.failover_api_key || '',
        existing?.base_url || '',
        'valid',
      )

      const current = sessions.get(id)
      if (current) {
        current.status = 'completed'
        current.updatedAt = now()
      }
      clearInterval(hintTimer)
      manualInputResolvers.delete(id)
    } catch (err) {
      const current = sessions.get(id)
      if (current) {
        current.status = 'error'
        current.error = err instanceof Error ? err.message : String(err)
        current.updatedAt = now()
      }
      clearInterval(hintTimer)
      manualInputResolvers.delete(id)
    }
  })()

  return c.json({ sessionId: id })
})

oauth.get('/google-gemini-cli/status/:sessionId', (c) => {
  pruneSessions()
  const sessionId = c.req.param('sessionId')
  const session = sessions.get(sessionId)
  if (!session) return c.json({ error: 'Session not found' }, 404)
  return c.json({
    sessionId: session.id,
    provider: session.provider,
    status: session.status,
    authUrl: session.authUrl || null,
    instructions: session.instructions || null,
    progress: session.progress,
    error: session.error || null,
  })
})

oauth.get('/google-gemini-cli/current', (c) => {
  return c.json(getGeminiCliCurrentAuth())
})

oauth.get('/google-gemini-cli/detect-project', async (c) => {
  const fromAuth = getGeminiCliCurrentAuth().projectId
  if (fromAuth) return c.json({ projectId: fromAuth, source: 'oauth_auth_json' })

  const fromEnv = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID
  if (fromEnv) return c.json({ projectId: fromEnv, source: 'environment' })

  const fromGcloud = await detectViaGcloud()
  if (fromGcloud) return c.json({ projectId: fromGcloud, source: 'gcloud_config' })

  const fromAdc = detectViaAdc()
  if (fromAdc) return c.json({ projectId: fromAdc, source: 'adc_file' })

  return c.json({ projectId: null, source: null }, 404)
})

async function detectViaGcloud(): Promise<string | null> {
  try {
    const out = execFileSync('gcloud', ['config', 'get-value', 'project'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const v = out.trim()
    if (!v || v === '(unset)') return null
    return v
  } catch {
    return null
  }
}

function detectViaAdc(): string | null {
  const candidates = [
    path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json'),
    path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
  ]
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const projectId = typeof parsed.project_id === 'string'
        ? parsed.project_id
        : (typeof parsed.quota_project_id === 'string' ? parsed.quota_project_id : null)
      if (projectId) return projectId
    } catch {
      // ignore
    }
  }
  return null
}

oauth.post('/google-gemini-cli/manual/:sessionId', async (c) => {
  pruneSessions()
  const sessionId = c.req.param('sessionId')
  const session = sessions.get(sessionId)
  if (!session) return c.json({ error: 'Session not found' }, 404)

  const { redirectUrl } = await c.req.json()
  if (!redirectUrl || typeof redirectUrl !== 'string') {
    return c.json({ error: 'Missing redirectUrl' }, 400)
  }

  const resolver = manualInputResolvers.get(sessionId)
  if (!resolver) {
    return c.json({ error: 'Session is not waiting for manual input' }, 409)
  }

  resolver(redirectUrl)
  manualInputResolvers.delete(sessionId)
  session.updatedAt = now()
  session.progress = [...session.progress.slice(-19), 'Manual callback URL received']
  return c.json({ ok: true })
})

export default oauth
