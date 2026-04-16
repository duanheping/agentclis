import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { MemoryBackendStatus } from '../src/shared/memorySearch'
import {
  MEMPALACE_READ_ONLY_MCP_SERVER_NAME,
  MEMPALACE_READ_ONLY_MCP_TOOLS,
} from './mempalaceReadOnlyMcp'

const DEFAULT_APPDATA_ROOT = process.env.APPDATA
  ? path.normalize(process.env.APPDATA)
  : path.join(os.homedir(), 'AppData', 'Roaming')
const MCP_CONFIG_ROOT = path.join('agentclis', 'copilot-mcp')
const MCP_CONFIG_FILE_NAME = 'mempalace.json'

export const COPILOT_MCP_SERVER_NAME = MEMPALACE_READ_ONLY_MCP_SERVER_NAME
export const COPILOT_MCP_READ_ONLY_TOOLS = MEMPALACE_READ_ONLY_MCP_TOOLS

export interface CopilotMcpConfigResult {
  created: boolean
  filePath: string
}

interface CopilotMcpConfigOptions {
  appDataRoot?: string
}

function getAppDataRoot(options?: CopilotMcpConfigOptions): string {
  return options?.appDataRoot?.trim()
    ? path.normalize(options.appDataRoot)
    : DEFAULT_APPDATA_ROOT
}

function normalizeCwd(cwd: string): string {
  return path.normalize(cwd.trim()).replace(/[\\/]+$/, '')
}

function buildCwdHash(cwd: string): string {
  return createHash('sha256').update(normalizeCwd(cwd)).digest('hex').slice(0, 16)
}

export function resolveCopilotMcpConfigPath(
  cwd: string,
  options?: CopilotMcpConfigOptions,
): string {
  const root = path.join(getAppDataRoot(options), MCP_CONFIG_ROOT, buildCwdHash(cwd))
  return path.join(root, MCP_CONFIG_FILE_NAME)
}

function buildCopilotMcpConfig(
  status: MemoryBackendStatus,
): Record<string, unknown> {
  if (status.installState !== 'installed' || !status.pythonPath?.trim()) {
    throw new Error('MemPalace runtime must be installed before writing Copilot MCP config.')
  }

  return {
    mcpServers: {
      [COPILOT_MCP_SERVER_NAME]: {
        type: 'local',
        command: status.pythonPath,
        args: ['-m', status.module, '--palace', status.palacePath],
        env: {},
        tools: [...COPILOT_MCP_READ_ONLY_TOOLS],
      },
    },
  }
}

export function injectCopilotMempalaceMcpConfig(
  cwd: string,
  status: MemoryBackendStatus,
  options?: CopilotMcpConfigOptions,
): CopilotMcpConfigResult {
  const filePath = resolveCopilotMcpConfigPath(cwd, options)
  const dirPath = path.dirname(filePath)
  const created = !fs.existsSync(filePath)
  const content = `${JSON.stringify(buildCopilotMcpConfig(status), null, 2)}\n`

  fs.mkdirSync(dirPath, { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')

  return { created, filePath }
}

export function removeCopilotMempalaceMcpConfig(
  cwd: string,
  options?: CopilotMcpConfigOptions,
): void {
  const filePath = resolveCopilotMcpConfigPath(cwd, options)
  const dirPath = path.dirname(filePath)

  try {
    fs.unlinkSync(filePath)
  } catch {
    return
  }

  try {
    fs.rmdirSync(dirPath)
  } catch {
    // best effort
  }
}
