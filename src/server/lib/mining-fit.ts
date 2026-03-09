export type MiningFitKind = 'ore' | 'ice' | 'gas' | 'mixed' | 'none'

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function classifyMiningModule(module: unknown): Exclude<MiningFitKind, 'mixed' | 'none'> | null {
  if (!module || typeof module !== 'object') return null
  const record = module as Record<string, unknown>
  const haystack = [
    normalize(record.name),
    normalize(record.type),
    normalize(record.type_id),
  ].join(' ')

  if (!haystack) return null
  if (haystack.includes('ice')) return 'ice'
  if (haystack.includes('gas')) return 'gas'
  if (haystack.includes('mining') || haystack.includes('ore') || haystack.includes('laser')) return 'ore'
  return null
}

export function classifyMiningFit(modules: unknown): MiningFitKind {
  if (!Array.isArray(modules) || modules.length === 0) return 'none'
  const kinds = new Set<Exclude<MiningFitKind, 'mixed' | 'none'>>()
  for (const module of modules) {
    const kind = classifyMiningModule(module)
    if (kind) kinds.add(kind)
  }
  if (kinds.size === 0) return 'none'
  if (kinds.size > 1) return 'mixed'
  return Array.from(kinds)[0]
}
