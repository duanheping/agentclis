import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionSnapshot } from '../shared/session'

const mockFit = vi.hoisted(() => vi.fn())

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
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
    focus = vi.fn()
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
})
