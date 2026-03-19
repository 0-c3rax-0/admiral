import { describe, expect, test } from 'bun:test'
import { getNotificationBurstFingerprint } from './session-manager'

describe('broker notification burst fingerprint', () => {
  test('matches identical notification payloads', () => {
    const a = {
      type: 'error',
      payload: {
        code: 'already_docked',
        message: 'Already docked',
      },
    }
    const b = {
      type: 'error',
      payload: {
        code: 'already_docked',
        message: 'Already docked',
      },
    }

    expect(getNotificationBurstFingerprint(a)).toBe(getNotificationBurstFingerprint(b))
  })

  test('distinguishes different notification payloads', () => {
    const a = {
      type: 'error',
      payload: {
        code: 'already_docked',
        message: 'Already docked',
      },
    }
    const b = {
      type: 'error',
      payload: {
        code: 'not_docked',
        message: 'Not docked',
      },
    }

    expect(getNotificationBurstFingerprint(a)).not.toBe(getNotificationBurstFingerprint(b))
  })
})
