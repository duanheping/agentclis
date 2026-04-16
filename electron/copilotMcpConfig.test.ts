// @vitest-environment node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { MemoryBackendStatus } from '../src/shared/memorySearch'
import {
  COPILOT_MCP_READ_ONLY_TOOLS,
  COPILOT_MCP_SERVER_NAME,
  injectCopilotMempalaceMcpConfig,
  removeCopilotMempalaceMcpConfig,
  resolveCopilotMcpConfigPath,
} from './copilotMcpConfig'

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

function createTestRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-mcp-config-'))
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

describe('copilotMcpConfig', () => {
  it('writes a deterministic MemPalace MCP config with read-only tools', () => {
    const root = createTestRoot()
    const cwd = 'C:\\repo\\agentclis'
    const status = createStatus()

    const result = injectCopilotMempalaceMcpConfig(cwd, status, {
      appDataRoot: root,
    })

    expect(result.created).toBe(true)
    expect(result.filePath).toBe(resolveCopilotMcpConfigPath(cwd, { appDataRoot: root }))

    const content = fs.readFileSync(result.filePath, 'utf8')
    const parsed = JSON.parse(content) as {
      mcpServers: Record<string, {
        type: string
        command: string
        args: string[]
        env: Record<string, string>
        tools: string[]
      }>
    }

    expect(parsed.mcpServers[COPILOT_MCP_SERVER_NAME]).toEqual({
      type: 'local',
      command: status.pythonPath,
      args: ['-m', status.module, '--palace', status.palacePath],
      env: {},
      tools: [...COPILOT_MCP_READ_ONLY_TOOLS],
    })
  })

  it('removes the generated config file safely', () => {
    const root = createTestRoot()
    const cwd = 'C:\\repo\\agentclis'

    const result = injectCopilotMempalaceMcpConfig(cwd, createStatus(), {
      appDataRoot: root,
    })
    expect(fs.existsSync(result.filePath)).toBe(true)

    removeCopilotMempalaceMcpConfig(cwd, { appDataRoot: root })

    expect(fs.existsSync(result.filePath)).toBe(false)
  })
})
