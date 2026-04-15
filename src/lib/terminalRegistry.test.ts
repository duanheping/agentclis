import { describe, expect, it, vi } from 'vitest'

import {
  buildWindowsCommandPromptTerminalId,
  terminalRegistry,
} from './terminalRegistry'

describe('buildWindowsCommandPromptTerminalId', () => {
  it('appends the windows-cmd suffix', () => {
    expect(buildWindowsCommandPromptTerminalId('abc-123')).toBe('abc-123:windows-cmd')
  })

  it('handles empty session id', () => {
    expect(buildWindowsCommandPromptTerminalId('')).toBe(':windows-cmd')
  })
})

describe('TerminalRegistry', () => {
  it('writes directly to a registered handle', () => {
    const write = vi.fn()
    const handle = { write, clear: vi.fn(), fit: vi.fn(), focus: vi.fn() }

    terminalRegistry.register('test-direct', handle)
    terminalRegistry.write('test-direct', 'hello')

    expect(write).toHaveBeenCalledWith('hello')
    terminalRegistry.forget('test-direct')
  })

  it('buffers output when no handle is registered', () => {
    const write = vi.fn()
    const handle = { write, clear: vi.fn(), fit: vi.fn(), focus: vi.fn() }

    terminalRegistry.write('test-buffer', 'chunk1')
    terminalRegistry.write('test-buffer', 'chunk2')
    terminalRegistry.register('test-buffer', handle)

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('chunk1chunk2')
    terminalRegistry.forget('test-buffer')
  })

  it('replays transcript history before buffered live output and removes overlap', () => {
    const write = vi.fn()
    const handle = { write, clear: vi.fn(), fit: vi.fn(), focus: vi.fn() }

    terminalRegistry.write('test-replay', 'chunk-2')
    terminalRegistry.write('test-replay', 'chunk-3')
    terminalRegistry.write('test-replay', 'chunk-4')
    terminalRegistry.register('test-replay', handle, [
      'chunk-0',
      'chunk-1',
      'chunk-2',
      'chunk-3',
    ])

    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenNthCalledWith(1, 'chunk-0chunk-1chunk-2chunk-3')
    expect(write).toHaveBeenNthCalledWith(2, 'chunk-4')
    terminalRegistry.forget('test-replay')
  })

  it('caps the buffer at 240 items using FIFO eviction', () => {
    const write = vi.fn()
    const handle = { write, clear: vi.fn(), fit: vi.fn(), focus: vi.fn() }

    for (let i = 0; i < 250; i++) {
      terminalRegistry.write('test-fifo', `chunk-${i}`)
    }

    terminalRegistry.register('test-fifo', handle)

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(
      Array.from({ length: 240 }, (_, index) => `chunk-${index + 10}`).join(''),
    )
    terminalRegistry.forget('test-fifo')
  })

  it('clears both handle and buffer', () => {
    const clear = vi.fn()
    const handle = { write: vi.fn(), clear, fit: vi.fn(), focus: vi.fn() }

    terminalRegistry.write('test-clear-buf', 'pre-register')
    terminalRegistry.register('test-clear-reg', handle)

    terminalRegistry.clear('test-clear-buf')
    terminalRegistry.clear('test-clear-reg')

    expect(clear).toHaveBeenCalledOnce()

    // After clearing the buffer, registering should replay nothing
    const write = vi.fn()
    terminalRegistry.register('test-clear-buf', { write, clear: vi.fn(), fit: vi.fn(), focus: vi.fn() })
    expect(write).not.toHaveBeenCalled()

    terminalRegistry.forget('test-clear-buf')
    terminalRegistry.forget('test-clear-reg')
  })

  it('delegates fit() and focus() to the registered handle', () => {
    const fit = vi.fn()
    const focus = vi.fn()
    const handle = { write: vi.fn(), clear: vi.fn(), fit, focus }

    terminalRegistry.register('test-ff', handle)
    terminalRegistry.fit('test-ff')
    terminalRegistry.focus('test-ff')

    expect(fit).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledOnce()
    terminalRegistry.forget('test-ff')
  })

  it('silently ignores fit/focus/clear on unknown ids', () => {
    expect(() => {
      terminalRegistry.fit('unknown')
      terminalRegistry.focus('unknown')
      terminalRegistry.clear('unknown')
    }).not.toThrow()
  })

  it('unregister removes the handle but preserves future buffering', () => {
    const write1 = vi.fn()
    const handle1 = { write: write1, clear: vi.fn(), fit: vi.fn(), focus: vi.fn() }

    terminalRegistry.register('test-unreg', handle1)
    terminalRegistry.unregister('test-unreg')
    terminalRegistry.write('test-unreg', 'after-unreg')

    expect(write1).not.toHaveBeenCalled()

    const write2 = vi.fn()
    terminalRegistry.register('test-unreg', { write: write2, clear: vi.fn(), fit: vi.fn(), focus: vi.fn() })
    expect(write2).toHaveBeenCalledWith('after-unreg')
    terminalRegistry.forget('test-unreg')
  })

  it('forget removes both handle and buffered data', () => {
    const write = vi.fn()

    terminalRegistry.write('test-forget', 'buffered')
    terminalRegistry.forget('test-forget')

    terminalRegistry.register('test-forget', { write, clear: vi.fn(), fit: vi.fn(), focus: vi.fn() })
    expect(write).not.toHaveBeenCalled()
    terminalRegistry.forget('test-forget')
  })
})
