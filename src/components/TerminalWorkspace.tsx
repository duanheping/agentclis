import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

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
  splitRatio: number
  onSplitResizerPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onSplitResizerKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void
}

interface TerminalSurfaceProps {
  terminalId: string
  active: boolean
  autoFocus?: boolean
  onInput: (data: string) => void
  onResize: (cols: number, rows: number) => void | Promise<void>
}

const TERMINAL_SPLIT_RATIO_KEY = 'agenclis:terminal-split-ratio'
const DEFAULT_TERMINAL_SPLIT_RATIO = 2 / 3
const MIN_TERMINAL_PANE_HEIGHT = 160
const TERMINAL_SPLIT_RESIZER_SIZE = 12
const TERMINAL_SPLIT_KEYBOARD_STEP = 32
const TERMINAL_SCROLLBACK_LINES = 50_000

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function readTerminalSplitRatioPreference(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_TERMINAL_SPLIT_RATIO
  }

  try {
    const storedValue = window.localStorage.getItem(TERMINAL_SPLIT_RATIO_KEY)
    if (storedValue === null) {
      return DEFAULT_TERMINAL_SPLIT_RATIO
    }

    const parsedValue = Number(storedValue)
    return Number.isFinite(parsedValue)
      ? clampNumber(parsedValue, 0.25, 0.75)
      : DEFAULT_TERMINAL_SPLIT_RATIO
  } catch {
    return DEFAULT_TERMINAL_SPLIT_RATIO
  }
}

function clampTerminalSplitRatio(nextRatio: number, containerHeight: number): number {
  const availableHeight = Math.max(
    containerHeight - TERMINAL_SPLIT_RESIZER_SIZE,
    MIN_TERMINAL_PANE_HEIGHT * 2,
  )
  const minRatio = MIN_TERMINAL_PANE_HEIGHT / availableHeight
  const maxRatio = 1 - minRatio

  return clampNumber(nextRatio, minRatio, maxRatio)
}

export function TerminalWorkspace({
  sessions,
  activeSessionId,
  windowsCommandPromptSessionIds,
}: TerminalWorkspaceProps) {
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const splitResizeCleanupRef = useRef<(() => void) | null>(null)
  const [splitRatio, setSplitRatio] = useState<number>(() =>
    readTerminalSplitRatioPreference(),
  )

  const activeSessionShowsWindowsCommandPrompt =
    activeSessionId !== null &&
    windowsCommandPromptSessionIds.includes(activeSessionId)

  const beginSplitResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    resize: (clientY: number) => void,
  ) => {
    event.preventDefault()
    splitResizeCleanupRef.current?.()

    const originalCursor = document.body.style.cursor
    const originalUserSelect = document.body.style.userSelect

    const handlePointerMove = (moveEvent: PointerEvent) => {
      resize(moveEvent.clientY)
    }

    const stopResize = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
      document.body.style.cursor = originalCursor
      document.body.style.userSelect = originalUserSelect
      splitResizeCleanupRef.current = null
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
    splitResizeCleanupRef.current = stopResize
  }

  const handleSplitResizerPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (!workspaceRef.current) {
      return
    }

    const workspaceRect = workspaceRef.current.getBoundingClientRect()
    const availableHeight = workspaceRect.height - TERMINAL_SPLIT_RESIZER_SIZE
    if (availableHeight <= 0) {
      return
    }

    beginSplitResize(event, (clientY) => {
      const nextTopHeight = clampNumber(
        clientY - workspaceRect.top,
        MIN_TERMINAL_PANE_HEIGHT,
        workspaceRect.height - MIN_TERMINAL_PANE_HEIGHT - TERMINAL_SPLIT_RESIZER_SIZE,
      )

      setSplitRatio(
        clampTerminalSplitRatio(nextTopHeight / availableHeight, workspaceRect.height),
      )
    })
  }

  const handleSplitResizerKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (!workspaceRef.current) {
      return
    }

    const workspaceHeight = workspaceRef.current.getBoundingClientRect().height
    const availableHeight = workspaceHeight - TERMINAL_SPLIT_RESIZER_SIZE
    if (availableHeight <= 0) {
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSplitRatio((current) =>
        clampTerminalSplitRatio(
          current - TERMINAL_SPLIT_KEYBOARD_STEP / availableHeight,
          workspaceHeight,
        ),
      )
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSplitRatio((current) =>
        clampTerminalSplitRatio(
          current + TERMINAL_SPLIT_KEYBOARD_STEP / availableHeight,
          workspaceHeight,
        ),
      )
    }
  }

  useEffect(() => {
    return () => {
      splitResizeCleanupRef.current?.()
    }
  }, [])

  useEffect(() => {
    if (!activeSessionShowsWindowsCommandPrompt || !workspaceRef.current) {
      return
    }

    const workspaceHeight = workspaceRef.current.getBoundingClientRect().height
    if (workspaceHeight <= 0) {
      return
    }

    setSplitRatio((current) =>
      clampTerminalSplitRatio(current, workspaceHeight),
    )
  }, [activeSessionShowsWindowsCommandPrompt])

  useEffect(() => {
    try {
      window.localStorage.setItem(TERMINAL_SPLIT_RATIO_KEY, String(splitRatio))
    } catch {
      // Ignore storage failures so terminal layout still works normally.
    }
  }, [splitRatio])

  if (sessions.length === 0) {
    return <div ref={workspaceRef} className="terminal-workspace" />
  }

  return (
    <div ref={workspaceRef} className="terminal-workspace">
      {sessions.map((session) => (
        <SessionTerminalStack
          key={session.config.id}
          sessionId={session.config.id}
          active={session.config.id === activeSessionId}
          showWindowsCommandPrompt={windowsCommandPromptSessionIds.includes(
            session.config.id,
          )}
          splitRatio={splitRatio}
          onSplitResizerPointerDown={handleSplitResizerPointerDown}
          onSplitResizerKeyDown={handleSplitResizerKeyDown}
        />
      ))}
    </div>
  )
}

function SessionTerminalStack({
  sessionId,
  active,
  showWindowsCommandPrompt,
  splitRatio,
  onSplitResizerPointerDown,
  onSplitResizerKeyDown,
}: SessionTerminalStackProps) {
  const splitStyle = showWindowsCommandPrompt
    ? ({
        '--terminal-split-top-size': `${Math.max(splitRatio * 100, 1)}fr`,
        '--terminal-split-bottom-size': `${Math.max((1 - splitRatio) * 100, 1)}fr`,
      } as CSSProperties)
    : undefined

  return (
    <div
      className={`terminal-stack${active ? ' is-active' : ''}${showWindowsCommandPrompt ? ' is-split' : ''}`}
      style={splitStyle}
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
        <>
          <button
            type="button"
            className="terminal-stack__resizer"
            aria-label="Resize terminal split"
            onPointerDown={onSplitResizerPointerDown}
            onKeyDown={onSplitResizerKeyDown}
          />
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
        </>
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
      scrollback: TERMINAL_SCROLLBACK_LINES,
      allowTransparency: true,
      windowsPty: {
        backend: 'conpty',
      },
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
      }, (target) => {
        void window.agentCli.openExternalLink(target)
      }),
    )
    const detachPasteHandler = attachPlainTextPasteHandler(terminal, {
      resolveFilePath: (file) => window.agentCli.getPathForFile(file),
      persistFile: async (file) =>
        window.agentCli.persistTransientFile({
          name: file.name,
          type: file.type,
          data: await file.arrayBuffer(),
        }),
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
