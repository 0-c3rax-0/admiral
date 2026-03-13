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
