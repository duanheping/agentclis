// @vitest-environment node

import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { MempalaceRuntime } from './mempalaceRuntime'

type SpawnCall = {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: {
    write: (value: string) => void
    end: () => void
  }
  kill: () => boolean
  pid: number
}

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = {
    write: () => undefined,
    end: () => undefined,
  }
  child.kill = () => {
    queueMicrotask(() => {
      child.emit('close', 0, 'SIGTERM')
    })
    return true
  }
  child.pid = Math.floor(Math.random() * 10000) + 1000
  return child
}

function createSpawnMock(options: {
  tempRoot: string
  runtimeStartMode?: 'run' | 'error'
}) {
  const calls: SpawnCall[] = []
  const spawnImpl = vi.fn((command: string, args: string[], spawnOptions?: {
    cwd?: string
    env?: NodeJS.ProcessEnv
  }) => {
    const child = createMockChildProcess()
    calls.push({
      command,
      args: [...args],
      cwd: spawnOptions?.cwd,
      env: spawnOptions?.env,
    })

    queueMicrotask(async () => {
      child.emit('spawn')

      if (args.includes('-c')) {
        child.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              version: '3.11.9',
              executable: 'C:\\Python311\\python.exe',
            }),
            'utf8',
          ),
        )
        child.emit('close', 0, null)
        return
      }

      const moduleFlagIndex = args.indexOf('-m')
      const moduleName = moduleFlagIndex >= 0 ? args[moduleFlagIndex + 1] : null

      if (moduleName === 'venv') {
        const venvRoot = args[moduleFlagIndex + 2]
        if (typeof venvRoot === 'string') {
          const pythonPath = path.join(venvRoot, 'Scripts', 'python.exe')
          await mkdir(path.dirname(pythonPath), { recursive: true })
          await writeFile(pythonPath, '', 'utf8')
        }
        child.emit('close', 0, null)
        return
      }

      if (moduleName === 'pip') {
        child.emit('close', 0, null)
        return
      }

      if (moduleName === 'mempalace.mcp_server') {
        if (options.runtimeStartMode === 'error') {
          child.stderr.emit('data', Buffer.from('runtime failed', 'utf8'))
          child.emit('close', 1, null)
          return
        }

        await writeFile(
          path.join(options.tempRoot, 'runtime-started.txt'),
          'started\n',
          'utf8',
        )
        return
      }

      child.stderr.emit(
        'data',
        Buffer.from(`unexpected command: ${command} ${args.join(' ')}`, 'utf8'),
      )
      child.emit('close', 1, null)
    })

    return child
  })

  return { spawnImpl, calls }
}

async function writeManifest(tempRoot: string): Promise<string> {
  const manifestPath = path.join(tempRoot, 'mempalace.json')
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      repo: 'https://github.com/duanheping/mempalace.git',
      commit: '74e5bf6090cb239b1b48b5a015670842a99a2c8c',
      python: '>=3.9',
      module: 'mempalace.mcp_server',
      installRoot: '%APPDATA%\\agentclis\\tools\\mempalace\\<commit>\\',
      palaceRoot: '%APPDATA%\\agentclis\\mempalace\\palace\\',
    }, null, 2)}\n`,
    'utf8',
  )
  return manifestPath
}

const tempRoots: string[] = []

async function createRuntime(options?: {
  runtimeStartMode?: 'run' | 'error'
}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agentclis-mempalace-'))
  tempRoots.push(tempRoot)

  const manifestPath = await writeManifest(tempRoot)
  const { spawnImpl, calls } = createSpawnMock({
    tempRoot,
    runtimeStartMode: options?.runtimeStartMode,
  })

  return {
    tempRoot,
    calls,
    runtime: new MempalaceRuntime({
      manifestPath,
      appDataRoot: path.join(tempRoot, 'AppData', 'Roaming'),
      platform: 'win32',
      spawn: spawnImpl as unknown as typeof import('node:child_process').spawn,
    }),
  }
}

describe('MempalaceRuntime', () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map(async (tempRoot) => {
        await rm(tempRoot, { recursive: true, force: true })
      }),
    )
  })

  it('reports not-installed status from the pinned manifest', async () => {
    const { runtime } = await createRuntime()

    const status = await runtime.getStatus()

    expect(status.backend).toBe('mempalace')
    expect(status.installState).toBe('not-installed')
    expect(status.runtimeState).toBe('stopped')
    expect(status.installRoot).toContain('74e5bf6090cb239b1b48b5a015670842a99a2c8c')
    expect(status.pythonPath).toBe('C:\\Python311\\python.exe')
  })

  it('installs the pinned runtime and writes install metadata', async () => {
    const { runtime, tempRoot, calls } = await createRuntime()

    const result = await runtime.installRuntime()

    expect(result.success).toBe(true)
    expect(result.status.installState).toBe('installed')
    expect(calls.map((call) => `${call.command} ${call.args.join(' ')}`)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('py -3 -c'),
        expect.stringContaining('-m venv'),
        expect.stringContaining('-m pip install --upgrade pip setuptools wheel hatchling'),
        expect.stringContaining(
          '-m pip install --no-build-isolation git+https://github.com/duanheping/mempalace.git@74e5bf6090cb239b1b48b5a015670842a99a2c8c',
        ),
      ]),
    )
    const pipCalls = calls.filter(
      (call) => call.args.includes('-m') && call.args.includes('pip'),
    )
    expect(pipCalls).toHaveLength(2)
    for (const call of pipCalls) {
      expect(call.env?.PIP_CONFIG_FILE).toMatch(/nul$/iu)
      expect(call.env?.PIP_INDEX_URL).toBe('https://pypi.org/simple')
      expect(call.env?.PIP_DISABLE_PIP_VERSION_CHECK).toBe('1')
    }

    const metadataPath = path.join(
      tempRoot,
      'AppData',
      'Roaming',
      'agentclis',
      'tools',
      'mempalace',
      '74e5bf6090cb239b1b48b5a015670842a99a2c8c',
      'agentclis-mempalace-runtime.json',
    )
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      commit: string
      repo: string
      module: string
    }
    expect(metadata).toEqual(
      expect.objectContaining({
        commit: '74e5bf6090cb239b1b48b5a015670842a99a2c8c',
        repo: 'https://github.com/duanheping/mempalace.git',
        module: 'mempalace.mcp_server',
      }),
    )
  })

  it('starts and stops the runtime process after install', async () => {
    const { runtime } = await createRuntime()
    await runtime.installRuntime()

    await runtime.start()

    expect((await runtime.getStatus()).runtimeState).toBe('running')

    runtime.stop()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect((await runtime.getStatus()).runtimeState).toBe('stopped')
  })

  it('marks the runtime as failed when startup exits immediately', async () => {
    const { runtime } = await createRuntime({ runtimeStartMode: 'error' })
    await runtime.installRuntime()

    await expect(runtime.start()).rejects.toThrow(/runtime failed|exited unexpectedly/u)

    const status = await runtime.getStatus()
    expect(status.runtimeState).toBe('failed')
    expect(status.lastError).toMatch(/runtime failed|exited unexpectedly/u)
  })
})
