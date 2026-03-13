import { describe, expect, test } from 'bun:test'
import { extractCompactionResponseDiagnostics, extractFallbackSummaryText, shouldRetryUninterpretableResponse } from './loop'

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

describe('extractFallbackSummaryText', () => {
  test('falls back to thinking content when text is empty', () => {
    const content = [
      { type: 'thinking', thinking: 'Resume mining near the current sector and refuel before another long jump.' },
    ] as any

    expect(extractFallbackSummaryText(content)).toBe('Resume mining near the current sector and refuel before another long jump.')
  })
})

describe('extractCompactionResponseDiagnostics', () => {
  test('captures empty text blocks for compaction debugging', () => {
    const diagnostics = extractCompactionResponseDiagnostics([
      { type: 'text', text: '   ' },
      { type: 'toolCall', name: 'noop', arguments: {} },
    ] as any)

    expect(diagnostics).toEqual({
      blockCount: 2,
      blockTypes: ['text', 'toolCall'],
      blocks: [
        {
          type: 'text',
          hasText: false,
          textPreview: '',
          hasThinking: false,
          thinkingPreview: undefined,
          hasToolName: false,
        },
        {
          type: 'toolCall',
          hasText: false,
          textPreview: undefined,
          hasThinking: false,
          thinkingPreview: undefined,
          hasToolName: true,
        },
      ],
    })
  })
})
