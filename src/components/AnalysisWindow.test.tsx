import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fitSpy = vi.hoisted(() => vi.fn())
const terminalConstructorSpy = vi.hoisted(() => vi.fn())
const terminalState = vi.hoisted(() => ({
  instance: null as unknown,
  inputListener: null as ((data: string) => void) | null,
  inputDispose: vi.fn(),
}))

const MockTerminalClass = vi.hoisted(() => {
  return class MockTerminal {
    cols = 120
    rows = 36
    write = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    loadAddon = vi.fn()

    constructor(options?: unknown) {
      terminalConstructorSpy(options)
      terminalState.instance = this
    }

    open(container: HTMLElement) {
      const terminalRoot = document.createElement('div')
      terminalRoot.className = 'xterm'
      container.appendChild(terminalRoot)
    }

    onData(listener: (data: string) => void) {
      terminalState.inputListener = listener
      return {
        dispose: terminalState.inputDispose,
      }
    }
  }
})

vi.mock('@xterm/xterm', () => ({
  Terminal: MockTerminalClass,
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit = fitSpy
  },
}))

import { AnalysisWindow } from './AnalysisWindow'

describe('AnalysisWindow', () => {
  let resizeObserverCallback: (() => void) | null = null
  let resizeObserverDisconnect: () => void

  beforeEach(() => {
    resizeObserverDisconnect = vi.fn()
    terminalState.instance = null
    terminalState.inputListener = null
    terminalState.inputDispose.mockClear()
    fitSpy.mockClear()
    terminalConstructorSpy.mockClear()

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
        constructor(callback: () => void) {
          resizeObserverCallback = callback
        }

        observe() {}
        disconnect() {
          resizeObserverDisconnect()
        }
        unobserve() {}
      },
    )
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'agentCli')
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('wires the xterm instance to the analysis terminal bridge and cleans up listeners', () => {
    const removeDataListener = vi.fn()
    const removeExitListener = vi.fn()
    let analysisDataListener: ((event: { chunk: string }) => void) | null = null
    let analysisExitListener:
      | ((event: { exitCode: number; message: string }) => void)
      | null = null

    window.agentCli = {
      onAnalysisTerminalData: vi.fn((listener) => {
        analysisDataListener = listener
        return removeDataListener
      }),
      onAnalysisTerminalExit: vi.fn((listener) => {
        analysisExitListener = listener
        return removeExitListener
      }),
      writeToAnalysisTerminal: vi.fn().mockResolvedValue(undefined),
      resizeAnalysisTerminal: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof window.agentCli

    const { unmount } = render(<AnalysisWindow />)

    expect(terminalConstructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        scrollback: 50_000,
        windowsPty: {
          backend: 'conpty',
        },
      }),
    )
    expect(fitSpy).toHaveBeenCalled()
    expect(window.agentCli.resizeAnalysisTerminal).toHaveBeenCalledWith(120, 36)
    expect((terminalState.instance as InstanceType<typeof MockTerminalClass>)?.focus).toHaveBeenCalledTimes(1)

    act(() => {
      terminalState.inputListener?.('status\r')
    })

    expect(window.agentCli.writeToAnalysisTerminal).toHaveBeenCalledWith('status\r')

    act(() => {
      analysisDataListener?.({ chunk: 'analysis output' })
      analysisExitListener?.({ exitCode: 0, message: 'Analysis complete.' })
      resizeObserverCallback?.()
    })

    const inst = terminalState.instance as InstanceType<typeof MockTerminalClass>
    expect(inst?.write).toHaveBeenCalledWith('analysis output')
    expect(inst?.write).toHaveBeenCalledWith(
      expect.stringContaining('Analysis complete.'),
    )
    expect(window.agentCli.resizeAnalysisTerminal).toHaveBeenCalledTimes(2)

    unmount()

    expect(removeDataListener).toHaveBeenCalledTimes(1)
    expect(removeExitListener).toHaveBeenCalledTimes(1)
    expect(terminalState.inputDispose).toHaveBeenCalledTimes(1)
    expect(resizeObserverDisconnect).toHaveBeenCalledTimes(1)
    expect(inst?.dispose).toHaveBeenCalledTimes(1)
  })

  it('routes OSC hyperlinks through the Electron external-link bridge', () => {
    const openExternalLink = vi.fn().mockResolvedValue(undefined)

    window.agentCli = {
      onAnalysisTerminalData: vi.fn(() => vi.fn()),
      onAnalysisTerminalExit: vi.fn(() => vi.fn()),
      writeToAnalysisTerminal: vi.fn().mockResolvedValue(undefined),
      resizeAnalysisTerminal: vi.fn().mockResolvedValue(undefined),
      openExternalLink,
    } as unknown as typeof window.agentCli

    render(<AnalysisWindow />)

    const terminalOptions = terminalConstructorSpy.mock.calls[0]?.[0] as {
      linkHandler?: {
        activate: (event: MouseEvent, text: string) => void
      }
    }

    terminalOptions.linkHandler?.activate({} as MouseEvent, 'https://example.com')

    expect(openExternalLink).toHaveBeenCalledWith('https://example.com')
  })
})
