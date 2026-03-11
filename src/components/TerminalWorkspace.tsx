import { useEffect, useRef } from 'react'

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'

import { terminalRegistry } from '../lib/terminalRegistry'
import { attachPlainTextPasteHandler } from '../lib/terminalPaste'
import type { SessionSnapshot } from '../shared/session'

interface TerminalWorkspaceProps {
  sessions: SessionSnapshot[]
  activeSessionId: string | null
}

interface SessionTerminalProps {
  sessionId: string
  active: boolean
}

export function TerminalWorkspace({
  sessions,
  activeSessionId,
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
        <SessionTerminal
          key={session.config.id}
          sessionId={session.config.id}
          active={session.config.id === activeSessionId}
        />
      ))}
    </div>
  )
}

function SessionTerminal({ sessionId, active }: SessionTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const activeRef = useRef(active)

  useEffect(() => {
    activeRef.current = active
  }, [active])

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
      void window.agentCli.resizeSession(sessionId, terminal.cols, terminal.rows)
    }

    terminalRegistry.register(sessionId, {
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
      void window.agentCli.writeToSession(sessionId, data)
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    requestAnimationFrame(fitTerminal)

    return () => {
      detachPasteHandler()
      resizeObserver.disconnect()
      disposable.dispose()
      terminalRegistry.unregister(sessionId)
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId])

  useEffect(() => {
    if (!active || !terminalRef.current || !fitAddonRef.current) {
      return
    }

    requestAnimationFrame(() => {
      terminalRegistry.fit(sessionId)
      terminalRegistry.focus(sessionId)
    })
  }, [active, sessionId])

  return (
    <div
      ref={containerRef}
      className={`terminal-surface${active ? ' is-active' : ''}`}
    />
  )
}
