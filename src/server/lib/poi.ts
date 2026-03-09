export type NormalizedPoiKind = 'station' | 'ore' | 'ice' | 'gas' | 'resource' | 'unknown'

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function classifyPoi(type: unknown, name: unknown): NormalizedPoiKind {
  const poiType = normalize(type)
  const poiName = normalize(name)
  const haystack = `${poiType} ${poiName}`.trim()

  if (!haystack) return 'unknown'
  if (haystack.includes('station') || haystack.includes('base') || haystack.includes('shipyard')) return 'station'
  if (haystack.includes('ice')) return 'ice'
  if (haystack.includes('gas') || haystack.includes('cloud')) return 'gas'
  if (haystack.includes('asteroid') || haystack.includes('belt') || haystack.includes('ring')) return 'ore'
  if (haystack.includes('field') || haystack.includes('resource')) return 'resource'
  return 'unknown'
}

export function isDockedPoi(type: unknown, name: unknown): boolean {
  return classifyPoi(type, name) === 'station'
}

export function isResourcePoi(type: unknown, name: unknown): boolean {
  return ['ore', 'ice', 'gas', 'resource'].includes(classifyPoi(type, name))
}
