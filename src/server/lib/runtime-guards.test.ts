import { describe, expect, test } from 'bun:test'
import {
  clearNavigationRefreshRequired,
  clearPendingMutationSeen,
  markPendingMutationSeen,
  markNavigationRefreshRequired,
  notePendingVerification,
  requiresNavigationRefresh,
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

describe('navigation refresh guard', () => {
  test('tracks whether a post-jump verification is required', () => {
    const profileId = `test-${Date.now()}-nav-refresh`

    expect(requiresNavigationRefresh(profileId)).toBe(false)
    markNavigationRefreshRequired(profileId)
    expect(requiresNavigationRefresh(profileId)).toBe(true)
    clearNavigationRefreshRequired(profileId)
    expect(requiresNavigationRefresh(profileId)).toBe(false)
  })
})
