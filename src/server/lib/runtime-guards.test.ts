import { describe, expect, test } from 'bun:test'
import {
  clearPendingMutationSeen,
  markPendingMutationSeen,
  notePendingVerification,
  shouldThrottlePendingVerification,
} from './runtime-guards'

describe('pending verification budget', () => {
  test('allows one get_location and one get_status during the same pending action', () => {
    const profileId = `test-${Date.now()}-a`
    markPendingMutationSeen(profileId)

    expect(shouldThrottlePendingVerification(profileId, 'get_location')).toBe(false)
    notePendingVerification(profileId, 'get_location')

    expect(shouldThrottlePendingVerification(profileId, 'get_status')).toBe(false)
    notePendingVerification(profileId, 'get_status')

    expect(shouldThrottlePendingVerification(profileId, 'get_location')).toBe(false)
    expect(shouldThrottlePendingVerification(profileId, 'get_status')).toBe(true)
    clearPendingMutationSeen(profileId)
  })

  test('blocks immediate repeat of the same verification command', () => {
    const profileId = `test-${Date.now()}-b`
    markPendingMutationSeen(profileId)

    notePendingVerification(profileId, 'get_location')
    expect(shouldThrottlePendingVerification(profileId, 'get_location')).toBe(true)

    clearPendingMutationSeen(profileId)
  })
})
