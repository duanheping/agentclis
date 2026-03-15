import { useEffect, useRef } from 'react'

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'

import {
  buildWindowsCommandPromptTerminalId,
  terminalRegistry,
} from '../lib/terminalRegistry'
import { getTerminalShortcutInput } from '../lib/terminalKeybindings'
import { createMarkdownFileLinkProvider } from '../lib/terminalMarkdownLinks'
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
    return <div className="terminal-workspace" />
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
        background: '#161616',
        foreground: '#e8e8ea',
        cursor: '#dbc29d',
        black: '#202020',
        brightBlack: '#6d6d72',
        red: '#ff7f7f',
        brightRed: '#ffaaaa',
        green: '#78d48f',
        brightGreen: '#a6e3b5',
        yellow: '#d8bf91',
        brightYellow: '#f0dfbe',
        blue: '#87a5d6',
        brightBlue: '#adc2e7',
        magenta: '#c6add8',
        brightMagenta: '#e0c7ef',
        cyan: '#8ab3af',
        brightCyan: '#acd0cc',
        white: '#d4d4d8',
        brightWhite: '#fafafb',
      },
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current!)
    const markdownFileLinks = terminal.registerLinkProvider(
      createMarkdownFileLinkProvider(terminal, (target) => {
        void window.agentCli.openFileReference(target)
      }),
    )
    const detachPasteHandler = attachPlainTextPasteHandler(terminal, {
      resolveFilePath: (file) => window.agentCli.getPathForFile(file),
    })
    terminal.attachCustomKeyEventHandler((event) => {
      const shortcutInput = getTerminalShortcutInput(event)
      if (shortcutInput === null) {
        return true
      }

      event.preventDefault()
      event.stopPropagation()
      onInputRef.current(shortcutInput)
      return false
    })

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
      markdownFileLinks.dispose()
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
