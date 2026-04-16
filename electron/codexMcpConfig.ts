import fs from 'node:fs'
import path from 'node:path'

import type { MemoryBackendStatus } from '../src/shared/memorySearch'
import {
  MEMPALACE_READ_ONLY_MCP_SERVER_NAME,
  MEMPALACE_READ_ONLY_MCP_TOOLS,
} from './mempalaceReadOnlyMcp'

const MARKER_START = '# agentclis-mempalace:start'
const MARKER_END = '# agentclis-mempalace:end'
const CONFIG_RELATIVE_PATH = path.join('.codex', 'config.toml')

function quoteTomlString(value: string): string {
  return JSON.stringify(value)
}

function buildMarkerBlock(status: MemoryBackendStatus): string {
  if (status.installState !== 'installed' || !status.pythonPath?.trim()) {
    throw new Error('MemPalace runtime must be installed before writing Codex MCP config.')
  }

  const args = ['-m', status.module, '--palace', status.palacePath]
    .map((value) => quoteTomlString(value))
    .join(', ')
  const enabledTools = [...MEMPALACE_READ_ONLY_MCP_TOOLS]
    .map((value) => quoteTomlString(value))
    .join(', ')

  return [
    MARKER_START,
    `[mcp_servers.${MEMPALACE_READ_ONLY_MCP_SERVER_NAME}]`,
    `command = ${quoteTomlString(status.pythonPath)}`,
    `args = [${args}]`,
    `enabled_tools = [${enabledTools}]`,
    'required = false',
    MARKER_END,
  ].join('\n')
}

function stripMarkerBlock(content: string): string {
  const startIndex = content.indexOf(MARKER_START)
  const endIndex = content.indexOf(MARKER_END)
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return content
  }

  const before = content.slice(0, startIndex)
  const after = content.slice(endIndex + MARKER_END.length)
  const trimmedBefore = before.replace(/\s+$/u, '')
  const trimmedAfter = after.replace(/^\s+/u, '')

  if (!trimmedBefore) return trimmedAfter
  if (!trimmedAfter) return trimmedBefore
  return `${trimmedBefore}\n\n${trimmedAfter}`
}

export interface InjectResult {
  created: boolean
}

export function injectCodexMcpConfig(
  cwd: string,
  status: MemoryBackendStatus,
): InjectResult {
  const filePath = path.join(cwd, CONFIG_RELATIVE_PATH)
  const dirPath = path.dirname(filePath)
  const block = buildMarkerBlock(status)

  let existing: string | null = null
  try {
    existing = fs.readFileSync(filePath, 'utf8')
  } catch {
    // file missing
  }

  if (existing === null) {
    fs.mkdirSync(dirPath, { recursive: true })
    fs.writeFileSync(filePath, `${block}\n`, 'utf8')
    return { created: true }
  }

  const withoutBlock = stripMarkerBlock(existing).trim()
  const nextContent = withoutBlock
    ? `${withoutBlock}\n\n${block}\n`
    : `${block}\n`
  fs.writeFileSync(filePath, nextContent, 'utf8')
  return { created: false }
}

export function removeCodexMcpConfig(
  cwd: string,
  created: boolean,
): void {
  const filePath = path.join(cwd, CONFIG_RELATIVE_PATH)

  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return
  }

  const cleaned = stripMarkerBlock(content)
  const hasUserContent = cleaned.trim().length > 0

  if (created && !hasUserContent) {
    try {
      fs.unlinkSync(filePath)
    } catch {
      // best effort
    }
    return
  }

  fs.writeFileSync(filePath, cleaned.endsWith('\n') ? cleaned : `${cleaned}\n`, 'utf8')
}
