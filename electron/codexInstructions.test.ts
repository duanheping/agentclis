// @vitest-environment node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  injectCodexInstructions,
  removeCodexInstructions,
} from './codexInstructions'

const MARKER_START = '<!-- agentclis-project-memory:start -->'
const MARKER_END = '<!-- agentclis-project-memory:end -->'

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-instr-test-'))
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
  return fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8')
}

describe('codexInstructions', () => {
  describe('injectCodexInstructions', () => {
    it('creates AGENTS.md when nothing exists', () => {
      const cwd = createTestDir()

      const result = injectCodexInstructions(cwd, 'Project uses TypeScript.')

      expect(result.created).toBe(true)
      const content = readInstructions(cwd)
      expect(content).toContain(MARKER_START)
      expect(content).toContain('Project uses TypeScript.')
      expect(content).toContain(MARKER_END)
    })

    it('prepends to existing AGENTS.md while preserving user content', () => {
      const cwd = createTestDir()
      const filePath = path.join(cwd, 'AGENTS.md')
      fs.writeFileSync(filePath, '# Repository Guidelines\n\nUse 2-space indent.\n', 'utf8')

      const result = injectCodexInstructions(cwd, 'Project memory.')

      expect(result.created).toBe(false)
      const content = readInstructions(cwd)
      expect(content).toContain(MARKER_START)
      expect(content).toContain('Project memory.')
      expect(content).toContain(MARKER_END)
      expect(content).toContain('# Repository Guidelines')
      // Memory block comes before user content
      expect(content.indexOf(MARKER_START)).toBeLessThan(
        content.indexOf('# Repository Guidelines'),
      )
    })

    it('replaces existing marker block on re-inject', () => {
      const cwd = createTestDir()

      injectCodexInstructions(cwd, 'Version 1 memory.')
      expect(readInstructions(cwd)).toContain('Version 1 memory.')

      const result = injectCodexInstructions(cwd, 'Version 2 memory.')
      expect(result.created).toBe(false)

      const content = readInstructions(cwd)
      expect(content).toContain('Version 2 memory.')
      expect(content).not.toContain('Version 1 memory.')
      expect(content.split(MARKER_START).length).toBe(2)
    })

    it('replaces marker block while preserving surrounding user content', () => {
      const cwd = createTestDir()
      const filePath = path.join(cwd, 'AGENTS.md')
      fs.writeFileSync(filePath, '# Repo Guidelines\n', 'utf8')

      injectCodexInstructions(cwd, 'First memory.')
      injectCodexInstructions(cwd, 'Second memory.')

      const content = readInstructions(cwd)
      expect(content).toContain('Second memory.')
      expect(content).not.toContain('First memory.')
      expect(content).toContain('# Repo Guidelines')
    })
  })

  describe('removeCodexInstructions', () => {
    it('deletes file when we created it', () => {
      const cwd = createTestDir()

      injectCodexInstructions(cwd, 'Memory text.')
      const filePath = path.join(cwd, 'AGENTS.md')
      expect(fs.existsSync(filePath)).toBe(true)

      removeCodexInstructions(cwd, true)
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('strips marker block when we modified existing file', () => {
      const cwd = createTestDir()
      const filePath = path.join(cwd, 'AGENTS.md')
      fs.writeFileSync(filePath, '# Keep this content.\n', 'utf8')

      injectCodexInstructions(cwd, 'Injected memory.')
      expect(readInstructions(cwd)).toContain('Injected memory.')

      removeCodexInstructions(cwd, false)

      const content = readInstructions(cwd)
      expect(content).not.toContain(MARKER_START)
      expect(content).not.toContain('Injected memory.')
      expect(content).toContain('# Keep this content.')
    })

    it('is safe to call when file is already gone', () => {
      const cwd = createTestDir()

      expect(() => removeCodexInstructions(cwd, true)).not.toThrow()
      expect(() => removeCodexInstructions(cwd, false)).not.toThrow()
    })

    it('preserves user content added after we created the file', () => {
      const cwd = createTestDir()
      const filePath = path.join(cwd, 'AGENTS.md')

      injectCodexInstructions(cwd, 'Memory text.')
      expect(fs.existsSync(filePath)).toBe(true)

      // User edits the file during the session
      const current = fs.readFileSync(filePath, 'utf8')
      fs.writeFileSync(filePath, current + '\n# Custom Rules\n', 'utf8')

      // Cleanup with created=true should NOT delete the file
      removeCodexInstructions(cwd, true)
      expect(fs.existsSync(filePath)).toBe(true)

      const content = readInstructions(cwd)
      expect(content).not.toContain(MARKER_START)
      expect(content).not.toContain('Memory text.')
      expect(content).toContain('# Custom Rules')
    })
  })
})
