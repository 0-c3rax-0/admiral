import { describe, expect, test } from 'bun:test'
import { buildRecentSignals } from './supervisor'

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
})
