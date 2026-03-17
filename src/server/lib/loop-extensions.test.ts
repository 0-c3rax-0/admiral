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

  test('recovers malformed inline game call with nested args', () => {
    const response = {
      content: [
        { type: 'text', text: 'tool_call game(, command=travel args={"target_poi":"furud_belt"})' },
      ],
    } as any

    expect(extractFallbackToolCalls(response)).toEqual([
      {
        type: 'toolCall',
        id: 'fallback-tool-1',
        name: 'game',
        arguments: { command: 'travel', args: { target_poi: 'furud_belt' } },
      },
    ])
  })

  test('recovers malformed inline game call without args', () => {
    const response = {
      content: [
        { type: 'text', text: 'game(, command=storage_view)' },
      ],
    } as any

    expect(extractFallbackToolCalls(response)).toEqual([
      {
        type: 'toolCall',
        id: 'fallback-tool-1',
        name: 'game',
        arguments: { command: 'storage_view', args: {} },
      },
    ])
  })

  test('recovers malformed inline game call for simple empty object args', () => {
    const response = {
      content: [
        { type: 'text', text: 'game(, command=get_cargo args={})' },
      ],
    } as any

    expect(extractFallbackToolCalls(response)).toEqual([
      {
        type: 'toolCall',
        id: 'fallback-tool-1',
        name: 'game',
        arguments: { command: 'get_cargo', args: {} },
      },
    ])
  })
})
