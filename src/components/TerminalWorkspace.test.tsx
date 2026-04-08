import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionSnapshot } from '../shared/session'

const mockFit = vi.hoisted(() => vi.fn())
const mockTerminalConstructor = vi.hoisted(() => vi.fn())

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    constructor(options?: unknown) {
      mockTerminalConstructor(options)
    }

    cols = 80
    rows = 24
    element = document.createElement('div')
    textarea = document.createElement('textarea')
    buffer = {
      active: {
        length: 0,
        getLine: () => null,
      },
    }

    loadAddon = vi.fn()
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
    write = vi.fn()
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
    mockTerminalConstructor.mockClear()

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

  it('configures terminals for long ConPTY-backed sessions', () => {
    render(
      <TerminalWorkspace
        sessions={[buildSession()]}
        activeSessionId="session-1"
        windowsCommandPromptSessionIds={[]}
      />,
    )

    expect(mockTerminalConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        scrollback: 50_000,
        windowsPty: {
          backend: 'conpty',
        },
      }),
    )
  })

  it('routes OSC hyperlinks through the Electron external-link bridge', () => {
    render(
      <TerminalWorkspace
        sessions={[buildSession()]}
        activeSessionId="session-1"
        windowsCommandPromptSessionIds={[]}
      />,
    )

    const terminalOptions = mockTerminalConstructor.mock.calls[0]?.[0] as {
      linkHandler?: {
        activate: (event: MouseEvent, text: string) => void
      }
    }

    terminalOptions.linkHandler?.activate({} as MouseEvent, 'https://example.com')

    expect(window.agentCli.openExternalLink).toHaveBeenCalledWith(
      'https://example.com',
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

    const textareas = document.querySelectorAll('.xterm textarea')

    await waitFor(() => {
      expect(textareas).toHaveLength(2)
      expect(document.activeElement).toBe(textareas[1])
    })
  })

  it('keeps the xterm overlay scrollbar interactive for pointer dragging', () => {
    const { container } = render(
      <TerminalWorkspace
        sessions={[buildSession()]}
        activeSessionId="session-1"
        windowsCommandPromptSessionIds={[]}
      />,
    )

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

  it('refocuses the active terminal when the surface is clicked', async () => {
    const { container } = render(
      <TerminalWorkspace
        sessions={[buildSession()]}
        activeSessionId="session-1"
        windowsCommandPromptSessionIds={[]}
      />,
    )

    const terminalTextarea = container.querySelector(
      '.terminal-surface .xterm textarea',
    ) as HTMLTextAreaElement | null
    const terminalSurface = container.querySelector(
      '.terminal-surface',
    ) as HTMLDivElement | null
    const outsideButton = document.createElement('button')
    document.body.appendChild(outsideButton)
    outsideButton.focus()

    expect(terminalTextarea).not.toBeNull()
    expect(terminalSurface).not.toBeNull()
    expect(document.activeElement).toBe(outsideButton)

    fireEvent.pointerDown(terminalSurface!, { button: 0 })

    await waitFor(() => {
      expect(document.activeElement).toBe(terminalTextarea)
    })

    outsideButton.remove()
  })
})
