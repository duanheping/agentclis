import fs from 'node:fs'
import path from 'node:path'

const MARKER_START = '<!-- agentclis-project-memory:start -->'
const MARKER_END = '<!-- agentclis-project-memory:end -->'

const INSTRUCTIONS_REL = 'AGENTS.md'

function buildMarkerBlock(memoryText: string): string {
  return `${MARKER_START}\n${memoryText}\n${MARKER_END}`
}

function stripMarkerBlock(content: string): string {
  const startIndex = content.indexOf(MARKER_START)
  const endIndex = content.indexOf(MARKER_END)
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return content
  }

  const before = content.slice(0, startIndex)
  const after = content.slice(endIndex + MARKER_END.length)

  const trimmedBefore = before.replace(/\n+$/, '')
  const trimmedAfter = after.replace(/^\n+/, '')

  if (!trimmedBefore) return trimmedAfter
  if (!trimmedAfter) return trimmedBefore
  return `${trimmedBefore}\n\n${trimmedAfter}`
}

export interface InjectResult {
  /** true if we created the file from scratch (vs. modified an existing one) */
  created: boolean
}

/**
 * Inject project memory into `AGENTS.md` at the given CWD.
 *
 * Codex CLI reads AGENTS.md automatically for project instructions.
 * This avoids the Windows CreateProcess 32 767-character command-line limit
 * that was hit when memory was passed via `-c developer_instructions=<text>`.
 *
 * - If the file doesn't exist: creates it with the fenced block.
 * - If the file exists but has no markers: prepends the fenced block.
 * - If the file exists with markers: replaces the existing fenced block.
 */
export function injectCodexInstructions(
  cwd: string,
  memoryText: string,
): InjectResult {
  const filePath = path.join(cwd, INSTRUCTIONS_REL)
  const block = buildMarkerBlock(memoryText)

  let existing: string | null = null
  try {
    existing = fs.readFileSync(filePath, 'utf8')
  } catch {
    // File doesn't exist
  }

  if (existing === null) {
    fs.writeFileSync(filePath, block + '\n', 'utf8')
    return { created: true }
  }

  if (existing.includes(MARKER_START)) {
    const updated = stripMarkerBlock(existing)
    const newContent = updated
      ? `${block}\n\n${updated}\n`
      : `${block}\n`
    fs.writeFileSync(filePath, newContent, 'utf8')
  } else {
    const trimmed = existing.trim()
    const newContent = trimmed
      ? `${block}\n\n${trimmed}\n`
      : `${block}\n`
    fs.writeFileSync(filePath, newContent, 'utf8')
  }

  return { created: false }
}

/**
 * Remove injected project memory from `AGENTS.md` at the given CWD.
 *
 * - If we created the file and it only contains our markers: deletes the file.
 * - If the file has user content outside the markers: strips the marker block only.
 */
export function removeCodexInstructions(
  cwd: string,
  created: boolean,
): void {
  const filePath = path.join(cwd, INSTRUCTIONS_REL)

  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return // File already gone
  }

  const cleaned = stripMarkerBlock(content)
  const hasUserContent = cleaned.trim().length > 0

  if (created && !hasUserContent) {
    try {
      fs.unlinkSync(filePath)
    } catch {
      // File may already be gone
    }
    return
  }

  // Either we modified an existing file, or the user added content after
  // we created it — strip markers only, preserve user content
  fs.writeFileSync(filePath, cleaned.endsWith('\n') ? cleaned : cleaned + '\n', 'utf8')
}
