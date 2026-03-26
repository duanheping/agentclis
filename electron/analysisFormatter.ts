const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'

const CONTENT_PREVIEW_MAX = 120

function previewContent(value: string, max: number): string {
  const flat = value.replace(/[\r\n]+/g, ' ').trim()
  if (!flat) return ''
  if (flat.length <= max) return flat
  return `${flat.slice(0, max)}…`
}

interface AgentEvent {
  type?: string
  data?: Record<string, unknown>
}

/**
 * Transforms raw JSON-event output from structured agent CLIs
 * (copilot, claude) into concise, ANSI-colored terminal text.
 *
 * Non-JSON lines (shell prompts, PowerShell messages, etc.) pass
 * through unchanged so the terminal still feels interactive.
 */
export class AnalysisEventFormatter {
  private buffer = ''

  /**
   * Feed raw PTY data and receive formatted terminal output.
   * Buffers partial lines that look like JSON until a newline arrives.
   * Non-JSON partial data is flushed immediately for responsive display.
   */
  push(chunk: string): string {
    this.buffer += chunk
    let output = ''

    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const raw = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)

      const line = raw.replace(/\r$/, '')
      if (!line.trim()) {
        output += '\r\n'
        continue
      }

      const formatted = this.tryFormatJsonLine(line.trim())
      output += formatted ?? `${line}\r\n`
    }

    // Flush partial non-JSON data immediately for responsive display.
    // Only buffer when the pending data looks like a JSON object.
    if (this.buffer && !this.buffer.trimStart().startsWith('{')) {
      output += this.buffer
      this.buffer = ''
    }

    return output
  }

  /** Flush any remaining buffered content (call on process exit). */
  flush(): string {
    const rest = this.buffer.trim()
    this.buffer = ''
    if (!rest) return ''
    const formatted = this.tryFormatJsonLine(rest)
    return formatted ?? `${rest}\r\n`
  }

  private tryFormatJsonLine(line: string): string | null {
    if (!line.startsWith('{')) return null

    let event: AgentEvent
    try {
      event = JSON.parse(line)
    } catch {
      return null
    }

    if (!event.type) return null
    return this.formatEvent(event)
  }

  private formatEvent(event: AgentEvent): string {
    const data = (event.data ?? {}) as Record<string, unknown>

    switch (event.type) {
      case 'assistant.turn_start': {
        const turnId = data.turnId ?? '?'
        return `\r\n${CYAN}${BOLD}▶ Agent turn ${turnId}${RESET}\r\n`
      }

      case 'assistant.turn_end': {
        const turnId = data.turnId ?? '?'
        return `${DIM}■ Turn ${turnId} complete${RESET}\r\n`
      }

      case 'tool_execution_complete': {
        const success = data.success as boolean | undefined
        const telemetry = data.toolTelemetry as Record<string, unknown> | undefined
        const props = (telemetry?.properties ?? {}) as Record<string, unknown>
        const command = (props.command ?? 'tool') as string
        const result = (data.result ?? {}) as Record<string, unknown>
        const content = (result.content ?? '') as string

        const icon = success === false
          ? `${RED}✗${RESET}`
          : `${GREEN}✓${RESET}`
        const preview = previewContent(content, CONTENT_PREVIEW_MAX)
        const suffix = preview ? `  ${DIM}→ ${preview}${RESET}` : ''

        return `  ${icon} ${BOLD}${command}${RESET}${suffix}\r\n`
      }

      case 'tool_execution_start': {
        const telemetry = data.toolTelemetry as Record<string, unknown> | undefined
        const props = (telemetry?.properties ?? {}) as Record<string, unknown>
        const command = (props.command ?? data.toolCallId ?? 'tool') as string
        return `  ${YELLOW}⚙ ${command}…${RESET}\r\n`
      }

      case 'content':
      case 'assistant.message.delta': {
        const text = (data.content ?? data.text ?? '') as string
        if (!text) return ''
        return text.replace(/\n/g, '\r\n')
      }

      case 'assistant.message': {
        const text = (data.content ?? data.text ?? '') as string
        if (!text) return ''
        return `${text.replace(/\n/g, '\r\n')}\r\n`
      }

      default:
        // Suppress noisy/internal event types
        return ''
    }
  }
}
