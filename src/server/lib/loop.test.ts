import { describe, expect, test } from 'bun:test'
import {
  extractCompactionResponseDiagnostics,
  extractFallbackSummaryText,
  isSessionHistorySummaryMessage,
  sanitizeAssistantToolCalls,
  sanitizeProviderContextMessages,
  sanitizeProviderMessageSequence,
  sanitizeTerminalAssistantMessage,
  sanitizeMessageToolIdentifiers,
  shouldRetryUninterpretableResponse,
} from './loop'

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

describe('isSessionHistorySummaryMessage', () => {
  test('matches both normal and emergency compaction summary markers', () => {
    expect(isSessionHistorySummaryMessage({
      role: 'user',
      content: '## Session History Summary\n\nAgent was trading ore.',
    } as any)).toBe(true)

    expect(isSessionHistorySummaryMessage({
      role: 'user',
      content: '## Session History Summary (emergency compaction)\n\nEarlier session context.',
    } as any)).toBe(true)
  })

  test('ignores normal user messages', () => {
    expect(isSessionHistorySummaryMessage({
      role: 'user',
      content: 'Check station inventory and compare bids.',
    } as any)).toBe(false)
  })
})

describe('sanitizeMessageToolIdentifiers', () => {
  test('replaces blank assistant tool call ids and updates matching tool results', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: '', name: 'game', arguments: { command: 'travel' } },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: '',
        toolName: 'game',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      },
    ] as any

    sanitizeMessageToolIdentifiers(messages)

    const toolCallId = messages[0].content[0].id
    expect(toolCallId).toMatch(/^[A-Za-z0-9]{9}$/)
    expect(messages[1].toolCallId).toBe(toolCallId)
  })

  test('replaces fallback tool ids with provider-safe ids and preserves linkage', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'fallback-tool-1', name: 'get_status', arguments: {} },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'fallback-tool-1',
        toolName: 'get_status',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      },
    ] as any

    sanitizeMessageToolIdentifiers(messages)

    const toolCallId = messages[0].content[0].id
    expect(toolCallId).toMatch(/^[A-Za-z0-9]{9}$/)
    expect(toolCallId).not.toBe('fallback-tool-1')
    expect(messages[1].toolCallId).toBe(toolCallId)
  })
})

describe('sanitizeAssistantToolCalls', () => {
  test('rewrites assistant tool calls with missing names into text blocks', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'fallback-tool-1', name: '', arguments: { command: 'get_status' } },
        ],
      },
    ] as any

    sanitizeAssistantToolCalls(messages)

    expect(messages[0].content).toEqual([
      {
        type: 'text',
        text: 'Dropped invalid tool call with missing name. Arguments: {"command":"get_status"}',
      },
    ])
  })
})

describe('sanitizeProviderMessageSequence', () => {
  test('rewrites user messages that directly follow tool results', () => {
    const messages = [
      {
        role: 'toolResult',
        toolCallId: 'AbC123xyz',
        toolName: 'game',
        content: [{ type: 'text', text: 'Already docked' }],
        isError: true,
      },
      {
        role: 'user',
        content: '## Immediate Recovery Replan\n\nUse get_status now.',
        timestamp: 123,
      },
    ] as any

    sanitizeProviderMessageSequence(messages)

    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '## Immediate Recovery Replan\n\nUse get_status now.' }],
      timestamp: 123,
    })
  })
})

describe('sanitizeProviderContextMessages', () => {
  test('normalizes tool ids and rewrites user messages after tool results in one pass', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'fallback-tool-1', name: 'game', arguments: { command: 'travel' } },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'fallback-tool-1',
        toolName: 'game',
        content: [{ type: 'text', text: 'Pending action accepted' }],
        isError: false,
      },
      {
        role: 'user',
        content: '## Automatic Telemetry\n\nVerified state: furud / furud_belt',
        timestamp: 456,
      },
    ] as any

    sanitizeProviderContextMessages(messages)

    const toolCallId = messages[0].content[0].id
    expect(toolCallId).toMatch(/^[A-Za-z0-9]{9}$/)
    expect(messages[1].toolCallId).toBe(toolCallId)
    expect(messages[2]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '## Automatic Telemetry\n\nVerified state: furud / furud_belt' }],
      timestamp: 456,
    })
  })

  test('drops invalid assistant tool calls before provider normalization', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: '', name: '', arguments: { command: 'travel' } },
        ],
      },
    ] as any

    sanitizeProviderContextMessages(messages)

    expect(messages[0].content).toEqual([
      {
        type: 'text',
        text: 'Dropped invalid tool call with missing name. Arguments: {"command":"travel"}',
      },
    ])
  })

  test('drops a trailing assistant text message before provider submission', () => {
    const messages = [
      {
        role: 'user',
        content: 'Plot a route to the station.',
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Route plotted. Approaching docking range.' },
        ],
      },
    ] as any

    sanitizeProviderContextMessages(messages)

    expect(messages).toEqual([
      {
        role: 'user',
        content: 'Plot a route to the station.',
      },
    ])
  })
})

describe('sanitizeTerminalAssistantMessage', () => {
  test('preserves a trailing assistant tool call message', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'AbC123xyz', name: 'game', arguments: { command: 'get_status' } },
        ],
      },
    ] as any

    sanitizeTerminalAssistantMessage(messages)

    expect(messages).toHaveLength(1)
  })
})
