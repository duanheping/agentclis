// @vitest-environment node

import { EventEmitter } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  type MockChild = EventEmitter & {
    pid: number
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: {
      write: ReturnType<typeof vi.fn>
      end: ReturnType<typeof vi.fn>
    }
    kill: ReturnType<typeof vi.fn>
  }

  const children: MockChild[] = []
  const spawn = vi.fn(() => {
    const child = new EventEmitter() as MockChild
    child.pid = 4321
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = {
      write: vi.fn(),
      end: vi.fn(),
    }
    child.kill = vi.fn()
    children.push(child)
    return child
  })
  const spawnSync = vi.fn(() => ({
    error: undefined,
    status: 0,
  }))

  return {
    children,
    spawn,
    spawnSync,
    reset: () => {
      children.length = 0
      spawn.mockClear()
      spawnSync.mockClear()
    },
  }
})

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  spawnSync: mocks.spawnSync,
}))

import {
  abortStructuredAgentProcesses,
  cleanupStructuredAgentTemp,
  prepareStructuredAgent,
  runStructuredAgent,
} from './structuredAgentRunner'

async function resolveCopilotPromptPath(
  spawnCall: [string, string[], { cwd?: string }],
): Promise<string> {
  if (process.platform === 'win32') {
    const scriptPath = spawnCall[1][3]
    const script = await readFile(scriptPath, 'utf8')
    const match = script.match(
      /Read and follow all instructions in the file at (.+?copilot-prompt\.txt)/u,
    )
    if (!match) {
      throw new Error('Could not resolve Copilot prompt path from the generated script.')
    }
    return match[1]
  }

  const promptIndex = spawnCall[1].indexOf('--prompt')
  const promptArg = promptIndex >= 0 ? spawnCall[1][promptIndex + 1] : null
  const match = promptArg?.match(
    /Read and follow all instructions in the file at (.+?copilot-prompt\.txt)/u,
  )
  if (!match) {
    throw new Error('Could not resolve Copilot prompt path from the spawn arguments.')
  }
  return match[1]
}

async function resolveCodexOutputPath(
  spawnCall: [string, string[], { cwd?: string }],
): Promise<string> {
  if (process.platform === 'win32') {
    const scriptPath = spawnCall[1][3]
    const script = await readFile(scriptPath, 'utf8')
    const match = script.match(/--output-last-message\s+("?)(.+?response\.json)\1(?:\s|$)/u)
    if (!match) {
      throw new Error('Could not resolve Codex output path from the generated script.')
    }
    return match[2]
  }

  const outputIndex = spawnCall[1].indexOf('--output-last-message')
  const outputPath = outputIndex >= 0 ? spawnCall[1][outputIndex + 1] : null
  if (!outputPath) {
    throw new Error('Could not resolve Codex output path from the spawn arguments.')
  }
  return outputPath
}

describe('structuredAgentRunner shutdown handling', () => {
  afterEach(() => {
    mocks.reset()
  })

  it('aborts active structured-agent child processes during shutdown', async () => {
    const promise = runStructuredAgent({
      agent: 'copilot',
      schema: '{"type":"object"}',
      prompt: 'Return JSON.',
      contextDirectories: [],
    })

    await vi.waitFor(() => {
      expect(mocks.spawn).toHaveBeenCalledTimes(1)
    })

    abortStructuredAgentProcesses()

    if (process.platform === 'win32') {
      expect(mocks.spawnSync).toHaveBeenCalledWith(
        'taskkill.exe',
        ['/PID', '4321', '/T', '/F'],
        expect.objectContaining({
          stdio: 'ignore',
          windowsHide: true,
        }),
      )
      expect(mocks.children[0]?.kill).not.toHaveBeenCalled()
    } else {
      expect(mocks.children[0]?.kill).toHaveBeenCalledTimes(1)
    }

    mocks.children[0]?.emit('close', 1)

    await expect(promise).rejects.toThrow(/copilot exited with code 1/i)
  })

  it('runs copilot structured jobs from the first context directory and uses prompt-file mode', async () => {
    const contextDirectory = process.cwd()
    const promise = runStructuredAgent({
      agent: 'copilot',
      schema: '{"type":"object","properties":{"status":{"type":"string"}}}',
      prompt: 'Summarize the repository.',
      contextDirectories: [contextDirectory],
    })

    await vi.waitFor(() => {
      expect(mocks.spawn).toHaveBeenCalledTimes(1)
    })

    const spawnCall = mocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd?: string },
    ]
    expect(spawnCall[2]).toEqual(
      expect.objectContaining({
        cwd: contextDirectory,
      }),
    )
    const promptPath = await resolveCopilotPromptPath(spawnCall)
    await expect(readFile(promptPath, 'utf8')).resolves.toContain(
      'Write your complete JSON response to the file:',
    )

    if (process.platform === 'win32') {
      const scriptPath = spawnCall[1][3]
      const script = await readFile(scriptPath, 'utf8')
      expect(script).toContain('copilot --allow-all --no-ask-user --no-custom-instructions')
      expect(script).toContain('--output-format json')
      expect(script).toContain('--stream off')
      expect(script).toContain('--silent')
      expect(script).toContain('Read and follow all instructions in the file at')
    } else {
      expect(spawnCall[1]).toEqual(
        expect.arrayContaining([
          '--allow-all',
          '--no-ask-user',
          '--no-custom-instructions',
          '--output-format',
          'json',
          '--stream',
          'off',
          '--silent',
        ]),
      )
    }

    mocks.children[0]?.emit('close', 1)
    await expect(promise).rejects.toThrow(/copilot exited with code 1/i)
  })

  it('extracts the final assistant message from copilot json output', async () => {
    const contextDirectory = process.cwd()
    const promise = runStructuredAgent({
      agent: 'copilot',
      schema: '{"type":"object","properties":{"status":{"type":"string"}}}',
      prompt: 'Summarize the repository.',
      contextDirectories: [contextDirectory],
    })

    await vi.waitFor(() => {
      expect(mocks.spawn).toHaveBeenCalledTimes(1)
    })

    mocks.children[0]?.stdout.emit(
      'data',
      Buffer.from(
        [
          JSON.stringify({
            type: 'assistant.message',
            data: {
              content: 'working',
            },
          }),
          JSON.stringify({
            type: 'assistant.message',
            data: {
              content: '{"status":"ok"}',
              phase: 'final_answer',
            },
          }),
        ].join('\n'),
      ),
    )
    mocks.children[0]?.emit('close', 0)

    await expect(promise).resolves.toBe('{"status":"ok"}')
  })

  it('prefers structured Codex stdout when the saved last message is plain-text chatter', async () => {
    const promise = runStructuredAgent({
      agent: 'codex',
      schema: '{"type":"object","properties":{"status":{"type":"string"}}}',
      prompt: 'Summarize the repository.',
      contextDirectories: [],
    })

    await vi.waitFor(() => {
      expect(mocks.spawn).toHaveBeenCalledTimes(1)
    })

    const spawnCall = mocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd?: string },
    ]
    const outputPath = await resolveCodexOutputPath(spawnCall)
    await writeFile(outputPath, 'Done - I wrote the JSON.\n', 'utf8')

    mocks.children[0]?.stdout.emit('data', Buffer.from('{"status":"from-stdout"}'))
    mocks.children[0]?.emit('close', 0)

    await expect(promise).resolves.toBe('{"status":"from-stdout"}')
  })

  it('falls back to the prompt-directed response file when no final copilot message is emitted', async () => {
    const contextDirectory = process.cwd()
    const promise = runStructuredAgent({
      agent: 'copilot',
      schema: '{"type":"object","properties":{"status":{"type":"string"}}}',
      prompt: 'Summarize the repository.',
      contextDirectories: [contextDirectory],
    })

    await vi.waitFor(() => {
      expect(mocks.spawn).toHaveBeenCalledTimes(1)
    })

    const spawnCall = mocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd?: string },
    ]
    const promptPath = await resolveCopilotPromptPath(spawnCall)
    const outputPath = path.join(path.dirname(promptPath), 'response.json')
    await writeFile(outputPath, '{"status":"from-file"}\n', 'utf8')

    mocks.children[0]?.stdout.emit('data', Buffer.from('not-json-event'))
    mocks.children[0]?.emit('close', 0)

    await expect(promise).resolves.toBe('{"status":"from-file"}')
  })

  it('prefers the prompt-directed response file over non-final copilot assistant chatter', async () => {
    const contextDirectory = process.cwd()
    const promise = runStructuredAgent({
      agent: 'copilot',
      schema: '{"type":"object","properties":{"status":{"type":"string"}}}',
      prompt: 'Summarize the repository.',
      contextDirectories: [contextDirectory],
    })

    await vi.waitFor(() => {
      expect(mocks.spawn).toHaveBeenCalledTimes(1)
    })

    const spawnCall = mocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd?: string },
    ]
    const promptPath = await resolveCopilotPromptPath(spawnCall)
    const outputPath = path.join(path.dirname(promptPath), 'response.json')
    await writeFile(outputPath, '{"status":"from-file"}\n', 'utf8')

    mocks.children[0]?.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'assistant.message',
          data: {
            content: 'working',
          },
        }),
      ),
    )
    mocks.children[0]?.emit('close', 0)

    await expect(promise).resolves.toBe('{"status":"from-file"}')
  })

  it('anchors prepared copilot analysis scripts in the first context directory', async () => {
    const contextDirectory = process.cwd()
    const prepared = await prepareStructuredAgent({
      agent: 'copilot',
      schema: '{"type":"object"}',
      prompt: 'Summarize the repository.',
      contextDirectories: [contextDirectory],
    })

    expect(prepared.cwd).toBe(contextDirectory)

    await cleanupStructuredAgentTemp(prepared.tempRoot)
  })
})
