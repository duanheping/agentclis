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

export function attachInteractiveXtermScrollbar(root: HTMLElement): () => void {
  applyInteractiveScrollbarStyles(root)

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
    observer.disconnect()
  }
}
