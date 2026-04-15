const XTERM_SCROLLBAR_SELECTOR = '.xterm-scrollable-element > .scrollbar'
const PIXEL_SCROLL_LINE_FALLBACK = 18

interface ScrollableTerminal {
  rows: number
  scrollLines(amount: number): void
  buffer: {
    active: {
      type: 'normal' | 'alternate'
      baseY: number
    }
  }
}

function getInteractiveScrollbars(root: ParentNode): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(XTERM_SCROLLBAR_SELECTOR),
  )
}

function applyInteractiveScrollbarStyles(root: ParentNode): HTMLElement[] {
  const scrollbars = getInteractiveScrollbars(root)

  for (const scrollbar of scrollbars) {
    scrollbar.style.opacity = '1'
    scrollbar.style.pointerEvents = 'auto'
    scrollbar.style.zIndex = '11'
    scrollbar.style.background = 'rgba(0, 0, 0, 0)'
    scrollbar.style.transition = 'none'
  }

  return scrollbars
}

function isScrollableHistoryBuffer(
  terminal: ScrollableTerminal | undefined,
): terminal is ScrollableTerminal {
  return (
    terminal?.buffer.active.type === 'normal' &&
    terminal.buffer.active.baseY > 0
  )
}

function resolveWheelScrollLines(
  root: HTMLElement,
  terminal: ScrollableTerminal,
  event: WheelEvent,
  wheelPartialScroll: { current: number },
): number {
  let amount = event.deltaY

  if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
    const viewportHeight =
      root.querySelector<HTMLElement>('.xterm-viewport')?.clientHeight ?? 0
    const pixelsPerLine =
      viewportHeight > 0 && terminal.rows > 0
        ? viewportHeight / terminal.rows
        : PIXEL_SCROLL_LINE_FALLBACK

    amount /= pixelsPerLine

    if (Math.abs(event.deltaY) < 50) {
      amount *= 0.3
    }

    wheelPartialScroll.current += amount
    const wholeLines =
      Math.floor(Math.abs(wheelPartialScroll.current)) *
      (wheelPartialScroll.current > 0 ? 1 : -1)

    wheelPartialScroll.current %= 1
    return wholeLines
  }

  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    amount *= terminal.rows
  }

  return Math.trunc(amount)
}

export function attachInteractiveXtermScrollbar(
  root: HTMLElement,
  terminal?: ScrollableTerminal,
): () => void {
  const guardedScrollbars = new WeakSet<HTMLElement>()
  const detachScrollbarGuards: Array<() => void> = []
  const wheelPartialScroll = { current: 0 }

  const handleScrollbarPointerDown = (event: Event) => {
    // Let xterm's own scrollbar listeners run on the target, then stop the
    // gesture before terminal-level mouse tracking handlers can hijack it.
    event.stopPropagation()
  }

  const ensureInteractiveScrollbars = () => {
    const scrollbars = applyInteractiveScrollbarStyles(root)

    for (const scrollbar of scrollbars) {
      if (guardedScrollbars.has(scrollbar)) {
        continue
      }

      scrollbar.addEventListener('pointerdown', handleScrollbarPointerDown)
      scrollbar.addEventListener('mousedown', handleScrollbarPointerDown)
      guardedScrollbars.add(scrollbar)
      detachScrollbarGuards.push(() => {
        scrollbar.removeEventListener(
          'pointerdown',
          handleScrollbarPointerDown,
        )
        scrollbar.removeEventListener('mousedown', handleScrollbarPointerDown)
      })
    }
  }

  ensureInteractiveScrollbars()

  const observer = new MutationObserver(() => {
    ensureInteractiveScrollbars()
  })

  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  })

  const handleWheelCapture = (event: WheelEvent) => {
    if (
      event.defaultPrevented ||
      Math.abs(event.deltaY) <= Math.abs(event.deltaX) ||
      !isScrollableHistoryBuffer(terminal)
    ) {
      return
    }

    const scrollLines = resolveWheelScrollLines(
      root,
      terminal,
      event,
      wheelPartialScroll,
    )
    if (scrollLines === 0) {
      return
    }

    event.preventDefault()
    event.stopImmediatePropagation()
    terminal.scrollLines(scrollLines)
  }

  root.addEventListener('wheel', handleWheelCapture, {
    capture: true,
    passive: false,
  })

  return () => {
    observer.disconnect()
    for (const detachScrollbarGuard of detachScrollbarGuards) {
      detachScrollbarGuard()
    }
    root.removeEventListener('wheel', handleWheelCapture, true)
  }
}
