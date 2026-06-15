// @vitest-environment node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  injectOpencodeInstructions,
  removeOpencodeInstructions,
} from './opencodeInstructions'

const MARKER_START = '<!-- agentclis-project-memory:start -->'
const MARKER_END = '<!-- agentclis-project-memory:end -->'

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-instr-test-'))
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

describe('opencodeInstructions', () => {
  describe('injectOpencodeInstructions', () => {
    it('creates AGENTS.md when nothing exists', () => {
      const cwd = createTestDir()

      const result = injectOpencodeInstructions(cwd, 'Project uses TypeScript.')

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

      const result = injectOpencodeInstructions(cwd, 'Project memory.')

      expect(result.created).toBe(false)
      const content = readInstructions(cwd)
      expect(content).toContain(MARKER_START)
      expect(content).toContain('Project memory.')
      expect(content).toContain('# Repository Guidelines')
      expect(content.indexOf(MARKER_START)).toBeLessThan(
        content.indexOf('# Repository Guidelines'),
      )
    })

    it('replaces existing marker block on re-inject', () => {
      const cwd = createTestDir()

      injectOpencodeInstructions(cwd, 'Version 1 memory.')
      const result = injectOpencodeInstructions(cwd, 'Version 2 memory.')
      expect(result.created).toBe(false)

      const content = readInstructions(cwd)
      expect(content).toContain('Version 2 memory.')
      expect(content).not.toContain('Version 1 memory.')
      expect(content.split(MARKER_START).length).toBe(2)
    })
  })

  describe('removeOpencodeInstructions', () => {
    it('deletes file when we created it', () => {
      const cwd = createTestDir()

      injectOpencodeInstructions(cwd, 'Memory text.')
      const filePath = path.join(cwd, 'AGENTS.md')
      expect(fs.existsSync(filePath)).toBe(true)

      removeOpencodeInstructions(cwd, true)
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('strips marker block when we modified existing file', () => {
      const cwd = createTestDir()
      const filePath = path.join(cwd, 'AGENTS.md')
      fs.writeFileSync(filePath, '# Keep this content.\n', 'utf8')

      injectOpencodeInstructions(cwd, 'Injected memory.')
      removeOpencodeInstructions(cwd, false)

      const content = readInstructions(cwd)
      expect(content).not.toContain(MARKER_START)
      expect(content).not.toContain('Injected memory.')
      expect(content).toContain('# Keep this content.')
    })

    it('is safe to call when file is already gone', () => {
      const cwd = createTestDir()

      expect(() => removeOpencodeInstructions(cwd, true)).not.toThrow()
      expect(() => removeOpencodeInstructions(cwd, false)).not.toThrow()
    })
  })
})
