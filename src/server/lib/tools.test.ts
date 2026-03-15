import { describe, expect, test } from 'bun:test'
import { rememberMarketSnapshot, rememberZeroFillSell } from './runtime-guards'
import { executeTool, findCanonicalAlias } from './tools'

describe('sell rerouting', () => {
  test('reroutes repeated zero-fill sell attempts to create_sell_order', async () => {
    const profileId = `test-${Date.now()}-sell-reroute`
    const toolCalls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []
    const logs: Array<{ type: string; summary: string }> = []

    rememberMarketSnapshot(profileId, 'Nova Terra Central', 'tungsten_ore', {
      bestBid: null,
      bestAsk: 8,
      bidVolume: 0,
      askVolume: 40,
    })
    rememberZeroFillSell(profileId, 'tungsten_ore', 'Nova Terra Central')

    const result = await executeTool(
      'game',
      {
        command: 'sell',
        args: {
          item_id: 'tungsten_ore',
          quantity: 10,
        },
      },
      {
        profileId,
        todo: '',
        log: (type, summary) => logs.push({ type, summary }),
        gameState: {
          location: {
            poi_name: 'Nova Terra Central',
          },
        },
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            toolCalls.push({ command, args })
            return {
              result: {
                ok: true,
              },
            }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toEqual({
      command: 'create_sell_order',
      args: {
        item_id: 'tungsten_ore',
        quantity: 10,
        price_each: 8,
      },
    })
    expect(logs.some((entry) => entry.type === 'system' && entry.summary.includes('Rerouted sell -> create_sell_order'))).toBe(true)
    expect(result).toContain('ok: true')
  })
})

describe('command aliases', () => {
  test('maps cancel_mission to abandon_mission when the API exposes abandon_mission', () => {
    const alias = findCanonicalAlias('cancel_mission', [
      'accept_mission',
      'abandon_mission',
      'get_missions',
    ])

    expect(alias).toBe('abandon_mission')
  })

  test('maps get_market to view_market when the API exposes view_market', () => {
    const alias = findCanonicalAlias('get_market', [
      'get_status',
      'view_market',
      'view_orders',
    ])

    expect(alias).toBe('view_market')
  })

  test('rewrites facility_types to facility(action=types) before execution', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    await executeTool(
      'game',
      {
        command: 'facility_types',
        args: {},
      },
      {
        profileId: `test-${Date.now()}-facility-types-rewrite`,
        todo: '',
        log: () => {},
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            calls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(calls).toEqual([
      {
        command: 'facility',
        args: { action: 'types' },
      },
    ])
  })
})

describe('navigation argument normalization', () => {
  test('normalizes travel aliases like id and target to target_poi before execution', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    const makeConnection = () => ({
      mode: 'http_v2' as const,
      connect: async () => {},
      login: async () => ({ success: true }),
      register: async () => ({ success: true }),
      execute: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args })
        return { result: { ok: true } }
      },
      onNotification: () => {},
      disconnect: async () => {},
      isConnected: () => true,
    })

    await executeTool(
      'game',
      {
        command: 'travel',
        args: { id: 'main_belt' },
      },
      {
        profileId: `test-${Date.now()}-travel-id-normalization`,
        todo: '',
        log: () => {},
        connection: makeConnection(),
      },
    )

    await executeTool(
      'game',
      {
        command: 'travel',
        args: { target: 'main_belt' },
      },
      {
        profileId: `test-${Date.now()}-travel-target-normalization`,
        todo: '',
        log: () => {},
        connection: makeConnection(),
      },
    )

    expect(calls).toEqual([
      {
        command: 'travel',
        args: { target_poi: 'main_belt' },
      },
      {
        command: 'travel',
        args: { target_poi: 'main_belt' },
      },
    ])
  })

  test('resolves runtime placeholders like $found_poi before execution', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    await executeTool(
      'game',
      {
        command: 'travel',
        args: { target_poi: '$found_poi_id' },
      },
      {
        profileId: `test-${Date.now()}-travel-placeholder`,
        todo: '',
        log: () => {},
        gameState: {
          location: {
            system_name: 'Furud',
            poi_id: 'poi_live_123',
            poi_name: 'Rich Belt',
          },
          poi: {
            id: 'poi_catalog_456',
            name: 'Rich Belt',
          },
        },
        connection: {
          mode: 'websocket_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_commands') {
              return { result: { commands: [{ name: 'travel' }] } }
            }
            calls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(calls).toEqual([
      {
        command: 'travel',
        args: { target_poi: 'poi_catalog_456' },
      },
    ])
  })

  test('blocks malformed combined system and poi travel targets locally', async () => {
    const logs: Array<{ type: string; summary: string }> = []
    let executeCalled = false

    const result = await executeTool(
      'game',
      {
        command: 'travel',
        args: { target_poi: 'furud / furud_belt' },
      },
      {
        profileId: `test-${Date.now()}-travel-combined-destination`,
        todo: '',
        log: (type, summary) => logs.push({ type, summary }),
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async () => {
            executeCalled = true
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(executeCalled).toBe(false)
    expect(result).toContain('combined system/POI string')
    expect(logs.some((entry) => entry.summary.includes('combined system/POI string'))).toBe(true)
  })

  test('requires a fresh location verification after jump before travel', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    const profileId = `test-${Date.now()}-travel-refresh-after-jump`
    const connection = {
      mode: 'http_v2' as const,
      connect: async () => {},
      login: async () => ({ success: true }),
      register: async () => ({ success: true }),
      execute: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args })
        if (command === 'jump') return { result: { pending: true, command: 'jump' } }
        return { result: { ok: true } }
      },
      onNotification: () => {},
      disconnect: async () => {},
      isConnected: () => true,
    }

    const jumpResult = await executeTool(
      'game',
      {
        command: 'jump',
        args: { target_system: 'furud' },
      },
      {
        profileId,
        todo: '',
        log: () => {},
        connection,
      },
    )

    const travelResult = await executeTool(
      'game',
      {
        command: 'travel',
        args: { target_poi: 'furud_belt' },
      },
      {
        profileId,
        todo: '',
        log: () => {},
        connection,
      },
    )

    expect(jumpResult).toContain('pending: true')
    expect(travelResult).toContain('navigation_refresh_required')
  })
})

describe('tool argument normalization', () => {
  test('parses stringified JSON args for game tool calls', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    const result = await executeTool(
      'game',
      {
        command: 'help',
        args: '{"command":"travel"}',
      } as any,
      {
        profileId: `test-${Date.now()}-help-json-args`,
        todo: '',
        log: () => {},
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            calls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(calls).toEqual([
      {
        command: 'help',
        args: { command: 'travel' },
      },
    ])
    expect(result).toContain('ok: true')
  })

  test('rejects non-object game args payloads before logging mangled characters', async () => {
    const logs: Array<{ type: string; summary: string }> = []
    let executeCalled = false

    const result = await executeTool(
      'game',
      {
        command: 'help',
        args: '"travel"',
      } as any,
      {
        profileId: `test-${Date.now()}-help-invalid-args`,
        todo: '',
        log: (type, summary) => logs.push({ type, summary }),
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async () => {
            executeCalled = true
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(executeCalled).toBe(false)
    expect(result).toContain("invalid 'args' payload")
    expect(logs.some((entry) => entry.summary.includes("invalid 'args' payload"))).toBe(true)
    expect(logs.some((entry) => entry.summary.includes('0='))).toBe(false)
  })
})

describe('backoff hints', () => {
  test('surfaces retry_after guidance on rate-limit errors', async () => {
    const logs: Array<{ type: string; summary: string }> = []

    const result = await executeTool(
      'game',
      {
        command: 'get_status',
      },
      {
        profileId: `test-${Date.now()}-rate-limit-hint`,
        todo: '',
        log: (type, summary) => logs.push({ type, summary }),
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async () => ({
            error: {
              code: 'rate_limited',
              message: 'Too many requests',
              retry_after: 12,
            },
          }),
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(result).toContain('12s pause')
    expect(logs.some((entry) => entry.type === 'system' && entry.summary.includes('12s pause'))).toBe(true)
  })
})

describe('local tool guardrails', () => {
  test('rejects local tools wrapped in game() with a clear error', async () => {
    const logs: Array<{ type: string; summary: string }> = []
    let executeCalled = false

    const result = await executeTool(
      'game',
      {
        command: 'status_log',
        args: {
          category: 'info',
          message: 'hello',
        },
      } as any,
      {
        profileId: `test-${Date.now()}-status-log-guard`,
        todo: '',
        log: (type, summary) => logs.push({ type, summary }),
        connection: {
          mode: 'http_v2',
          execute: async () => {
            executeCalled = true
            return { result: { ok: true } }
          },
        },
      },
    )

    expect(executeCalled).toBe(false)
    expect(result).toContain('local Admiral tool')
    expect(result).toContain('Call status_log(')
    expect(logs.some((entry) => entry.summary.includes('Blocked local tool wrapped in game(): status_log'))).toBe(true)
  })
})
