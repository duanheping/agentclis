import { useEffect, useRef } from 'react'

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'

import '../App.css'

const SCROLLBACK_LINES = 50_000

export function AnalysisWindow() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const agentCli = window.agentCli
    if (!containerRef.current || !agentCli) {
      return
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: SCROLLBACK_LINES,
      allowTransparency: true,
      windowsPty: { backend: 'conpty' },
      theme: {
        background: '#161616',
        foreground: '#e8e8ea',
        cursor: '#dbc29d',
        scrollbarSliderBackground: 'rgba(227, 211, 182, 0.22)',
        scrollbarSliderHoverBackground: 'rgba(227, 211, 182, 0.38)',
        scrollbarSliderActiveBackground: 'rgba(227, 211, 182, 0.48)',
        black: '#202020',
        brightBlack: '#6d6d72',
        red: '#ff7f7f',
        brightRed: '#ffaaaa',
        green: '#78d48f',
        brightGreen: '#a6e3b5',
        yellow: '#d8bf91',
        brightYellow: '#f0dfbe',
        blue: '#87a5d6',
        brightBlue: '#adc2e7',
        magenta: '#c6add8',
        brightMagenta: '#e0c7ef',
        cyan: '#8ab3af',
        brightCyan: '#acd0cc',
        white: '#d4d4d8',
        brightWhite: '#fafafb',
      },
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    terminalRef.current = terminal

    const fitTerminal = () => {
      fitAddon.fit()
      void agentCli.resizeAnalysisTerminal(terminal.cols, terminal.rows)
    }

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(fitTerminal)
    })
    resizeObserver.observe(containerRef.current)

    const inputDisposable = terminal.onData((data) => {
      void agentCli.writeToAnalysisTerminal(data)
    })

    const removeDataListener = agentCli.onAnalysisTerminalData(({ chunk }) => {
      terminal.write(chunk)
    })

    const removeExitListener = agentCli.onAnalysisTerminalExit(({ message }) => {
      terminal.write(`\r\n\x1b[90m${message}\x1b[0m\r\n`)
    })

    requestAnimationFrame(fitTerminal)
    terminal.focus()

    return () => {
      removeDataListener()
      removeExitListener()
      inputDisposable.dispose()
      resizeObserver.disconnect()
      terminal.dispose()
      terminalRef.current = null
    }
  }, [])

  return (
    <div className="analysis-window">
      <div className="analysis-window__header">
        <span className="analysis-window__title">Project Memory Analysis</span>
      </div>
      <div ref={containerRef} className="analysis-window__terminal" />
    </div>
  )
}
