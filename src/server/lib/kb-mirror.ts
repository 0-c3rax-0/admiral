import fs from 'fs'
import path from 'path'

const KB_BASE_URL = 'https://rsned.github.io/spacemolt-kb/'
const KB_MIRROR_DIR = path.join(process.cwd(), 'data', 'spacemolt-kb')
const KB_MANIFEST_PATH = path.join(KB_MIRROR_DIR, 'manifest.json')
const KB_USER_AGENT = 'SpaceMolt-Admiral'

type KbSection = 'systems' | 'items' | 'recipes' | 'skills' | 'ships' | 'diffs'

type MirrorManifest = {
  version: 1
  lastSyncAt: string
  latestDiffDate: string | null
  mirroredPaths: string[]
  diffPages: string[]
  sectionSync: Record<KbSection, {
    lastSyncedAt: string
    mirroredCount: number
  }>
}

const SECTION_PREFIXES: Record<KbSection, string> = {
  systems: 'systems/',
  items: 'items/',
  recipes: 'recipes/',
  skills: 'skills/',
  ships: 'ships/',
  diffs: 'diffs/',
}

const FULL_SYNC_SEEDS = [
  'index.html',
  'systems/index.html',
  'items/index.html',
  'recipes/index.html',
  'skills/index.html',
  'ships/index.html',
  'diffs/index.html',
]

function normalizeSitePath(input: string): string {
  const trimmed = input.replace(/^\/+/, '').split('#')[0]?.split('?')[0] ?? ''
  if (!trimmed) return 'index.html'
  if (trimmed.endsWith('/')) return `${trimmed}index.html`
  return trimmed
}

function readManifest(): MirrorManifest | null {
  try {
    const raw = fs.readFileSync(KB_MANIFEST_PATH, 'utf8')
    const parsed = JSON.parse(raw) as MirrorManifest
    if (parsed?.version !== 1 || !Array.isArray(parsed.mirroredPaths) || !Array.isArray(parsed.diffPages)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function writeManifest(manifest: MirrorManifest): void {
  fs.mkdirSync(KB_MIRROR_DIR, { recursive: true })
  fs.writeFileSync(KB_MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8')
}

async function fetchSitePath(sitePath: string): Promise<{ buffer: Buffer; contentType: string | null }> {
  const url = new URL(normalizeSitePath(sitePath), KB_BASE_URL).toString()
  const resp = await fetch(url, {
    headers: { 'User-Agent': KB_USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  })
  if (!resp.ok) throw new Error(`KB fetch failed for ${sitePath}: HTTP ${resp.status}`)
  const buffer = Buffer.from(await resp.arrayBuffer())
  return {
    buffer,
    contentType: resp.headers.get('content-type'),
  }
}

function writeMirroredFile(sitePath: string, buffer: Buffer): void {
  const normalized = normalizeSitePath(sitePath)
  const targetPath = path.join(KB_MIRROR_DIR, normalized)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.writeFileSync(targetPath, buffer)
}

function isHtmlPath(sitePath: string, contentType: string | null): boolean {
  if (contentType?.includes('text/html')) return true
  return normalizeSitePath(sitePath).endsWith('.html')
}

function extractDiscoveredSitePaths(html: string, currentSitePath: string): string[] {
  const currentUrl = new URL(normalizeSitePath(currentSitePath), KB_BASE_URL)
  const matches = [
    ...html.matchAll(/href="([^"]+)"/gi),
    ...html.matchAll(/src="([^"]+)"/gi),
  ]

  const paths = new Set<string>()
  for (const match of matches) {
    const raw = (match[1] || '').trim()
    if (!raw || raw.startsWith('mailto:') || raw.startsWith('javascript:') || raw.startsWith('data:')) continue

    let url: URL
    try {
      url = new URL(raw, currentUrl)
    } catch {
      continue
    }
    if (url.origin !== currentUrl.origin || !url.pathname.startsWith('/spacemolt-kb/')) continue
    paths.add(normalizeSitePath(url.pathname.replace(/^\/spacemolt-kb\//, '')))
  }

  return [...paths]
}

function shouldRecurseHtml(sitePath: string, recursePrefixes: string[]): boolean {
  const normalized = normalizeSitePath(sitePath)
  return recursePrefixes.some((prefix) => normalized.startsWith(prefix))
}

async function crawlSiteFromSeeds(seedPaths: string[], recursePrefixes: string[]): Promise<Set<string>> {
  const queued = new Set(seedPaths.map(normalizeSitePath))
  const visited = new Set<string>()
  const mirrored = new Set<string>()
  const queue = [...queued]

  while (queue.length > 0) {
    const sitePath = queue.shift()
    if (!sitePath || visited.has(sitePath)) continue
    visited.add(sitePath)

    const { buffer, contentType } = await fetchSitePath(sitePath)
    writeMirroredFile(sitePath, buffer)
    mirrored.add(sitePath)

    if (!isHtmlPath(sitePath, contentType)) continue
    const html = buffer.toString('utf8')
    for (const discovered of extractDiscoveredSitePaths(html, sitePath)) {
      if (visited.has(discovered) || queued.has(discovered)) continue
      if (isHtmlPath(discovered, null)) {
        if (!shouldRecurseHtml(discovered, recursePrefixes)) continue
      }
      queued.add(discovered)
      queue.push(discovered)
    }
  }

  return mirrored
}

function parseDiffIndexDates(html: string): string[] {
  return [...new Set(Array.from(html.matchAll(/href="(\d{4}-\d{2}-\d{2}\.html)"/g), (match) => match[1]))]
}

function parseChangedSectionsFromDiffPage(html: string): KbSection[] {
  const ids = [...new Set(Array.from(html.matchAll(/<div class="catalog-section" id="([^"]+)">/g), (match) => match[1]))]
  const sections = new Set<KbSection>()
  for (const id of ids) {
    if (id === 'map') sections.add('systems')
    if (id === 'systems' || id === 'items' || id === 'recipes' || id === 'skills' || id === 'ships') {
      sections.add(id)
    }
  }
  return [...sections]
}

function dateFromDiffPage(sitePath: string): string | null {
  const match = normalizeSitePath(sitePath).match(/^diffs\/(\d{4}-\d{2}-\d{2})\.html$/)
  return match ? match[1] : null
}

function makeBaseManifest(): MirrorManifest {
  return {
    version: 1,
    lastSyncAt: new Date(0).toISOString(),
    latestDiffDate: null,
    mirroredPaths: [],
    diffPages: [],
    sectionSync: {
      systems: { lastSyncedAt: new Date(0).toISOString(), mirroredCount: 0 },
      items: { lastSyncedAt: new Date(0).toISOString(), mirroredCount: 0 },
      recipes: { lastSyncedAt: new Date(0).toISOString(), mirroredCount: 0 },
      skills: { lastSyncedAt: new Date(0).toISOString(), mirroredCount: 0 },
      ships: { lastSyncedAt: new Date(0).toISOString(), mirroredCount: 0 },
      diffs: { lastSyncedAt: new Date(0).toISOString(), mirroredCount: 0 },
    },
  }
}

export async function syncKbMirrorOnStartup(): Promise<void> {
  const startedAt = new Date().toISOString()
  const previous = readManifest()
  const manifest = previous ? structuredClone(previous) : makeBaseManifest()

  fs.mkdirSync(KB_MIRROR_DIR, { recursive: true })

  const diffIndexPath = 'diffs/index.html'
  const diffIndexResp = await fetchSitePath(diffIndexPath)
  writeMirroredFile(diffIndexPath, diffIndexResp.buffer)
  const diffIndexHtml = diffIndexResp.buffer.toString('utf8')
  const remoteDiffPages = parseDiffIndexDates(diffIndexHtml).map((entry) => `diffs/${entry}`)
  const remoteLatestDiffDate = remoteDiffPages
    .map((sitePath) => dateFromDiffPage(sitePath))
    .filter((entry): entry is string => Boolean(entry))
    .sort()
    .at(-1) ?? null

  const fullSync = !previous
  const newDiffPages = fullSync
    ? remoteDiffPages
    : remoteDiffPages.filter((sitePath) => !manifest.diffPages.includes(sitePath))

  const changedSections = new Set<KbSection>()
  const mirroredPaths = new Set(manifest.mirroredPaths)
  mirroredPaths.add(diffIndexPath)

  if (fullSync) {
    const fullMirrored = await crawlSiteFromSeeds(FULL_SYNC_SEEDS, [''])
    for (const mirroredPath of fullMirrored) mirroredPaths.add(mirroredPath)
    for (const section of Object.keys(SECTION_PREFIXES) as KbSection[]) {
      const prefix = SECTION_PREFIXES[section]
      manifest.sectionSync[section] = {
        lastSyncedAt: startedAt,
        mirroredCount: [...mirroredPaths].filter((sitePath) => sitePath.startsWith(prefix)).length,
      }
    }
  } else {
    for (const diffPage of newDiffPages) {
      const diffResp = await fetchSitePath(diffPage)
      writeMirroredFile(diffPage, diffResp.buffer)
      mirroredPaths.add(diffPage)
      const diffHtml = diffResp.buffer.toString('utf8')
      for (const section of parseChangedSectionsFromDiffPage(diffHtml)) changedSections.add(section)
    }

    changedSections.add('diffs')

    for (const section of changedSections) {
      const prefix = SECTION_PREFIXES[section]
      const sectionMirrored = await crawlSiteFromSeeds([`${prefix}index.html`], [prefix])
      for (const mirroredPath of sectionMirrored) mirroredPaths.add(mirroredPath)
      manifest.sectionSync[section] = {
        lastSyncedAt: startedAt,
        mirroredCount: [...mirroredPaths].filter((sitePath) => sitePath.startsWith(prefix)).length,
      }
    }
  }

  manifest.lastSyncAt = startedAt
  manifest.latestDiffDate = remoteLatestDiffDate
  manifest.diffPages = remoteDiffPages
  manifest.mirroredPaths = [...mirroredPaths].sort()
  if (!fullSync && !changedSections.has('diffs')) {
    manifest.sectionSync.diffs = {
      lastSyncedAt: startedAt,
      mirroredCount: manifest.mirroredPaths.filter((sitePath) => sitePath.startsWith(SECTION_PREFIXES.diffs)).length,
    }
  }

  writeManifest(manifest)

  const mode = fullSync ? 'full' : (newDiffPages.length > 0 ? 'diff-driven' : 'diff-check')
  const refreshedSections = fullSync
    ? Object.keys(SECTION_PREFIXES).join(', ')
    : [...changedSections].sort().join(', ') || 'none'
  console.log(`[startup] KB mirror sync complete: mode=${mode}, latest_diff=${remoteLatestDiffDate ?? 'none'}, sections=${refreshedSections}, files=${manifest.mirroredPaths.length}`)
}
