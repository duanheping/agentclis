import fs from 'node:fs'
import path from 'node:path'

const MARKER_START = '<!-- agentclis-project-memory:start -->'
const MARKER_END = '<!-- agentclis-project-memory:end -->'

const INSTRUCTIONS_REL = path.join('.github', 'copilot-instructions.md')

/**
 * Build the fenced memory block that we inject into the instructions file.
 */
function buildMarkerBlock(memoryText: string): string {
  return `${MARKER_START}\n${memoryText}\n${MARKER_END}`
}

/**
 * Strip a previously-injected marker block from file content.
 * Returns the remaining content with the block (and surrounding blank lines) removed.
 */
function stripMarkerBlock(content: string): string {
  const startIndex = content.indexOf(MARKER_START)
  const endIndex = content.indexOf(MARKER_END)
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return content
  }

  const before = content.slice(0, startIndex)
  const after = content.slice(endIndex + MARKER_END.length)

  // Trim trailing blank lines from `before` and leading blank lines from `after`,
  // then join with a single newline to avoid leaving gaps.
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
 * Inject project memory into `.github/copilot-instructions.md` at the given CWD.
 *
 * - If the file doesn't exist: creates `.github/` dir + file with the fenced block.
 * - If the file exists but has no markers: prepends the fenced block.
 * - If the file exists with markers: replaces the existing fenced block.
 */
export function injectCopilotInstructions(
  cwd: string,
  memoryText: string,
): InjectResult {
  const filePath = path.join(cwd, INSTRUCTIONS_REL)
  const dirPath = path.dirname(filePath)
  const block = buildMarkerBlock(memoryText)

  let existing: string | null = null
  try {
    existing = fs.readFileSync(filePath, 'utf8')
  } catch {
    // File doesn't exist
  }

  if (existing === null) {
    fs.mkdirSync(dirPath, { recursive: true })
    fs.writeFileSync(filePath, block + '\n', 'utf8')
    return { created: true }
  }

  // File exists — check for existing markers
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
 * Remove injected project memory from `.github/copilot-instructions.md` at the given CWD.
 *
 * - If we created the file and it only contains our markers: deletes the file.
 * - If the file has user content outside the markers: strips the marker block only.
 */
export function removeCopilotInstructions(
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
    // We created the file and no user content was added — safe to delete
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
