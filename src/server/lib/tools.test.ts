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
          execute: async (command, args) => {
            toolCalls.push({ command, args })
            return {
              result: {
                ok: true,
              },
            }
          },
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
