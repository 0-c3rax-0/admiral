import { describe, expect, test } from 'bun:test'
import { buildRecoveryNudge } from './agent-extensions'

describe('recovery nudge', () => {
  test('explains already_docked notifications as a satisfied dock state', () => {
    const nudge = buildRecoveryNudge([
      {
        type: 'ACTION_ERROR',
        message: 'Error: [already_docked] Already docked',
      },
    ], {
      player: {
        current_system: 'Nova Terra',
        current_poi: 'Nova Terra Central',
      },
      location: {
        system_name: 'Nova Terra',
        poi_name: 'Nova Terra Central',
        poi_type: 'station',
        docked_at: 'Nova Terra Central',
      },
    })

    expect(nudge).toContain('already_docked')
    expect(nudge).toContain('Verified current state from fresh get_status:')
    expect(nudge).toContain('Navigation state: docked')
  })
})
