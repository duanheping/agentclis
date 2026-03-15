// @vitest-environment node

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const spawn = vi.fn((_command: string, _args: string[], options?: { cwd?: string }) => {
    const process = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      stdin: {
        write: (value: string) => void
        end: () => void
      }
    }

    process.stdout = new EventEmitter()
    process.stderr = new EventEmitter()
    process.stdin = {
      write: () => undefined,
      end: () => undefined,
    }

    queueMicrotask(async () => {
      const cwd = options?.cwd
      if (!cwd) {
        process.emit('exit', 1)
        return
      }

      await mkdir(path.join(cwd, 'merged', 'references'), { recursive: true })
      await writeFile(
        path.join(cwd, 'response.json'),
        JSON.stringify({
          summary: 'Merged the stronger instructions.',
          rationale: 'Kept the clearer SKILL.md and the extra notes file.',
          warnings: ['Review notes.txt manually.'],
        }),
        'utf8',
      )
      await writeFile(path.join(cwd, 'merged', 'SKILL.md'), '# merged skill\n', 'utf8')
      await writeFile(
        path.join(cwd, 'merged', 'references', 'notes.txt'),
        'merged notes\n',
        'utf8',
      )

      process.emit('exit', 0)
    })

    return process
  })

  return { spawn }
})

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}))

vi.mock('./windowsShell', () => ({
  resolveCommandPromptCommand: () => 'C:\\Windows\\System32\\cmd.exe',
}))

import { generateCodexSkillMerge } from './skillMergeCodex'

describe('generateCodexSkillMerge', () => {
  afterEach(() => {
    mocks.spawn.mockClear()
  })

  it('returns a structured merge proposal from codex output files', async () => {
    const proposal = await generateCodexSkillMerge('document-topic-search', [
      {
        root: 'library',
        files: new Map([
          ['SKILL.md', Buffer.from('# codex\n', 'utf8')],
        ]),
      },
      {
        root: 'discovered',
        files: new Map([
          ['SKILL.md', Buffer.from('# claude\n', 'utf8')],
        ]),
      },
    ])

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(proposal).toEqual(
      expect.objectContaining({
        skillName: 'document-topic-search',
        mergeAgent: 'codex',
        summary: 'Merged the stronger instructions.',
        warnings: ['Review notes.txt manually.'],
        sourceRoots: ['library', 'discovered'],
        review: null,
      }),
    )
    expect(proposal.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'SKILL.md',
          content: '# merged skill\n',
        }),
        expect.objectContaining({
          path: 'references/notes.txt',
          content: 'merged notes\n',
        }),
      ]),
    )
  })
})
