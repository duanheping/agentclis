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

function applyInteractiveScrollbarStyles(root: ParentNode): void {
  const scrollbars = root.querySelectorAll<HTMLElement>(XTERM_SCROLLBAR_SELECTOR)

  for (const scrollbar of scrollbars) {
    scrollbar.style.opacity = '1'
    scrollbar.style.pointerEvents = 'auto'
    scrollbar.style.zIndex = '11'
    scrollbar.style.background = 'rgba(0, 0, 0, 0)'
    scrollbar.style.transition = 'none'
  }
}

function isScrollbarTarget(root: HTMLElement, target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    root.contains(target) &&
    target.closest(XTERM_SCROLLBAR_SELECTOR) !== null
  )
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
  applyInteractiveScrollbarStyles(root)
  const wheelPartialScroll = { current: 0 }

  const observer = new MutationObserver(() => {
    applyInteractiveScrollbarStyles(root)
  })

  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  })

  const handleScrollbarPointerDownCapture = (event: Event) => {
    if (!isScrollbarTarget(root, event.target)) {
      return
    }

    event.stopImmediatePropagation()
  }

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

  root.addEventListener(
    'pointerdown',
    handleScrollbarPointerDownCapture,
    true,
  )
  root.addEventListener(
    'mousedown',
    handleScrollbarPointerDownCapture,
    true,
  )
  root.addEventListener('wheel', handleWheelCapture, {
    capture: true,
    passive: false,
  })

  return () => {
    observer.disconnect()
    root.removeEventListener(
      'pointerdown',
      handleScrollbarPointerDownCapture,
      true,
    )
    root.removeEventListener(
      'mousedown',
      handleScrollbarPointerDownCapture,
      true,
    )
    root.removeEventListener('wheel', handleWheelCapture, true)
  }
}
