// @vitest-environment node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  injectCopilotInstructions,
  removeCopilotInstructions,
} from './copilotInstructions'

const MARKER_START = '<!-- agentclis-project-memory:start -->'
const MARKER_END = '<!-- agentclis-project-memory:end -->'

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-instr-test-'))
}

const tmpDirs: string[] = []

function createTestDir(): string {
  const dir = makeTmpDir()
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
  tmpDirs.length = 0
})

function readInstructions(cwd: string): string {
  return fs.readFileSync(
    path.join(cwd, '.github', 'copilot-instructions.md'),
    'utf8',
  )
}

describe('copilotInstructions', () => {
  describe('injectCopilotInstructions', () => {
    it('creates .github/ and instructions file when nothing exists', () => {
      const cwd = createTestDir()

      const result = injectCopilotInstructions(cwd, 'Project uses TypeScript.')

      expect(result.created).toBe(true)
      const content = readInstructions(cwd)
      expect(content).toContain(MARKER_START)
      expect(content).toContain('Project uses TypeScript.')
      expect(content).toContain(MARKER_END)
    })

    it('creates file when .github/ exists but no instructions file', () => {
      const cwd = createTestDir()
      fs.mkdirSync(path.join(cwd, '.github'), { recursive: true })

      const result = injectCopilotInstructions(cwd, 'Memory text.')

      expect(result.created).toBe(true)
      expect(readInstructions(cwd)).toContain('Memory text.')
    })

    it('prepends to existing file while preserving user content', () => {
      const cwd = createTestDir()
      const filePath = path.join(cwd, '.github', 'copilot-instructions.md')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, 'Always use single quotes.\n', 'utf8')

      const result = injectCopilotInstructions(cwd, 'Project memory.')

      expect(result.created).toBe(false)
      const content = readInstructions(cwd)
      expect(content).toContain(MARKER_START)
      expect(content).toContain('Project memory.')
      expect(content).toContain(MARKER_END)
      expect(content).toContain('Always use single quotes.')
      // Memory block comes before user content
      expect(content.indexOf(MARKER_START)).toBeLessThan(
        content.indexOf('Always use single quotes.'),
      )
    })

    it('replaces existing marker block on re-inject', () => {
      const cwd = createTestDir()
      const filePath = path.join(cwd, '.github', 'copilot-instructions.md')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })

      // First inject
      injectCopilotInstructions(cwd, 'Version 1 memory.')
      expect(readInstructions(cwd)).toContain('Version 1 memory.')

      // Second inject with different memory
      const result = injectCopilotInstructions(cwd, 'Version 2 memory.')
      expect(result.created).toBe(false)

      const content = readInstructions(cwd)
      expect(content).toContain('Version 2 memory.')
      expect(content).not.toContain('Version 1 memory.')
      // Only one set of markers
      expect(content.split(MARKER_START).length).toBe(2)
    })

    it('replaces marker block while preserving surrounding user content', () => {
      const cwd = createTestDir()
      const filePath = path.join(cwd, '.github', 'copilot-instructions.md')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, 'User rules here.\n', 'utf8')

      injectCopilotInstructions(cwd, 'First memory.')
      injectCopilotInstructions(cwd, 'Second memory.')

      const content = readInstructions(cwd)
      expect(content).toContain('Second memory.')
      expect(content).not.toContain('First memory.')
      expect(content).toContain('User rules here.')
    })

    it('handles empty memory gracefully', () => {
      const cwd = createTestDir()

      const result = injectCopilotInstructions(cwd, '')

      expect(result.created).toBe(true)
      const content = readInstructions(cwd)
      expect(content).toContain(MARKER_START)
      expect(content).toContain(MARKER_END)
    })
  })

  describe('removeCopilotInstructions', () => {
    it('deletes file when we created it', () => {
      const cwd = createTestDir()

      injectCopilotInstructions(cwd, 'Memory text.')
      const filePath = path.join(cwd, '.github', 'copilot-instructions.md')
      expect(fs.existsSync(filePath)).toBe(true)

      removeCopilotInstructions(cwd, true)
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('strips marker block when we modified existing file', () => {
      const cwd = createTestDir()
      const filePath = path.join(cwd, '.github', 'copilot-instructions.md')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, 'Keep this content.\n', 'utf8')

      injectCopilotInstructions(cwd, 'Injected memory.')
      expect(readInstructions(cwd)).toContain('Injected memory.')

      removeCopilotInstructions(cwd, false)

      const content = readInstructions(cwd)
      expect(content).not.toContain(MARKER_START)
      expect(content).not.toContain('Injected memory.')
      expect(content).toContain('Keep this content.')
    })

    it('is safe to call when file is already gone', () => {
      const cwd = createTestDir()

      // Should not throw for either mode
      expect(() => removeCopilotInstructions(cwd, true)).not.toThrow()
      expect(() => removeCopilotInstructions(cwd, false)).not.toThrow()
    })

    it('preserves user content added after we created the file', () => {
      const cwd = createTestDir()
      const filePath = path.join(cwd, '.github', 'copilot-instructions.md')

      // App creates the file
      injectCopilotInstructions(cwd, 'Memory text.')
      expect(fs.existsSync(filePath)).toBe(true)

      // User edits the file during the session
      const current = fs.readFileSync(filePath, 'utf8')
      fs.writeFileSync(filePath, current + '\nAlways use single quotes.\n', 'utf8')

      // Cleanup with created=true should NOT delete the file
      removeCopilotInstructions(cwd, true)
      expect(fs.existsSync(filePath)).toBe(true)

      const content = readInstructions(cwd)
      expect(content).not.toContain(MARKER_START)
      expect(content).not.toContain('Memory text.')
      expect(content).toContain('Always use single quotes.')
    })
  })
})
