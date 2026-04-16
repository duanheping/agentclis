// @vitest-environment node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { MemoryBackendStatus } from '../src/shared/memorySearch'
import {
  injectCodexMcpConfig,
  removeCodexMcpConfig,
} from './codexMcpConfig'
import {
  MEMPALACE_READ_ONLY_MCP_SERVER_NAME,
  MEMPALACE_READ_ONLY_MCP_TOOLS,
} from './mempalaceReadOnlyMcp'

function createStatus(): MemoryBackendStatus {
  return {
    backend: 'mempalace',
    repo: 'https://github.com/duanheping/mempalace.git',
    commit: '74e5bf6090cb239b1b48b5a015670842a99a2c8c',
    installState: 'installed',
    runtimeState: 'running',
    installRoot: 'C:\\Users\\hduan10\\AppData\\Roaming\\agentclis\\tools\\mempalace\\74e5bf6090cb239b1b48b5a015670842a99a2c8c',
    palacePath: 'C:\\Users\\hduan10\\AppData\\Roaming\\agentclis\\mempalace\\palace',
    pythonPath: 'C:\\Users\\hduan10\\AppData\\Roaming\\agentclis\\tools\\mempalace\\74e5bf6090cb239b1b48b5a015670842a99a2c8c\\venv\\Scripts\\python.exe',
    module: 'mempalace.mcp_server',
    message: null,
    lastError: null,
  }
}

const tmpDirs: string[] = []

function createTestDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mcp-config-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
  tmpDirs.length = 0
})

describe('codexMcpConfig', () => {
  it('creates a project-scoped .codex/config.toml with a MemPalace server block', () => {
    const cwd = createTestDir()

    const result = injectCodexMcpConfig(cwd, createStatus())

    expect(result.created).toBe(true)
    const content = fs.readFileSync(path.join(cwd, '.codex', 'config.toml'), 'utf8')
    expect(content).toContain(`[mcp_servers.${MEMPALACE_READ_ONLY_MCP_SERVER_NAME}]`)
    expect(content).toContain('command = "C:\\\\Users\\\\hduan10')
    expect(content).toContain(`enabled_tools = [${MEMPALACE_READ_ONLY_MCP_TOOLS.map((tool) => JSON.stringify(tool)).join(', ')}]`)
  })

  it('strips only the managed block on cleanup when the config has user content', () => {
    const cwd = createTestDir()
    const configPath = path.join(cwd, '.codex', 'config.toml')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, 'model = "gpt-5.4"\n', 'utf8')

    injectCodexMcpConfig(cwd, createStatus())
    removeCodexMcpConfig(cwd, false)

    expect(fs.readFileSync(configPath, 'utf8')).toBe('model = "gpt-5.4"\n')
  })
})
