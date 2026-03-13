import { describe, expect, test } from 'bun:test'
import { shouldRetryUninterpretableResponse } from './loop'

describe('shouldRetryUninterpretableResponse', () => {
  test('retries when the model returns broken tool markup', () => {
    const response = {
      content: [
        { type: 'text', text: '<tool_call>\n<tool_call>\n{"name":"get_location","arguments":{}}\n</tool_call>' },
      ],
    } as any

    expect(shouldRetryUninterpretableResponse(response)).toBe(true)
  })

  test('does not retry a normal plain-text answer', () => {
    const response = {
      content: [
        { type: 'text', text: 'You are docked at Nova Terra Central. Next step: review the market before selling.' },
      ],
    } as any

    expect(shouldRetryUninterpretableResponse(response)).toBe(false)
  })
})
