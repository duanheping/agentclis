import { useEffect, useRef } from 'react'

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'

import {
  buildWindowsCommandPromptTerminalId,
  terminalRegistry,
} from '../lib/terminalRegistry'
import { attachPlainTextPasteHandler } from '../lib/terminalPaste'
import type { SessionSnapshot } from '../shared/session'

interface TerminalWorkspaceProps {
  sessions: SessionSnapshot[]
  activeSessionId: string | null
  windowsCommandPromptSessionIds: string[]
}

interface SessionTerminalStackProps {
  sessionId: string
  active: boolean
  showWindowsCommandPrompt: boolean
}

interface TerminalSurfaceProps {
  terminalId: string
  active: boolean
  autoFocus?: boolean
  onInput: (data: string) => void
  onResize: (cols: number, rows: number) => void | Promise<void>
}

export function TerminalWorkspace({
  sessions,
  activeSessionId,
  windowsCommandPromptSessionIds,
}: TerminalWorkspaceProps) {
  if (sessions.length === 0) {
    return (
      <div className="workspace-empty">
        <div className="workspace-empty__card">
          <p className="eyebrow">Workspace</p>
          <h2>等待第一个会话</h2>
          <p>创建一个 agent CLI 后，这里会显示它的实时终端输出。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="terminal-workspace">
      {sessions.map((session) => (
        <SessionTerminalStack
          key={session.config.id}
          sessionId={session.config.id}
          active={session.config.id === activeSessionId}
          showWindowsCommandPrompt={windowsCommandPromptSessionIds.includes(
            session.config.id,
          )}
        />
      ))}
    </div>
  )
}

function SessionTerminalStack({
  sessionId,
  active,
  showWindowsCommandPrompt,
}: SessionTerminalStackProps) {
  return (
    <div
      className={`terminal-stack${active ? ' is-active' : ''}${showWindowsCommandPrompt ? ' is-split' : ''}`}
    >
      <div className={`terminal-pane${showWindowsCommandPrompt ? ' has-header' : ''}`}>
        {showWindowsCommandPrompt ? (
          <div className="terminal-pane__header">Agent CLI</div>
        ) : null}
        <TerminalSurface
          terminalId={sessionId}
          active={active}
          autoFocus
          onInput={(data) => {
            void window.agentCli.writeToSession(sessionId, data)
          }}
          onResize={(cols, rows) => {
            void window.agentCli.resizeSession(sessionId, cols, rows)
          }}
        />
      </div>

      {showWindowsCommandPrompt ? (
        <div className="terminal-pane terminal-pane--windows-cmd has-header">
          <div className="terminal-pane__header">Windows cmd</div>
          <TerminalSurface
            terminalId={buildWindowsCommandPromptTerminalId(sessionId)}
            active={active}
            onInput={(data) => {
              void window.agentCli.writeToWindowsCommandPrompt(sessionId, data)
            }}
            onResize={(cols, rows) => {
              void window.agentCli.resizeWindowsCommandPrompt(sessionId, cols, rows)
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

function TerminalSurface({
  terminalId,
  active,
  autoFocus = false,
  onInput,
  onResize,
}: TerminalSurfaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const activeRef = useRef(active)
  const onInputRef = useRef(onInput)
  const onResizeRef = useRef(onResize)

  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    onInputRef.current = onInput
    onResizeRef.current = onResize
  }, [onInput, onResize])

  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      allowTransparency: true,
      theme: {
        background: '#09111f',
        foreground: '#e4edf8',
        cursor: '#7ae0d6',
        black: '#162437',
        brightBlack: '#4c6a88',
        red: '#ff7c8c',
        brightRed: '#ff99a5',
        green: '#81e1a8',
        brightGreen: '#b4f0cb',
        yellow: '#ffd28b',
        brightYellow: '#ffe4aa',
        blue: '#6db4ff',
        brightBlue: '#9bc8ff',
        magenta: '#f0a3ff',
        brightMagenta: '#f5bbff',
        cyan: '#7ae0d6',
        brightCyan: '#abfff6',
        white: '#c8d7e6',
        brightWhite: '#f7fbff',
      },
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current!)
    const detachPasteHandler = attachPlainTextPasteHandler(terminal)

    const fitTerminal = () => {
      fitAddon.fit()
      void onResizeRef.current(terminal.cols, terminal.rows)
    }

    terminalRegistry.register(terminalId, {
      write: (chunk) => terminal.write(chunk),
      clear: () => terminal.clear(),
      fit: fitTerminal,
      focus: () => terminal.focus(),
    })

    const resizeObserver = new ResizeObserver(() => {
      if (!activeRef.current) {
        return
      }

      requestAnimationFrame(fitTerminal)
    })

    resizeObserver.observe(containerRef.current!)

    const disposable = terminal.onData((data) => {
      onInputRef.current(data)
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    requestAnimationFrame(fitTerminal)

    return () => {
      detachPasteHandler()
      resizeObserver.disconnect()
      disposable.dispose()
      terminalRegistry.unregister(terminalId)
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [terminalId])

  useEffect(() => {
    if (!active || !terminalRef.current || !fitAddonRef.current) {
      return
    }

    requestAnimationFrame(() => {
      terminalRegistry.fit(terminalId)

      if (autoFocus) {
        terminalRegistry.focus(terminalId)
      }
    })
  }, [active, autoFocus, terminalId])

  return <div ref={containerRef} className="terminal-surface" />
}
