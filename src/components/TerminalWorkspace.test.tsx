import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionSnapshot } from '../shared/session'
import { terminalRegistry } from '../lib/terminalRegistry'

const mockFit = vi.hoisted(() => vi.fn())
const mockSerialize = vi.hoisted(() => vi.fn(() => 'serialized-snapshot'))
const mockTerminalConstructor = vi.hoisted(() => vi.fn())
const terminalInstances = vi.hoisted(() => [] as Array<{
  write: ReturnType<typeof vi.fn>
}>)

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    constructor(options?: unknown) {
      mockTerminalConstructor(options)
      terminalInstances.push(this)
    }

    cols = 80
    rows = 24
    element = document.createElement('div')
    textarea = document.createElement('textarea')
    buffer = {
      active: {
        type: 'normal',
        baseY: 0,
        length: 0,
        getLine: () => null,
      },
    }

    loadAddon = vi.fn((addon: { activate?: (terminal: unknown) => void }) => {
      addon.activate?.(this)
    })
    open = vi.fn((container: HTMLElement) => {
      const terminalRoot = document.createElement('div')
      terminalRoot.className = 'xterm'
      const scrollable = document.createElement('div')
      scrollable.className = 'xterm-scrollable-element'
      const scrollbar = document.createElement('div')
      scrollbar.className = 'scrollbar invisible fade'
      scrollable.appendChild(scrollbar)
      terminalRoot.appendChild(scrollable)
      const viewport = document.createElement('div')
      viewport.className = 'xterm-viewport'
      terminalRoot.appendChild(viewport)
      const textarea = document.createElement('textarea')
      terminalRoot.appendChild(textarea)
      container.appendChild(terminalRoot)
      this.element = terminalRoot
      this.textarea = textarea
    })
    registerLinkProvider = vi.fn(() => ({
      dispose: vi.fn(),
    }))
    attachCustomKeyEventHandler = vi.fn()
    onData = vi.fn(() => ({
      dispose: vi.fn(),
    }))
    write = vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })
    scrollLines = vi.fn()
    clear = vi.fn()
    focus = vi.fn(() => {
      this.textarea.focus()
    })
    paste = vi.fn()
    getSelection = vi.fn(() => '')
    hasSelection = vi.fn(() => false)
    dispose = vi.fn()
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit = mockFit
  },
}))

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class MockSerializeAddon {
    activate() {}
    serialize = mockSerialize
  },
}))

vi.mock('../lib/terminalMarkdownLinks', () => ({
  createMarkdownFileLinkProvider: () => ({
    provideLinks: () => {},
  }),
}))

vi.mock('../lib/terminalPaste', () => ({
  attachPlainTextPasteHandler: () => vi.fn(),
}))

import { TerminalWorkspace } from './TerminalWorkspace'

function buildSession(): SessionSnapshot {
  return {
    config: {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Session 1',
      startupCommand: 'codex',
      pendingFirstPromptTitle: false,
      cwd: 'C:\\repo\\agentclis',
      shell: 'powershell.exe',
      createdAt: '2026-03-20T10:00:00.000Z',
      updatedAt: '2026-03-20T10:00:00.000Z',
    },
    runtime: {
      sessionId: 'session-1',
      status: 'running',
      lastActiveAt: '2026-03-20T10:00:00.000Z',
    },
  }
}

function buildSessionWithId(id: string): SessionSnapshot {
  const session = buildSession()

  return {
    ...session,
    config: {
      ...session.config,
      id,
      title: `Session ${id}`,
    },
    runtime: {
      ...session.runtime,
      sessionId: id,
    },
  }
}

function mockElementRect(
  element: Element,
  rect: {
    left: number
    top: number
    width: number
    height: number
  },
): void {
  const right = rect.left + rect.width
  const bottom = rect.top + rect.height

  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: rect.left,
      y: rect.top,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      right,
      bottom,
      toJSON: () => '',
    }),
  })
}

describe('TerminalWorkspace', () => {
  beforeEach(() => {
    window.localStorage.clear()
    mockFit.mockClear()
    mockSerialize.mockClear()
    mockTerminalConstructor.mockClear()
    terminalInstances.length = 0

    vi.stubGlobal(
      'requestAnimationFrame',
      ((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      }) as typeof requestAnimationFrame,
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    )

    Object.defineProperty(window, 'agentCli', {
      configurable: true,
      value: {
        writeToSession: vi.fn().mockResolvedValue(undefined),
        resizeSession: vi.fn().mockResolvedValue(undefined),
        getSessionTerminalReplay: vi.fn().mockResolvedValue({ chunks: [] }),
        updateSessionTerminalSnapshot: vi.fn(),
        writeToWindowsCommandPrompt: vi.fn().mockResolvedValue(undefined),
        resizeWindowsCommandPrompt: vi.fn().mockResolvedValue(undefined),
        openFileReference: vi.fn().mockResolvedValue(undefined),
        openExternalLink: vi.fn().mockResolvedValue(undefined),
        getPathForFile: vi.fn(() => null),
        persistTransientFile: vi.fn().mockResolvedValue('C:\\temp\\clipboard.png'),
      },
    })
  })

  afterEach(() => {
    cleanup()
    terminalRegistry.forget('session-1')
    terminalRegistry.forget('session-1:windows-cmd')
    vi.unstubAllGlobals()
  })

  it('defaults the agent terminal to roughly two thirds of the split height', async () => {
    const { container } = render(
      <TerminalWorkspace
        sessions={[buildSession()]}
        activeSessionId="session-1"
        windowsCommandPromptSessionIds={['session-1']}
      />,
    )

    const workspace = container.querySelector('.terminal-workspace') as HTMLDivElement | null
    const stack = container.querySelector('.terminal-stack.is-split') as HTMLDivElement | null

    expect(workspace).not.toBeNull()
    expect(stack).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Resize terminal split' })).toBeInTheDocument()

    mockElementRect(workspace!, {
      left: 0,
      top: 0,
      width: 1200,
      height: 900,
    })

    expect(parseFloat(stack!.style.getPropertyValue('--terminal-split-top-size'))).toBeCloseTo(
      66.67,
      1,
    )
    expect(
      parseFloat(stack!.style.getPropertyValue('--terminal-split-bottom-size')),
    ).toBeCloseTo(33.33, 1)
  })

  it('updates the split ratio when the divider is dragged', async () => {
    const { container } = render(
      <TerminalWorkspace
        sessions={[buildSession()]}
        activeSessionId="session-1"
        windowsCommandPromptSessionIds={['session-1']}
      />,
    )

    const workspace = container.querySelector('.terminal-workspace') as HTMLDivElement | null
    const stack = container.querySelector('.terminal-stack.is-split') as HTMLDivElement | null

    expect(workspace).not.toBeNull()
    expect(stack).not.toBeNull()

    mockElementRect(workspace!, {
      left: 0,
      top: 0,
      width: 1200,
      height: 900,
    })

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize terminal split' }), {
      clientY: 600,
    })
    fireEvent.pointerMove(window, { clientY: 720 })
    fireEvent.pointerUp(window)

    await waitFor(() => {
      expect(
        parseFloat(stack!.style.getPropertyValue('--terminal-split-top-size')),
      ).toBeCloseTo(81.08, 1)
    })

    expect(
      parseFloat(stack!.style.getPropertyValue('--terminal-split-bottom-size')),
    ).toBeCloseTo(18.92, 1)
  })

  it('configures terminals for long ConPTY-backed sessions', async () => {
    render(
      <TerminalWorkspace
        sessions={[buildSession()]}
        activeSessionId="session-1"
        windowsCommandPromptSessionIds={[]}
      />,
    )

    await waitFor(() => {
      expect(mockTerminalConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          scrollback: 50_000,
          windowsPty: {
            backend: 'conpty',
          },
        }),
      )
    })
  })

  it('only mounts xterm surfaces for the active session', async () => {
    render(
      <TerminalWorkspace
        sessions={[
          buildSessionWithId('session-1'),
          buildSessionWithId('session-2'),
          buildSessionWithId('session-3'),
        ]}
        activeSessionId="session-2"
        windowsCommandPromptSessionIds={[]}
      />,
    )

    await waitFor(() => {
      expect(mockTerminalConstructor).toHaveBeenCalledTimes(1)
    })
  })

  it('routes OSC hyperlinks through the Electron external-link bridge', async () => {
    render(
      <TerminalWorkspace
        sessions={[buildSession()]}
        activeSessionId="session-1"
        windowsCommandPromptSessionIds={[]}
      />,
    )

    await waitFor(() => {
      expect(mockTerminalConstructor).toHaveBeenCalled()
    })

    const terminalOptions = mockTerminalConstructor.mock.calls[0]?.[0] as
      | {
          linkHandler?: {
            activate: (event: MouseEvent, text: string) => void
          }
        }
      | undefined

    terminalOptions?.linkHandler?.activate(
      {} as MouseEvent,
      'https://example.com',
    )

    expect(window.agentCli.openExternalLink).toHaveBeenCalledWith(
      'https://example.com',
    )
  })

  it('replays transcript history before showing new buffered live output', async () => {
    window.agentCli.getSessionTerminalReplay = vi.fn().mockResolvedValue({
      chunks: ['history-1', 'shared'],
    })
    terminalRegistry.write('session-1', 'shared')
    terminalRegistry.write('session-1', 'live-1')

    render(
      <TerminalWorkspace
        sessions={[buildSession()]}
        activeSessionId="session-1"
        windowsCommandPromptSessionIds={[]}
      />,
    )

    await waitFor(() => {
      expect(window.agentCli.getSessionTerminalReplay).toHaveBeenCalledWith(
        'session-1',
      )
      expect(terminalInstances[0]?.write).toHaveBeenCalledTimes(2)
    })

    expect(terminalInstances[0]?.write).toHaveBeenNthCalledWith(
      1,
      'history-1shared',
    )
    expect(terminalInstances[0]?.write).toHaveBeenNthCalledWith(2, 'live-1')
  })

  it('suppresses clear-only live redraw chunks until visible content arrives after replay', async () => {
    window.agentCli.getSessionTerminalReplay = vi.fn().mockResolvedValue({
      chunks: ['history'],
    })

    render(
      <TerminalWorkspace
        sessions={[buildSession()]}
        activeSessionId="session-1"
        windowsCommandPromptSessionIds={[]}
      />,
    )

    await waitFor(() => {
      expect(window.agentCli.getSessionTerminalReplay).toHaveBeenCalledWith(
        'session-1',
      )
      expect(terminalInstances[0]?.write).toHaveBeenCalledWith('history')
    })

    terminalRegistry.write(
      'session-1',
      '\x1b[?2004h\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b]0;pwsh\x07\x1b[?25h',
    )
    terminalRegistry.write(
      'session-1',
      '\x1b[2J\x1b[H\x1b[2m╭────────────────────╮\x1b[22m\r\n│ OpenAI Codex │',
    )

    await waitFor(() => {
      expect(terminalInstances[0]?.write).toHaveBeenCalledTimes(2)
    })

    expect(terminalInstances[0]?.write).toHaveBeenNthCalledWith(1, 'history')
    expect(terminalInstances[0]?.write).toHaveBeenNthCalledWith(
      2,
      '\x1b[2J\x1b[H\x1b[2m╭────────────────────╮\x1b[22m\r\n│ OpenAI Codex │',
    )
  })

  it('does not append buffered startup output on top of a snapshot replay', async () => {
    window.agentCli.getSessionTerminalReplay = vi.fn().mockResolvedValue({
      chunks: ['delta-shared'],
      source: 'snapshot',
      snapshot: {
        format: 'serialized',
        cols: 120,
        rows: 36,
        content: '\u001b[2Jrestored snapshot',
      },
    })
    terminalRegistry.write('session-1', 'delta-shared')
    terminalRegistry.write('session-1', 'OpenAI Codex banner')

    render(
      <TerminalWorkspace
        sessions={[buildSession()]}
        activeSessionId="session-1"
        windowsCommandPromptSessionIds={[]}
      />,
    )

    await waitFor(() => {
      expect(window.agentCli.getSessionTerminalReplay).toHaveBeenCalledWith(
        'session-1',
      )
      expect(terminalInstances[0]?.write).toHaveBeenCalledTimes(3)
    })

    expect(mockTerminalConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        cols: 120,
        rows: 36,
      }),
    )
    expect(terminalInstances[0]?.write).toHaveBeenCalledWith(
      '\u001b[2Jrestored snapshot',
      expect.any(Function),
    )
    expect(terminalInstances[0]?.write).toHaveBeenNthCalledWith(2, 'delta-shared')
    expect(terminalInstances[0]?.write).toHaveBeenNthCalledWith(
      3,
      'OpenAI Codex banner',
    )
  })

  it('focuses the windows cmd terminal when a focus request targets it', async () => {
    render(
      <TerminalWorkspace
        sessions={[buildSession()]}
        activeSessionId="session-1"
        windowsCommandPromptSessionIds={['session-1']}
        focusTerminalId="session-1:windows-cmd"
        focusTerminalSequence={1}
      />,
    )

    await waitFor(() => {
      const textareas = document.querySelectorAll('.xterm textarea')
      expect(textareas).toHaveLength(2)
      expect(document.activeElement).toBe(textareas[1])
    })
  })

  it('does not request persisted replay for the windows cmd pane', async () => {
    render(
      <TerminalWorkspace
        sessions={[buildSession()]}
        activeSessionId="session-1"
        windowsCommandPromptSessionIds={['session-1']}
      />,
    )

    await waitFor(() => {
      expect(window.agentCli.getSessionTerminalReplay).toHaveBeenCalledWith(
        'session-1',
      )
    })

    expect(window.agentCli.getSessionTerminalReplay).toHaveBeenCalledTimes(1)
    expect(window.agentCli.getSessionTerminalReplay).not.toHaveBeenCalledWith(
      'session-1:windows-cmd',
    )
  })

  it('keeps the xterm overlay scrollbar interactive for pointer dragging', async () => {
    const { container } = render(
      <TerminalWorkspace
        sessions={[buildSession()]}
        activeSessionId="session-1"
        windowsCommandPromptSessionIds={[]}
      />,
    )

    await waitFor(() => {
      const scrollbar = container.querySelector(
        '.terminal-surface .xterm .xterm-scrollable-element > .scrollbar.invisible.fade',
      ) as HTMLDivElement | null

      expect(scrollbar).not.toBeNull()
      expect(scrollbar?.style.opacity).toBe('1')
      expect(scrollbar?.style.pointerEvents).toBe('auto')
      expect(scrollbar?.style.zIndex).toBe('11')
      expect(scrollbar?.style.background).toBe('rgba(0, 0, 0, 0)')
      expect(scrollbar?.style.transition).toBe('none')
    })
  })

  it('refocuses the active terminal when the surface is clicked', async () => {
    const { container } = render(
      <TerminalWorkspace
        sessions={[buildSession()]}
        activeSessionId="session-1"
        windowsCommandPromptSessionIds={[]}
      />,
    )

    const terminalSurface = container.querySelector(
      '.terminal-surface',
    ) as HTMLDivElement | null
    const outsideButton = document.createElement('button')
    document.body.appendChild(outsideButton)

    await waitFor(() => {
      expect(
        container.querySelector('.terminal-surface .xterm textarea'),
      ).not.toBeNull()
    })

    outsideButton.focus()

    expect(terminalSurface).not.toBeNull()
    expect(document.activeElement).toBe(outsideButton)

    fireEvent.pointerDown(terminalSurface!, { button: 0 })

    await waitFor(() => {
      const terminalTextarea = container.querySelector(
        '.terminal-surface .xterm textarea',
      ) as HTMLTextAreaElement | null
      expect(terminalTextarea).not.toBeNull()
      expect(document.activeElement).toBe(terminalTextarea)
    })

    outsideButton.remove()
  })
})
