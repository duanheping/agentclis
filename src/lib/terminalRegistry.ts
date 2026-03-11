interface TerminalHandle {
  write: (chunk: string) => void
  clear: () => void
  fit: () => void
  focus: () => void
}

class TerminalRegistry {
  private readonly handles = new Map<string, TerminalHandle>()
  private readonly bufferedOutput = new Map<string, string[]>()

  register(id: string, handle: TerminalHandle): void {
    this.handles.set(id, handle)

    const pendingChunks = this.bufferedOutput.get(id)
    if (!pendingChunks?.length) {
      return
    }

    for (const chunk of pendingChunks) {
      handle.write(chunk)
    }

    this.bufferedOutput.delete(id)
  }

  unregister(id: string): void {
    this.handles.delete(id)
  }

  write(id: string, chunk: string): void {
    const handle = this.handles.get(id)
    if (handle) {
      handle.write(chunk)
      return
    }

    const pendingChunks = this.bufferedOutput.get(id) ?? []
    pendingChunks.push(chunk)

    if (pendingChunks.length > 240) {
      pendingChunks.shift()
    }

    this.bufferedOutput.set(id, pendingChunks)
  }

  clear(id: string): void {
    this.bufferedOutput.delete(id)
    this.handles.get(id)?.clear()
  }

  fit(id: string): void {
    this.handles.get(id)?.fit()
  }

  focus(id: string): void {
    this.handles.get(id)?.focus()
  }

  forget(id: string): void {
    this.bufferedOutput.delete(id)
    this.handles.delete(id)
  }
}

export const terminalRegistry = new TerminalRegistry()
