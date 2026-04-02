import { describe, expect, it } from 'vitest'

import { attachInteractiveXtermScrollbar } from './xtermScrollbar'

function buildTerminalRoot(): HTMLDivElement {
  const root = document.createElement('div')
  root.innerHTML = `
    <div class="xterm">
      <div class="xterm-scrollable-element">
        <div class="scrollbar invisible fade"></div>
      </div>
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

    expect(scrollbar.style.pointerEvents).toBe('auto')
    expect(scrollbar.style.zIndex).toBe('11')

    dispose()
  })
})
