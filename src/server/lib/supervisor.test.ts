import { describe, expect, test } from 'bun:test'
import { buildCommandHintSignals, buildRecentSignals } from './supervisor'

describe('supervisor recent signals', () => {
  test('detects remote view_market misuse from invalid payload logs', () => {
    const signals = buildRecentSignals([
      'Error: [invalid_payload] view_market only accepts item_id or category. `view_market` cannot target a remote `station_id`; dock there first; use only `item_id` or `category` with `view_market`.',
    ])

    expect(signals).toContain('remote view_market misuse observed recently')
  })

  test('detects facility upgrade hint from build_failed logs', () => {
    const signals = buildRecentSignals([
      "Error: [build_failed] build_failed: You already have a quarters facility at this station. Use action 'upgrade' to improve it.",
    ])

    expect(signals).toContain('facility upgrade suggested by server recently')
  })

  test('detects invalid scope guidance for view_orders', () => {
    const signals = buildRecentSignals([
      'Error: [invalid_scope] Invalid scope. Use "personal" (default) or "faction".',
    ])

    expect(signals).toContain('view_orders scope options clarified recently')
  })
})

describe('supervisor command hints', () => {
  test('ignores unsupported-command logs for commands that are currently verified', () => {
    const hints = buildCommandHintSignals(
      [
        { type: 'tool_result', summary: "Error: unsupported command 'get_queue'. Did you mean: v2_get_queue", ts: Date.now(), detail: '' },
        { type: 'tool_result', summary: "Error: unsupported command 'get_guide'.", ts: Date.now(), detail: '' },
        { type: 'tool_result', summary: "Error: unsupported command 'get_base'.", ts: Date.now(), detail: '' },
      ] as any,
      {
        names: new Set(['get_guide', 'get_base', 'v2_get_queue', 'get_commands']),
        infos: new Map([
          ['get_guide', { name: 'get_guide', description: 'guide', isMutation: false, params: [] }],
          ['get_base', { name: 'get_base', description: 'base', isMutation: false, params: [] }],
          ['v2_get_queue', { name: 'v2_get_queue', description: 'queue', isMutation: false, params: [] }],
          ['get_commands', { name: 'get_commands', description: 'commands', isMutation: false, params: [] }],
        ]),
        loadedFrom: 'test',
      },
    )

    expect(hints.map((hint) => hint.attempted)).toEqual(['get_queue'])
  })

  test('includes usage hints from verified command metadata', () => {
    const hints = buildCommandHintSignals(
      [
        { type: 'tool_result', summary: "Error: unsupported command 'get_queue'.", ts: Date.now(), detail: '' },
      ] as any,
      {
        names: new Set(['v2_get_queue', 'get_commands']),
        infos: new Map([
          ['v2_get_queue', { name: 'v2_get_queue', description: 'queue', isMutation: false, params: [] }],
          ['get_commands', { name: 'get_commands', description: 'commands', isMutation: false, params: [] }],
        ]),
        loadedFrom: 'test',
      },
    )

    expect(hints[0]?.usageHints).toContain('usage=v2_get_queue()')
  })
})
