import type { GameConnection, CommandResult } from './connections/interface'
import { isCommandTemporarilyBlocked, rememberUnknownCommand } from './runtime-guards'

export type SkillMap = Record<string, number>

export type MaterialRequirement = {
  itemId: string
  name: string
  quantity: number | null
}

export type ShipOffer = {
  name: string
  classId: string
  category: string | null
  price: number | null
  lore: string | null
  buildMaterials: MaterialRequirement[]
  requiredSkills: SkillMap
}

export type ModuleDetail = {
  name: string
  itemId: string
  combatReach: number | null
  ammoType: string | null
  accuracyBonus: number | null
  surveyPower: number | null
  requiredSkills: SkillMap
}

export type ItemDetail = {
  name: string
  itemId: string
  hazardousWarnings: string[]
}

type CommissionQuoteTarget = {
  key: string
  name: string
  classId: string
}

const COMMISSION_QUOTE_CONCURRENCY = 3

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function normalizeCatalogKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function extractRequiredSkills(record: Record<string, unknown>): SkillMap {
  const raw = asRecord(record.required_skills) || asRecord(record.skill_requirements) || asRecord(record.skills_required)
  if (!raw) return {}
  return Object.fromEntries(
    Object.entries(raw)
      .map(([skillId, value]) => {
        const level = toFiniteNumber(asRecord(value)?.level ?? value)
        if (!skillId.trim() || level === null) return null
        return [normalizeCatalogKey(skillId), level] as const
      })
      .filter((entry): entry is readonly [string, number] => Boolean(entry))
  )
}

function extractMaterialRequirements(record: Record<string, unknown>): MaterialRequirement[] {
  const buildMaterialRequirements = asArray(record.build_material_requirements)
  const materialRequirements = asArray(record.material_requirements)
  const buildMaterials = asArray(record.build_materials)
  const raw: unknown[] =
    buildMaterialRequirements.length > 0 ? buildMaterialRequirements :
    materialRequirements.length > 0 ? materialRequirements :
    buildMaterials.length > 0 ? buildMaterials :
    []

  return raw
    .map((entry) => {
      const item = asRecord(entry)
      if (!item) return null
      const itemId = String(item.item_id ?? item.id ?? item.material_id ?? '').trim()
      const name = String(item.name ?? item.item_name ?? item.material_name ?? itemId).trim()
      const quantity = toFiniteNumber(item.quantity ?? item.amount ?? item.count)
      if (!itemId && !name) return null
      return { itemId, name, quantity }
    })
    .filter((entry): entry is MaterialRequirement => Boolean(entry))
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function collectCatalogArrays(data: Record<string, unknown> | undefined): unknown[][] {
  if (!data) return []
  const result = asRecord(data.result)
  return [
    asArray(data.ships),
    asArray(data.modules),
    asArray(data.items),
    asArray(data.listings),
    asArray(data.offers),
    asArray(result?.ships),
    asArray(result?.modules),
    asArray(result?.items),
  ].filter((entries) => entries.length > 0)
}

export function extractShipOffers(data: Record<string, unknown> | undefined): ShipOffer[] {
  for (const candidate of collectCatalogArrays(data)) {
    const offers = candidate
      .map((item) => {
        const record = asRecord(item)
        if (!record) return null
        const name = String(record.name ?? record.ship_name ?? record.class_name ?? '').trim()
        const classId = String(record.ship_class ?? record.class_id ?? record.ship_class_id ?? '').trim()
        if (!name && !classId) return null
        return {
          name,
          classId,
          category: firstNonEmptyString(record.category, record.ship_category, record.role),
          price: toFiniteNumber(record.price ?? record.ask_price ?? record.cost ?? record.sale_price),
          lore: firstNonEmptyString(record.lore, record.description, record.flavor_text),
          buildMaterials: extractMaterialRequirements(record),
          requiredSkills: extractRequiredSkills(record),
        } satisfies ShipOffer
      })
      .filter((offer): offer is ShipOffer => Boolean(offer))
    if (offers.length > 0) return offers
  }
  return []
}

export function dedupeShipOffers(offers: ShipOffer[]): ShipOffer[] {
  const deduped = new Map<string, ShipOffer>()
  for (const offer of offers) {
    const key = `${normalizeCatalogKey(offer.classId)}|${normalizeCatalogKey(offer.name)}`
    const existing = deduped.get(key)
    if (!existing) {
      deduped.set(key, offer)
      continue
    }
    if (existing.price === null && offer.price !== null) {
      deduped.set(key, offer)
      continue
    }
    if (existing.price !== null && offer.price !== null && offer.price < existing.price) {
      deduped.set(key, offer)
      continue
    }
    if (!existing.category && offer.category) {
      deduped.set(key, { ...existing, category: offer.category })
      continue
    }
    if (!existing.lore && offer.lore) {
      deduped.set(key, { ...existing, lore: offer.lore })
      continue
    }
    if (existing.buildMaterials.length === 0 && offer.buildMaterials.length > 0) {
      deduped.set(key, { ...existing, buildMaterials: offer.buildMaterials })
      continue
    }
    if (Object.keys(existing.requiredSkills).length === 0 && Object.keys(offer.requiredSkills).length > 0) {
      deduped.set(key, { ...existing, requiredSkills: offer.requiredSkills })
    }
  }
  return [...deduped.values()]
}

export function extractModuleDetails(data: Record<string, unknown> | undefined): ModuleDetail[] {
  for (const candidate of collectCatalogArrays(data)) {
    const details = candidate
      .map((item) => {
        const record = asRecord(item)
        if (!record) return null
        const name = String(record.name ?? record.module_name ?? '').trim()
        const itemId = String(record.item_id ?? record.id ?? record.module_id ?? '').trim()
        if (!name && !itemId) return null
        return {
          name,
          itemId,
          combatReach: toFiniteNumber(record.combat_reach ?? record.range ?? record.weapon_range),
          ammoType: firstNonEmptyString(record.ammo_type, record.ammo, record.ammunition_type),
          accuracyBonus: toFiniteNumber(record.accuracy_bonus ?? record.hit_bonus ?? record.precision_bonus),
          surveyPower: toFiniteNumber(record.survey_power ?? record.scan_power),
          requiredSkills: extractRequiredSkills(record),
        } satisfies ModuleDetail
      })
      .filter((detail): detail is ModuleDetail => Boolean(detail))
    if (details.length > 0) return details
  }
  return []
}

export function extractItemDetails(data: Record<string, unknown> | undefined): ItemDetail[] {
  for (const candidate of collectCatalogArrays(data)) {
    const details = candidate
      .map((item) => {
        const record = asRecord(item)
        if (!record) return null
        const name = String(record.name ?? record.item_name ?? '').trim()
        const itemId = String(record.item_id ?? record.id ?? '').trim()
        if (!name && !itemId) return null
        const warnings = [
          ...asArray(record.hazardous_material_warnings),
          ...asArray(record.hazard_warnings),
          ...asArray(record.warnings),
        ]
          .map((warning) => typeof warning === 'string' ? warning.trim() : '')
          .filter(Boolean)
        return {
          name,
          itemId,
          hazardousWarnings: warnings,
        } satisfies ItemDetail
      })
      .filter((detail): detail is ItemDetail => Boolean(detail))
    if (details.length > 0) return details
  }
  return []
}

function extractCommissionQuotePrice(result: CommandResult | null): number | null {
  const payload = asRecord(result?.structuredContent ?? result?.result)
  if (!payload) return null
  const direct = toFiniteNumber(
    payload.commission_quote ??
    payload.quote_price ??
    payload.total_price ??
    payload.price ??
    payload.cost
  )
  if (direct !== null) return direct

  const nested = asRecord(payload.quote) || asRecord(payload.result)
  if (!nested) return null
  return toFiniteNumber(
    nested.commission_quote ??
    nested.quote_price ??
    nested.total_price ??
    nested.price ??
    nested.cost
  )
}

async function requestCommissionQuote(
  connection: GameConnection,
  target: CommissionQuoteTarget,
): Promise<{ price: number | null; unsupported: boolean }> {
  const variants: Array<Record<string, unknown>> = [
    target.classId ? { ship_class: target.classId } : {},
    target.classId ? { class_id: target.classId } : {},
    target.classId ? { ship_class_id: target.classId } : {},
    target.name ? { ship_name: target.name } : {},
    target.name ? { name: target.name } : {},
    target.classId && target.name ? { ship_class: target.classId, ship_name: target.name } : {},
  ].filter((args) => Object.keys(args).length > 0)

  let unsupported = false
  for (const args of variants) {
    const resp = await connection.execute('commission_quote', args)
    if (resp.error) {
      const details = `${resp.error.code} ${resp.error.message}`.toLowerCase()
      if (details.includes('unknown') || details.includes('not found') || details.includes('unsupported')) unsupported = true
      continue
    }
    const price = extractCommissionQuotePrice(resp)
    if (price !== null) return { price, unsupported: false }
  }
  return { price: null, unsupported }
}

export async function applyCommissionQuotes(
  connection: GameConnection,
  profileId: string,
  offers: ShipOffer[],
): Promise<ShipOffer[]> {
  if (offers.length === 0 || isCommandTemporarilyBlocked(profileId, 'commission_quote')) return offers

  const uniqueTargets = new Map<string, CommissionQuoteTarget>()
  for (const offer of offers) {
    const key = normalizeCatalogKey(offer.classId || offer.name)
    if (!key || uniqueTargets.has(key)) continue
    uniqueTargets.set(key, { key, name: offer.name, classId: offer.classId })
  }

  try {
    const prices = new Map<string, number | null>()
    let unsupportedSeen = false
    const pendingTargets = [...uniqueTargets.values()]
    for (let index = 0; index < pendingTargets.length; index += COMMISSION_QUOTE_CONCURRENCY) {
      const batch = pendingTargets.slice(index, index + COMMISSION_QUOTE_CONCURRENCY)
      await Promise.all(batch.map(async (target) => {
        const quote = await requestCommissionQuote(connection, target)
        if (quote.unsupported) unsupportedSeen = true
        prices.set(target.key, quote.price)
      }))
    }
    if (unsupportedSeen) rememberUnknownCommand(profileId, 'commission_quote')

    return offers.map((offer) => {
      const key = normalizeCatalogKey(offer.classId || offer.name)
      const quotedPrice = prices.get(key)
      return quotedPrice !== null && quotedPrice !== undefined
        ? { ...offer, price: quotedPrice }
        : offer
    })
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    if (message.includes('unknown') || message.includes('not found') || message.includes('unsupported')) {
      rememberUnknownCommand(profileId, 'commission_quote')
    }
    return offers
  }
}

export function formatRequiredSkills(requiredSkills: SkillMap): string {
  return Object.entries(requiredSkills)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([skillId, level]) => `${skillId} ${level}`)
    .join(', ')
}

export function formatMaterialRequirements(materials: MaterialRequirement[]): string {
  return materials
    .slice(0, 4)
    .map((material) => `${material.name}${material.quantity !== null ? ` x${material.quantity}` : ''}`)
    .join(', ')
}
