import { useState, useEffect } from 'react'
import { KeyRound, Wifi, WifiOff, Search, Server, X } from 'lucide-react'
import type { Provider } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ModelPicker } from '@/components/ModelPicker'

const LOCALHOST = '127.0.0.1'

const DEFAULT_LOCAL_URLS: Record<string, string> = {
  ollama: `http://${LOCALHOST}:11434`,
  lmstudio: `http://${LOCALHOST}:1234`,
}

const PROVIDER_INFO: Record<string, { label: string; description: string; isLocal: boolean; keyPlaceholder: string }> = {
  anthropic: { label: 'Anthropic', description: 'Claude models', isLocal: false, keyPlaceholder: 'sk-ant-...' },
  openai: { label: 'OpenAI', description: 'GPT models', isLocal: false, keyPlaceholder: 'sk-...' },
  groq: { label: 'Groq', description: 'Fast inference', isLocal: false, keyPlaceholder: 'gsk_...' },
  google: { label: 'Google AI', description: 'Gemini models', isLocal: false, keyPlaceholder: 'AI...' },
  'google-gemini-cli': { label: 'Google Gemini OAuth', description: 'Gemini via local OAuth session', isLocal: true, keyPlaceholder: '' },
  xai: { label: 'xAI', description: 'Grok models', isLocal: false, keyPlaceholder: 'xai-...' },
  mistral: { label: 'Mistral', description: 'Mistral models', isLocal: false, keyPlaceholder: '' },
  minimax: { label: 'MiniMax', description: 'MiniMax models', isLocal: false, keyPlaceholder: 'eyJ...' },
  nvidia: { label: 'NVIDIA NIM', description: 'NVIDIA hosted models', isLocal: false, keyPlaceholder: 'nvapi-...' },
  openrouter: { label: 'OpenRouter', description: 'Multi-provider gateway', isLocal: false, keyPlaceholder: 'sk-or-...' },
  ollama: { label: 'Ollama', description: 'Local models', isLocal: true, keyPlaceholder: '' },
  lmstudio: { label: 'LM Studio', description: 'Local models', isLocal: true, keyPlaceholder: '' },
  custom: { label: 'Custom', description: 'Any OpenAI-compatible endpoint', isLocal: true, keyPlaceholder: '' },
}

interface Props {
  providers: Provider[]
  registrationCode: string
  onRegistrationCodeChange: (code: string) => void
  gameserverUrl: string
  onGameserverUrlChange: (url: string) => void
  maxTurns: number
  onMaxTurnsChange: (turns: number) => void
  llmTimeout: number
  onLlmTimeoutChange: (seconds: number) => void
  startupAutoconnectEnabled: boolean
  onStartupAutoconnectEnabledChange: (enabled: boolean) => void
  startupAutoconnectMinDelaySec: number
  onStartupAutoconnectMinDelaySecChange: (seconds: number) => void
  startupAutoconnectMaxDelaySec: number
  onStartupAutoconnectMaxDelaySecChange: (seconds: number) => void
  predict429Enabled: boolean
  onPredict429EnabledChange: (enabled: boolean) => void
  compactInputEnabled: boolean
  onCompactInputEnabledChange: (enabled: boolean) => void
  compactInputProvider: string
  onCompactInputProviderChange: (provider: string) => void
  compactInputModel: string
  onCompactInputModelChange: (model: string) => void
  altSolverEnabled: boolean
  onAltSolverEnabledChange: (enabled: boolean) => void
  altSolverProvider: string
  onAltSolverProviderChange: (provider: string) => void
  altSolverModel: string
  onAltSolverModelChange: (model: string) => void
  onClose: () => void
}

export function ProviderSetup({
  providers: initialProviders,
  registrationCode,
  onRegistrationCodeChange,
  gameserverUrl,
  onGameserverUrlChange,
  maxTurns,
  onMaxTurnsChange,
  llmTimeout,
  onLlmTimeoutChange,
  startupAutoconnectEnabled,
  onStartupAutoconnectEnabledChange,
  startupAutoconnectMinDelaySec,
  onStartupAutoconnectMinDelaySecChange,
  startupAutoconnectMaxDelaySec,
  onStartupAutoconnectMaxDelaySecChange,
  predict429Enabled,
  onPredict429EnabledChange,
  compactInputEnabled,
  onCompactInputEnabledChange,
  compactInputProvider,
  onCompactInputProviderChange,
  compactInputModel,
  onCompactInputModelChange,
  altSolverEnabled,
  onAltSolverEnabledChange,
  altSolverProvider,
  onAltSolverProviderChange,
  altSolverModel,
  onAltSolverModelChange,
  onClose,
}: Props) {
  const [providers, setProviders] = useState(initialProviders)
  const [keys, setKeys] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const p of initialProviders) m[p.id] = p.api_key || ''
    return m
  })
  const [failoverKeys, setFailoverKeys] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const p of initialProviders) m[p.id] = p.failover_api_key || ''
    return m
  })
  const [urls, setUrls] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const p of initialProviders) {
      if (DEFAULT_LOCAL_URLS[p.id]) {
        const stored = p.base_url?.replace(/\/v1\/?$/, '') || ''
        m[p.id] = stored || DEFAULT_LOCAL_URLS[p.id]
      } else if (p.id === 'custom') {
        m[p.id] = p.base_url?.replace(/\/v1\/?$/, '') || ''
      }
    }
    return m
  })
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [detecting, setDetecting] = useState(false)
  const [oauthSessionId, setOauthSessionId] = useState<string | null>(null)
  const [oauthStatus, setOauthStatus] = useState<'idle' | 'starting' | 'awaiting_auth' | 'running' | 'completed' | 'error'>('idle')
  const [oauthMessage, setOauthMessage] = useState('')
  const [oauthManualRedirectUrl, setOauthManualRedirectUrl] = useState('')
  const [oauthStartedAt, setOauthStartedAt] = useState<number | null>(null)
  const [oauthCurrentProjectId, setOauthCurrentProjectId] = useState<string | null>(null)
  const [oauthCurrentEmail, setOauthCurrentEmail] = useState<string | null>(null)
  const [oauthProjectDetectSource, setOauthProjectDetectSource] = useState<string | null>(null)

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [onClose])

  useEffect(() => {
    ;(async () => {
      try {
        const resp = await fetch('/api/oauth/google-gemini-cli/current')
        if (!resp.ok) return
        const data = await resp.json()
        setOauthCurrentProjectId(data.projectId || null)
        setOauthCurrentEmail(data.email || null)
        setOauthProjectDetectSource(data.projectId ? 'oauth_auth_json' : null)
      } catch {
        // ignore
      }
    })()
  }, [])

  useEffect(() => {
    if (!oauthSessionId) return
    let cancelled = false
    let openedAuthWindow = false
    const timer = setInterval(async () => {
      try {
        const resp = await fetch(`/api/oauth/google-gemini-cli/status/${encodeURIComponent(oauthSessionId)}`)
        if (!resp.ok) return
        const data = await resp.json()
        if (cancelled) return
        setOauthStatus(data.status || 'running')
        const latestMsg = (data.progress && data.progress.length > 0)
          ? data.progress[data.progress.length - 1]
          : (data.instructions || '')
        setOauthMessage(data.error || latestMsg || '')
        if (data.authUrl && !openedAuthWindow) {
          openedAuthWindow = true
          window.open(data.authUrl, '_blank', 'noopener,noreferrer')
        }
        if (data.status === 'completed' || data.status === 'error') {
          clearInterval(timer)
          setOauthSessionId(null)
          setOauthStartedAt(null)
          try {
            const authResp = await fetch('/api/oauth/google-gemini-cli/current')
            if (authResp.ok) {
              const authData = await authResp.json()
              if (!cancelled) {
                setOauthCurrentProjectId(authData.projectId || null)
                setOauthCurrentEmail(authData.email || null)
                setOauthProjectDetectSource(authData.projectId ? 'oauth_auth_json' : null)
              }
            }
          } catch {
            // ignore
          }
          const provResp = await fetch('/api/providers')
          if (provResp.ok) {
            const nextProviders = await provResp.json()
            if (!cancelled) setProviders(nextProviders)
          }
        }
      } catch {
        // ignore transient polling errors
      }
    }, 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [oauthSessionId])

  async function saveKey(id: string) {
    setSaving(s => ({ ...s, [id]: true }))
    try {
      const resp = await fetch('/api/providers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, api_key: keys[id] || '', failover_api_key: failoverKeys[id] || '' }),
      })
      const result = await resp.json()
      setProviders(prev => prev.map(p => p.id === id ? {
        ...p,
        status: result.status,
        api_key: keys[id] || '',
        failover_api_key: failoverKeys[id] || '',
      } : p))
    } finally {
      setSaving(s => ({ ...s, [id]: false }))
    }
  }

  async function saveLocalUrl(id: string) {
    setSaving(s => ({ ...s, [id]: true }))
    try {
      const baseUrl = (urls[id] || DEFAULT_LOCAL_URLS[id]).replace(/\/+$/, '') + '/v1'
      const resp = await fetch('/api/providers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, api_key: '', base_url: baseUrl }),
      })
      const result = await resp.json()
      setProviders(prev => prev.map(p => p.id === id ? { ...p, status: result.status, base_url: baseUrl } : p))
    } finally {
      setSaving(s => ({ ...s, [id]: false }))
    }
  }

  async function saveCustomProvider() {
    setSaving(s => ({ ...s, custom: true }))
    try {
      const raw = (urls['custom'] || '').replace(/\/+$/, '')
      const baseUrl = raw ? (raw.endsWith('/v1') ? raw : raw + '/v1') : ''
      const resp = await fetch('/api/providers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'custom',
          api_key: keys['custom'] || '',
          failover_api_key: failoverKeys['custom'] || '',
          base_url: baseUrl,
        }),
      })
      const result = await resp.json()
      setProviders(prev => prev.map(p => p.id === 'custom' ? {
        ...p,
        status: result.status,
        api_key: keys['custom'] || '',
        failover_api_key: failoverKeys['custom'] || '',
        base_url: baseUrl,
      } : p))
    } finally {
      setSaving(s => ({ ...s, custom: false }))
    }
  }

  async function detectLocal() {
    setDetecting(true)
    try {
      const customUrls: Record<string, string> = {}
      for (const [id, url] of Object.entries(urls)) {
        if (url && url !== DEFAULT_LOCAL_URLS[id]) {
          customUrls[id] = url.replace(/\/+$/, '')
        }
      }
      const resp = await fetch('/api/providers/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: customUrls }),
      })
      const results = await resp.json()
      setProviders(prev => {
        const updated = [...prev]
        for (const r of results as Array<{ id: string; status: string; baseUrl: string }>) {
          const idx = updated.findIndex(p => p.id === r.id)
          if (idx >= 0) updated[idx] = { ...updated[idx], status: r.status as Provider['status'], base_url: r.baseUrl }
        }
        return updated
      })
    } finally {
      setDetecting(false)
    }
  }

  async function startGeminiOAuthSetup() {
    setOauthStatus('starting')
    setOauthMessage('Starting OAuth setup...')
    try {
      const resp = await fetch('/api/oauth/google-gemini-cli/start', {
        method: 'POST',
      })
      const data = await resp.json()
      if (!resp.ok) {
        if (resp.status === 409 && data?.sessionId) {
          setOauthSessionId(data.sessionId)
          setOauthStatus(data.status || 'running')
          setOauthMessage('OAuth session already running, reattached to active session.')
          if (!oauthStartedAt) setOauthStartedAt(Date.now())
          return
        }
        setOauthStatus('error')
        setOauthMessage(data?.error || 'Failed to start OAuth setup')
        return
      }
      setOauthSessionId(data.sessionId)
      setOauthStatus('running')
      setOauthStartedAt(Date.now())
    } catch {
      setOauthStatus('error')
      setOauthMessage('Failed to start OAuth setup')
    }
  }

  async function retryGeminiOAuthSetup() {
    setOauthMessage('Retrying OAuth setup...')
    await startGeminiOAuthSetup()
  }

  async function submitManualOAuthRedirect() {
    if (!oauthSessionId || !oauthManualRedirectUrl.trim()) return
    try {
      const resp = await fetch(`/api/oauth/google-gemini-cli/manual/${encodeURIComponent(oauthSessionId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirectUrl: oauthManualRedirectUrl.trim() }),
      })
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}))
        setOauthStatus('error')
        setOauthMessage(data?.error || 'Manual callback submission failed')
        return
      }
      setOauthMessage('Manual callback submitted, waiting for token exchange...')
    } catch {
      setOauthStatus('error')
      setOauthMessage('Manual callback submission failed')
    }
  }

  async function detectProjectId() {
    try {
      const resp = await fetch('/api/oauth/google-gemini-cli/detect-project')
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok || !data?.projectId) {
        setOauthMessage('No project ID detected automatically')
        return
      }
      setOauthCurrentProjectId(data.projectId)
      setOauthProjectDetectSource(data.source || 'detected')
      setOauthMessage(`Detected project ID from ${data.source || 'unknown source'}`)
    } catch {
      setOauthMessage('Project ID detection failed')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative bg-card border border-border w-full max-w-[min(96vw,1480px)] max-h-[92vh] flex flex-col z-10"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between py-2.5 px-4 border-b border-border shrink-0">
          <h2 className="font-jetbrains text-sm font-medium text-primary tracking-[1.5px] uppercase">Settings</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content - scrollable */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5 xl:grid xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.35fr)] xl:gap-5 xl:space-y-0">
          {/* General section */}
          <div className="border border-border/60 bg-background/20 p-4">
            <div className="flex items-center justify-between gap-3 mb-2.5">
              <span className="text-[11px] text-[hsl(var(--smui-orange))] uppercase tracking-[1.5px] font-medium">General</span>
              <span className="text-[10px] text-muted-foreground">Core runtime and LLM controls</span>
            </div>
            <div className="space-y-2.5 mt-2.5">
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">Registration code</span>
                <Input
                  value={registrationCode}
                  onChange={e => onRegistrationCodeChange(e.target.value)}
                  placeholder="From spacemolt.com/dashboard"
                  className="flex-1 h-7 text-xs"
                />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">Gameserver URL</span>
                <Input
                  value={gameserverUrl}
                  onChange={e => onGameserverUrlChange(e.target.value)}
                  placeholder="https://game.spacemolt.com"
                  className="flex-1 h-7 text-xs"
                />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">Max agent turns</span>
                <Input
                  type="number"
                  value={maxTurns}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10)
                    if (!isNaN(v) && v > 0) onMaxTurnsChange(v)
                  }}
                  min={1}
                  max={200}
                  className="w-20 h-7 text-xs"
                />
                <span className="text-[11px] text-muted-foreground">tool rounds per LLM turn</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">LLM timeout</span>
                <Input
                  type="number"
                  value={llmTimeout}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10)
                    if (!isNaN(v) && v > 0) onLlmTimeoutChange(v)
                  }}
                  min={30}
                  max={600}
                  className="w-20 h-7 text-xs"
                />
                <span className="text-[11px] text-muted-foreground">seconds per LLM call</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">Startup autoconnect</span>
                <label className="inline-flex items-center gap-2 text-xs text-foreground cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={startupAutoconnectEnabled}
                    onChange={e => onStartupAutoconnectEnabledChange(e.target.checked)}
                  />
                  Enable on restart
                </label>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">Min delay</span>
                <Input
                  type="number"
                  value={startupAutoconnectMinDelaySec}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10)
                    if (!isNaN(v) && v > 0) onStartupAutoconnectMinDelaySecChange(v)
                  }}
                  min={10}
                  max={3600}
                  className="w-20 h-7 text-xs"
                />
                <span className="text-[11px] text-muted-foreground">seconds between accounts</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">Max delay</span>
                <Input
                  type="number"
                  value={startupAutoconnectMaxDelaySec}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10)
                    if (!isNaN(v) && v > 0) onStartupAutoconnectMaxDelaySecChange(v)
                  }}
                  min={10}
                  max={3600}
                  className="w-20 h-7 text-xs"
                />
                <span className="text-[11px] text-muted-foreground">seconds between accounts</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">429 prediction</span>
                <label className="inline-flex items-center gap-2 text-xs text-foreground cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={predict429Enabled}
                    onChange={e => onPredict429EnabledChange(e.target.checked)}
                  />
                  Enable risk hints in logs
                </label>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">Compact input</span>
                <label className="inline-flex items-center gap-2 text-xs text-foreground cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={compactInputEnabled}
                    onChange={e => onCompactInputEnabledChange(e.target.checked)}
                  />
                  Reduce LLM input context size
                </label>
                <span className="text-[11px] text-muted-foreground">
                  Summarizes only when context exceeds budget (not every request)
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">Reduce provider</span>
                <select
                  value={compactInputProvider}
                  onChange={e => onCompactInputProviderChange(e.target.value)}
                  className="h-7 min-w-36 bg-background border border-input px-2 text-xs font-jetbrains text-foreground"
                >
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>
                      {PROVIDER_INFO[p.id]?.label || p.id}
                    </option>
                  ))}
                </select>
                <span className="text-[11px] text-muted-foreground">model provider for context reduction</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">Reduce model</span>
                <div className="flex-1 min-w-0">
                  <ModelPicker
                    provider={compactInputProvider}
                    value={compactInputModel}
                    onChange={onCompactInputModelChange}
                  />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">Alt solver</span>
                <label className="inline-flex items-center gap-2 text-xs text-foreground cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={altSolverEnabled}
                    onChange={e => onAltSolverEnabledChange(e.target.checked)}
                  />
                  Ask second LLM only when Admiral detects a loop or stalled plan
                </label>
              </div>
              <div className="ml-[7.25rem] text-[11px] text-muted-foreground leading-relaxed">
                Triggers only on repeated blocked actions, repeated identical command loops, or several rounds with unchanged results.
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">Alt provider</span>
                <select
                  value={altSolverProvider}
                  onChange={e => onAltSolverProviderChange(e.target.value)}
                  className="h-7 min-w-36 bg-background border border-input px-2 text-xs font-jetbrains text-foreground"
                >
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>
                      {PROVIDER_INFO[p.id]?.label || p.id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">Alt model</span>
                <div className="flex-1 min-w-0">
                  <ModelPicker
                    provider={altSolverProvider}
                    value={altSolverModel}
                    onChange={onAltSolverModelChange}
                  />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-28 shrink-0">Gemini OAuth</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={startGeminiOAuthSetup}
                  disabled={oauthStatus === 'starting' || oauthStatus === 'awaiting_auth' || oauthStatus === 'running'}
                  className="h-7 text-[11px]"
                >
                  Setup OAuth Gemini
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  {oauthStatus === 'idle' ? 'Opens Google login in a new tab' : oauthMessage || oauthStatus}
                </span>
                {(oauthStatus === 'awaiting_auth' || oauthStatus === 'running') && oauthStartedAt && (Date.now() - oauthStartedAt > 120_000) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={retryGeminiOAuthSetup}
                    className="h-7 text-[11px]"
                  >
                    Retry
                  </Button>
                )}
              </div>
              <div className="ml-[7.25rem] text-[11px] text-muted-foreground leading-relaxed">
                1) Click <span className="text-foreground">Setup OAuth Gemini</span>.<br />
                2) Sign in with Google in the opened tab.<br />
                3) If redirected to <span className="text-foreground">http://localhost:8085/oauth2callback...</span>, copy the full URL.<br />
                4) Paste it into <span className="text-foreground">Manual callback</span> below and click <span className="text-foreground">Submit</span>.
              </div>
              <div className="ml-[7.25rem] text-[11px] text-muted-foreground">
                Active account: <span className="text-foreground">{oauthCurrentEmail || '(not connected)'}</span>
                {' | '}
                Project ID: <span className="text-foreground">{oauthCurrentProjectId || '(unknown)'}</span>
                {oauthProjectDetectSource ? (
                  <>
                    {' '}
                    <span>(source: {oauthProjectDetectSource})</span>
                  </>
                ) : null}
                {' '}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={detectProjectId}
                  className="h-6 text-[10px] ml-2"
                >
                  Detect Project ID
                </Button>
              </div>
              {(oauthStatus === 'awaiting_auth' || oauthStatus === 'running') && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground w-28 shrink-0">Manual callback</span>
                  <Input
                    value={oauthManualRedirectUrl}
                    onChange={e => setOauthManualRedirectUrl(e.target.value)}
                    placeholder="Paste http://localhost:8085/oauth2callback?... from browser"
                    className="flex-1 h-7 text-xs"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={submitManualOAuthRedirect}
                    className="h-7 text-[11px]"
                  >
                    Submit
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Providers section */}
          <div className="border border-border/60 bg-background/20 p-4">
            <div className="flex items-center justify-between mb-2.5 gap-3">
              <div>
                <span className="text-[11px] text-[hsl(var(--smui-frost-2))] uppercase tracking-[1.5px] font-medium">Providers</span>
                <div className="text-[10px] text-muted-foreground mt-1">Credentials, local endpoints and provider health</div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={detectLocal}
                disabled={detecting}
                className="gap-1.5 h-6 text-[10px] hover:text-primary hover:border-primary/40"
              >
                <Search size={11} />
                {detecting ? 'Scanning...' : 'Detect Local'}
              </Button>
            </div>
            <div className="grid gap-2.5 2xl:grid-cols-2">
              {providers.map(p => {
                const info = PROVIDER_INFO[p.id] || { label: p.id, description: '', isLocal: false, keyPlaceholder: '' }
                return (
                  <div key={p.id} className="border border-border/60 bg-background/30 px-3 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className={`status-dot ${
                        p.status === 'valid' ? 'status-dot-green' :
                        p.status === 'invalid' ? 'status-dot-red' :
                        p.status === 'unreachable' ? 'status-dot-orange' :
                        'status-dot-grey'
                      }`} />
                      <span className="text-xs font-medium text-foreground">{info.label}</span>
                      <span className="text-[10px] text-muted-foreground">{info.description}</span>
                    </div>

                    {p.id === 'custom' ? (
                      <>
                        <div className="flex items-center gap-2 mt-2 ml-4">
                          <Server size={10} className="text-muted-foreground shrink-0" />
                          <Input
                            value={urls['custom'] || ''}
                            onChange={e => setUrls(u => ({ ...u, custom: e.target.value }))}
                            placeholder="http://host:port/v1"
                            className="flex-1 h-6 text-[11px]"
                          />
                        </div>
                        <div className="flex items-center gap-2 mt-1.5 ml-4">
                          <KeyRound size={10} className="text-muted-foreground shrink-0" />
                          <Input
                            type="password"
                            value={keys['custom'] || ''}
                            onChange={e => setKeys(k => ({ ...k, custom: e.target.value }))}
                            placeholder="Primary API key (optional)"
                            className="flex-1 h-6 text-[11px]"
                          />
                        </div>
                        <div className="flex items-center gap-2 mt-1.5 ml-4">
                          <KeyRound size={10} className="text-muted-foreground shrink-0" />
                          <Input
                            type="password"
                            value={failoverKeys['custom'] || ''}
                            onChange={e => setFailoverKeys(k => ({ ...k, custom: e.target.value }))}
                            placeholder="Fallback API key (optional)"
                            className="flex-1 h-6 text-[11px]"
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={saveCustomProvider}
                            disabled={saving['custom']}
                            className="h-6 text-[10px] hover:text-primary hover:border-primary/40"
                          >
                            {saving['custom'] ? '...' : 'Save'}
                          </Button>
                        </div>
                        <div className="flex items-center gap-1.5 mt-1.5 ml-4">
                          {p.status === 'valid' ? (
                            <><Wifi size={10} className="text-[hsl(var(--smui-green))]" /><span className="text-[10px] text-[hsl(var(--smui-green))]">Reachable</span></>
                          ) : p.status === 'unreachable' ? (
                            <><WifiOff size={10} className="text-[hsl(var(--smui-orange))]" /><span className="text-[10px] text-[hsl(var(--smui-orange))]">Unreachable</span></>
                          ) : urls['custom'] ? (
                            <><WifiOff size={10} className="text-muted-foreground" /><span className="text-[10px] text-muted-foreground">Not tested</span></>
                          ) : null}
                        </div>
                      </>
                    ) : !info.isLocal ? (
                      <>
                        <div className="flex items-center gap-2 mt-2 ml-4">
                          <KeyRound size={10} className="text-muted-foreground shrink-0" />
                          <Input
                            type="password"
                            value={keys[p.id] || ''}
                            onChange={e => setKeys(k => ({ ...k, [p.id]: e.target.value }))}
                            placeholder={info.keyPlaceholder || 'Primary API key'}
                            className="flex-1 h-6 text-[11px]"
                          />
                        </div>
                        <div className="flex items-center gap-2 mt-1.5 ml-4">
                          <KeyRound size={10} className="text-muted-foreground shrink-0" />
                          <Input
                            type="password"
                            value={failoverKeys[p.id] || ''}
                            onChange={e => setFailoverKeys(k => ({ ...k, [p.id]: e.target.value }))}
                            placeholder="Fallback API key (optional)"
                            className="flex-1 h-6 text-[11px]"
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => saveKey(p.id)}
                            disabled={saving[p.id]}
                            className="h-6 text-[10px] hover:text-primary hover:border-primary/40"
                          >
                            {saving[p.id] ? '...' : 'Save'}
                          </Button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 mt-2 ml-4">
                          <Server size={10} className="text-muted-foreground shrink-0" />
                          <Input
                            value={urls[p.id] || DEFAULT_LOCAL_URLS[p.id] || ''}
                            onChange={e => setUrls(u => ({ ...u, [p.id]: e.target.value }))}
                            placeholder={DEFAULT_LOCAL_URLS[p.id] || 'http://host:port'}
                            className="flex-1 h-6 text-[11px]"
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => saveLocalUrl(p.id)}
                            disabled={saving[p.id]}
                            className="h-6 text-[10px] hover:text-primary hover:border-primary/40"
                          >
                            {saving[p.id] ? '...' : 'Save'}
                          </Button>
                        </div>
                        <div className="flex items-center gap-1.5 mt-1.5 ml-4">
                          {p.status === 'valid' ? (
                            <><Wifi size={10} className="text-[hsl(var(--smui-green))]" /><span className="text-[10px] text-[hsl(var(--smui-green))]">Running</span></>
                          ) : (
                            <><WifiOff size={10} className="text-muted-foreground" /><span className="text-[10px] text-muted-foreground">Not detected</span></>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
