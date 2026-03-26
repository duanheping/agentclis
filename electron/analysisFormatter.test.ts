import { describe, it, expect } from 'vitest'
import { AnalysisEventFormatter } from './analysisFormatter'

function makeEvent(type: string, data: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, data, id: 'test-id', timestamp: new Date().toISOString() })
}

describe('AnalysisEventFormatter', () => {
  it('formats assistant.turn_start as a readable header', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push(makeEvent('assistant.turn_start', { turnId: '1' }) + '\n')
    expect(out).toContain('▶')
    expect(out).toContain('Agent turn 1')
  })

  it('formats assistant.turn_end as a dim summary', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push(makeEvent('assistant.turn_end', { turnId: '2' }) + '\n')
    expect(out).toContain('■')
    expect(out).toContain('Turn 2 complete')
  })

  it('formats tool_execution_complete with command name and content preview', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push(
      makeEvent('tool_execution_complete', {
        success: true,
        result: { content: 'file listing here' },
        toolTelemetry: { properties: { command: 'view' } },
      }) + '\n',
    )
    expect(out).toContain('✓')
    expect(out).toContain('view')
    expect(out).toContain('file listing here')
  })

  it('shows failure icon for unsuccessful tool execution', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push(
      makeEvent('tool_execution_complete', {
        success: false,
        result: { content: '' },
        toolTelemetry: { properties: { command: 'grep' } },
      }) + '\n',
    )
    expect(out).toContain('✗')
    expect(out).toContain('grep')
  })

  it('truncates long content previews', () => {
    const fmt = new AnalysisEventFormatter()
    const longContent = 'x'.repeat(200)
    const out = fmt.push(
      makeEvent('tool_execution_complete', {
        success: true,
        result: { content: longContent },
        toolTelemetry: { properties: { command: 'view' } },
      }) + '\n',
    )
    expect(out).toContain('…')
    expect(out).not.toContain('x'.repeat(200))
  })

  it('passes through non-JSON lines unchanged', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push('PS C:\\Users> some prompt text\n')
    expect(out).toContain('PS C:\\Users> some prompt text')
  })

  it('handles partial chunks by buffering until newline', () => {
    const fmt = new AnalysisEventFormatter()
    const event = makeEvent('assistant.turn_start', { turnId: '5' })
    const half = Math.floor(event.length / 2)

    const out1 = fmt.push(event.slice(0, half))
    expect(out1).toBe('')

    const out2 = fmt.push(event.slice(half) + '\n')
    expect(out2).toContain('Agent turn 5')
  })

  it('suppresses unknown event types', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push(makeEvent('internal.debug', { foo: 'bar' }) + '\n')
    expect(out).toBe('')
  })

  it('flushes non-JSON partial data immediately', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push('leftover text without newline')
    expect(out).toContain('leftover text without newline')
    expect(fmt.flush()).toBe('')
  })

  it('buffers partial JSON data until newline', () => {
    const fmt = new AnalysisEventFormatter()
    const event = makeEvent('assistant.turn_start', { turnId: '9' })
    const out = fmt.push(event.slice(0, 10))
    expect(out).toBe('')
    const out2 = fmt.push(event.slice(10) + '\n')
    expect(out2).toContain('Agent turn 9')
  })

  it('handles multiple events in a single chunk', () => {
    const fmt = new AnalysisEventFormatter()
    const chunk =
      makeEvent('assistant.turn_start', { turnId: '1' }) + '\n' +
      makeEvent('tool_execution_complete', {
        success: true,
        result: { content: 'ok' },
        toolTelemetry: { properties: { command: 'edit' } },
      }) + '\n' +
      makeEvent('assistant.turn_end', { turnId: '1' }) + '\n'

    const out = fmt.push(chunk)
    expect(out).toContain('Agent turn 1')
    expect(out).toContain('edit')
    expect(out).toContain('Turn 1 complete')
  })

  it('handles tool_execution_start event', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push(
      makeEvent('tool_execution_start', {
        toolTelemetry: { properties: { command: 'glob' } },
      }) + '\n',
    )
    expect(out).toContain('⚙')
    expect(out).toContain('glob')
  })

  it('formats content events as pass-through text', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push(
      makeEvent('content', { content: 'Analyzing project structure...' }) + '\n',
    )
    expect(out).toContain('Analyzing project structure...')
  })

  it('passes through JSON objects without a type field', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push('{"key":"value"}\n')
    expect(out).toContain('{"key":"value"}')
  })

  it('formats assistant.message events with text content', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push(
      makeEvent('assistant.message', { content: 'Here is the result.' }) + '\n',
    )
    expect(out).toContain('Here is the result.')
    expect(out).toContain('\r\n')
  })

  it('formats assistant.message.delta events as inline text', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push(
      makeEvent('assistant.message.delta', { text: 'partial output' }) + '\n',
    )
    expect(out).toContain('partial output')
  })

  it('returns empty for content event with empty text', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push(makeEvent('content', { content: '' }) + '\n')
    expect(out).toBe('')
  })

  it('returns empty for assistant.message with empty content', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push(makeEvent('assistant.message', { content: '' }) + '\n')
    expect(out).toBe('')
  })

  it('handles tool_execution_start with toolCallId fallback', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push(
      makeEvent('tool_execution_start', { toolCallId: 'call_123' }) + '\n',
    )
    expect(out).toContain('⚙')
    expect(out).toContain('call_123')
  })

  it('handles tool_execution_complete with no telemetry', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push(
      makeEvent('tool_execution_complete', {
        success: true,
        result: { content: 'ok' },
      }) + '\n',
    )
    expect(out).toContain('✓')
    expect(out).toContain('tool')
  })

  it('defaults turnId to ? when missing', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push(makeEvent('assistant.turn_start', {}) + '\n')
    expect(out).toContain('Agent turn ?')
  })

  it('flush returns remaining buffered JSON', () => {
    const fmt = new AnalysisEventFormatter()
    fmt.push(makeEvent('assistant.turn_start', { turnId: '7' }))
    const flushed = fmt.flush()
    expect(flushed).toContain('Agent turn 7')
  })

  it('flush returns empty string when nothing buffered', () => {
    const fmt = new AnalysisEventFormatter()
    expect(fmt.flush()).toBe('')
  })

  it('handles empty lines as blank output', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push('\n\n\n')
    expect(out).toBe('\r\n\r\n\r\n')
  })

  it('handles \\r\\n line endings', () => {
    const fmt = new AnalysisEventFormatter()
    const event = makeEvent('assistant.turn_start', { turnId: '3' })
    const out = fmt.push(event + '\r\n')
    expect(out).toContain('Agent turn 3')
  })

  it('converts newlines to \\r\\n in content events', () => {
    const fmt = new AnalysisEventFormatter()
    const out = fmt.push(
      makeEvent('content', { content: 'line1\nline2' }) + '\n',
    )
    expect(out).toContain('line1\r\nline2')
  })
})
