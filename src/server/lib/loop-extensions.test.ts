import { describe, expect, test } from 'bun:test'
import { extractFallbackToolCalls } from './loop-extensions'

describe('extractFallbackToolCalls', () => {
  test('recovers xml-style function calls with empty args', () => {
    const response = {
      content: [
        { type: 'text', text: 'Need state.\n<tool_call>\n<function=get_status>\n</function>\n</tool_call>' },
      ],
    } as any

    expect(extractFallbackToolCalls(response)).toEqual([
      { type: 'toolCall', id: 'fallback-tool-1', name: 'get_status', arguments: {} },
    ])
  })

  test('recovers malformed nested tool_call json blocks', () => {
    const response = {
      content: [
        { type: 'text', text: 'Check this.\n<tool_call>\n<tool_call>\n{"name": "get_location", "arguments": {}}\n</tool_call>' },
      ],
    } as any

    expect(extractFallbackToolCalls(response)).toEqual([
      { type: 'toolCall', id: 'fallback-tool-1', name: 'get_location', arguments: {} },
    ])
  })

  test('deduplicates the same recovered tool call', () => {
    const response = {
      content: [
        { type: 'text', text: '<function=get_status>\n</function>\n<tool_call>\n{"name":"get_status","arguments":{}}\n</tool_call>' },
      ],
    } as any

    expect(extractFallbackToolCalls(response)).toHaveLength(1)
  })
})
