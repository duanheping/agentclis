import { describe, expect, it, vi } from 'vitest'

import { attachInteractiveXtermScrollbar } from './xtermScrollbar'

function buildTerminalRoot(): HTMLDivElement {
  const root = document.createElement('div')
  root.innerHTML = `
    <div class="xterm">
      <div class="xterm-scrollable-element">
        <div class="scrollbar invisible fade"></div>
      </div>
      <div class="xterm-viewport"></div>
      <div class="xterm-screen"></div>
    </div>
  `

  return root
}

describe('attachInteractiveXtermScrollbar', () => {
  it('forces xterm overlay scrollbars to stay draggable', () => {
    const root = buildTerminalRoot()
    const dispose = attachInteractiveXtermScrollbar(root)
    const scrollbar = root.querySelector('.scrollbar') as HTMLDivElement | null

    expect(scrollbar).not.toBeNull()
    expect(scrollbar?.style.opacity).toBe('1')
    expect(scrollbar?.style.pointerEvents).toBe('auto')
    expect(scrollbar?.style.zIndex).toBe('11')
    expect(scrollbar?.style.background).toBe('rgba(0, 0, 0, 0)')
    expect(scrollbar?.style.transition).toBe('none')

    dispose()
  })

  it('keeps scrollbar-originated pointer gestures away from xterm mouse handlers', () => {
    const root = buildTerminalRoot()
    const xtermRoot = root.querySelector('.xterm') as HTMLDivElement
    const scrollbar = root.querySelector('.scrollbar') as HTMLDivElement
    const slider = document.createElement('div')
    const xtermMouseHandler = vi.fn()
    scrollbar.appendChild(slider)
    xtermRoot.addEventListener('mousedown', xtermMouseHandler)

    const dispose = attachInteractiveXtermScrollbar(root)

    slider.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
      }),
    )

    expect(xtermMouseHandler).not.toHaveBeenCalled()

    dispose()
  })

  it('scrolls normal-buffer history even when xterm would otherwise consume the wheel event', () => {
    const root = buildTerminalRoot()
    const viewport = root.querySelector('.xterm-viewport') as HTMLDivElement
    const screen = root.querySelector('.xterm-screen') as HTMLDivElement
    const scrollLines = vi.fn()
    const terminal = {
      rows: 24,
      scrollLines,
      buffer: {
        active: {
          type: 'normal',
          baseY: 10,
        },
      },
    } as Parameters<typeof attachInteractiveXtermScrollbar>[1]

    Object.defineProperty(viewport, 'clientHeight', {
      configurable: true,
      value: 360,
    })

    const dispose = attachInteractiveXtermScrollbar(root, terminal)

    screen.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY: -3,
      }),
    )

    expect(scrollLines).toHaveBeenCalledWith(-3)

    dispose()
  })

  it('styles scrollbars added after terminal initialization', async () => {
    const root = document.createElement('div')
    const dispose = attachInteractiveXtermScrollbar(root)
    const scrollable = document.createElement('div')
    scrollable.className = 'xterm-scrollable-element'
    const scrollbar = document.createElement('div')
    scrollbar.className = 'scrollbar invisible fade'

    scrollable.appendChild(scrollbar)
    root.appendChild(scrollable)

    await Promise.resolve()

    expect(scrollbar.style.opacity).toBe('1')
    expect(scrollbar.style.pointerEvents).toBe('auto')
    expect(scrollbar.style.zIndex).toBe('11')
    expect(scrollbar.style.background).toBe('rgba(0, 0, 0, 0)')
    expect(scrollbar.style.transition).toBe('none')

    dispose()
  })
})
