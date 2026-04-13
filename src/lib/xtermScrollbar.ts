const XTERM_SCROLLBAR_SELECTOR = '.xterm-scrollable-element > .scrollbar'

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

function isXtermScrollbarTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false
  }

  const scrollbar = target.closest('.scrollbar')
  return scrollbar?.parentElement?.matches('.xterm-scrollable-element') ?? false
}

export function attachInteractiveXtermScrollbar(root: HTMLElement): () => void {
  applyInteractiveScrollbarStyles(root)

  const preventMouseProtocolHijack = (event: MouseEvent) => {
    // Mouse-tracking TUIs can consume terminal-level mousedown events and break
    // xterm's overlay scrollbar drag gesture unless the event is stopped here.
    if (isXtermScrollbarTarget(event.target)) {
      event.stopPropagation()
    }
  }

  root.addEventListener('mousedown', preventMouseProtocolHijack, true)

  const observer = new MutationObserver(() => {
    applyInteractiveScrollbarStyles(root)
  })

  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  })

  return () => {
    root.removeEventListener('mousedown', preventMouseProtocolHijack, true)
    observer.disconnect()
  }
}
