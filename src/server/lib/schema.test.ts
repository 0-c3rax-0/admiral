import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractGameCommandsFromOpenApiSpec } from './schema'
import { findCanonicalAlias } from './tools'

function loadCheckedInV2Spec(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'docs/openapi-v2.json'), 'utf8')) as Record<string, unknown>
}

describe('openapi v2 command extraction', () => {
  test('flattens grouped namespace routes into Admiral command names', () => {
    const commands = extractGameCommandsFromOpenApiSpec(loadCheckedInV2Spec())
    const names = new Set(commands.map((command) => command.name))

    expect(names.has('catalog')).toBe(true)
    expect(names.has('storage_view')).toBe(true)
    expect(names.has('storage_deposit')).toBe(true)
    expect(names.has('storage_withdraw')).toBe(true)
    expect(names.has('facility_types')).toBe(true)
    expect(names.has('facility_build')).toBe(true)
    expect(names.has('facility_upgrade')).toBe(true)
    expect(names.has('fleet_status')).toBe(true)
  })

  test('covers critical Admiral-used query commands from the checked-in spec', () => {
    const commands = extractGameCommandsFromOpenApiSpec(loadCheckedInV2Spec())
    const names = commands.map((command) => command.name)
    const criticalQueries = [
      'get_status',
      'get_location',
      'get_system',
      'get_poi',
      'get_cargo',
      'get_ship',
      'get_skills',
      'get_missions',
      'get_active_missions',
      'get_nearby',
      'get_action_log',
      'view_market',
      'analyze_market',
      'estimate_purchase',
      'catalog',
      'browse_ships',
      'list_ships',
      'quote',
      'wrecks',
      'forum_list',
      'forum_get_thread',
      'captains_log_list',
      'captains_log_get',
      'get_commands',
      'get_base',
      'view_orders',
      'search_systems',
      'find_route',
      'storage_view',
      'salvage_quote',
      'fleet_status',
    ]

    expect(
      criticalQueries.filter((name) => !names.includes(name) && !findCanonicalAlias(name, names)),
    ).toEqual([])
  })
})
