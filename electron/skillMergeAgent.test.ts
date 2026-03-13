// @vitest-environment node

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const spawn = vi.fn((_command: string, args: string[], options?: { cwd?: string }) => {
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
      const commandLine = args.join(' ')

      if (!cwd) {
        process.emit('exit', 1)
        return
      }

      if (commandLine.includes('claude') && commandLine.includes('bypassPermissions')) {
        await mkdir(path.join(cwd, 'merged'), { recursive: true })
        await writeFile(path.join(cwd, 'merged', 'SKILL.md'), '# merged by claude\n', 'utf8')
        process.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              summary: 'Claude merged the skill.',
              rationale: 'Claude combined the strongest instructions.',
              warnings: ['Verify one helper script manually.'],
            }),
            'utf8',
          ),
        )
        process.emit('exit', 0)
        return
      }

      if (commandLine.includes('claude') && commandLine.includes('dontAsk')) {
        process.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              status: 'approved',
              summary: 'Review looks good.',
              rationale: 'The merge preserved the important content.',
              warnings: [],
            }),
            'utf8',
          ),
        )
        process.emit('exit', 0)
        return
      }

      if (commandLine.includes('copilot') && commandLine.includes('--output-format json')) {
        if (commandLine.includes('./proposal')) {
          process.stdout.emit(
            'data',
            Buffer.from(
              [
                JSON.stringify({
                  type: 'assistant.message',
                  data: {
                    content: JSON.stringify({
                      status: 'approved-with-warnings',
                      summary: 'Copilot review found one follow-up.',
                      rationale: 'The merged skill is sound but one note should be checked.',
                      warnings: ['Review the merged helper note manually.'],
                    }),
                  },
                }),
              ].join('\n'),
              'utf8',
            ),
          )
          process.emit('exit', 0)
          return
        }

        await mkdir(path.join(cwd, 'merged'), { recursive: true })
        await writeFile(path.join(cwd, 'merged', 'SKILL.md'), '# merged by copilot\n', 'utf8')
        process.stdout.emit(
          'data',
          Buffer.from(
            [
              JSON.stringify({
                type: 'assistant.message',
                data: {
                  content: JSON.stringify({
                    summary: 'Copilot merged the skill.',
                    rationale: 'Copilot combined the clearest instructions.',
                    warnings: ['Review the merged helper note manually.'],
                  }),
                },
              }),
            ].join('\n'),
            'utf8',
          ),
        )
        process.emit('exit', 0)
        return
      }

      process.stderr.emit('data', Buffer.from('unexpected command', 'utf8'))
      process.emit('exit', 1)
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

import { generateSkillMerge, reviewSkillMerge } from './skillMergeAgent'

describe('skillMergeAgent', () => {
  afterEach(() => {
    mocks.spawn.mockClear()
  })

  it('generates and reviews a Claude merge proposal', async () => {
    const proposal = await generateSkillMerge('claude', 'document-topic-search', [
      {
        root: 'codex',
        files: new Map([
          ['SKILL.md', Buffer.from('# codex\n', 'utf8')],
        ]),
      },
      {
        root: 'claude',
        files: new Map([
          ['SKILL.md', Buffer.from('# claude\n', 'utf8')],
        ]),
      },
    ])

    const review = await reviewSkillMerge('claude', proposal, [
      {
        root: 'codex',
        files: new Map([
          ['SKILL.md', Buffer.from('# codex\n', 'utf8')],
        ]),
      },
      {
        root: 'claude',
        files: new Map([
          ['SKILL.md', Buffer.from('# claude\n', 'utf8')],
        ]),
      },
    ])

    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    expect(proposal).toEqual(
      expect.objectContaining({
        skillName: 'document-topic-search',
        mergeAgent: 'claude',
        summary: 'Claude merged the skill.',
        warnings: ['Verify one helper script manually.'],
      }),
    )
    expect(proposal.files).toEqual([
      {
        path: 'SKILL.md',
        content: '# merged by claude\n',
      },
    ])
    expect(review).toEqual(
      expect.objectContaining({
        reviewer: 'claude',
        status: 'approved',
        summary: 'Review looks good.',
      }),
    )
  })

  it('generates and reviews a Copilot merge proposal', async () => {
    const proposal = await generateSkillMerge('copilot', 'document-topic-search', [
      {
        root: 'codex',
        files: new Map([
          ['SKILL.md', Buffer.from('# codex\n', 'utf8')],
        ]),
      },
      {
        root: 'claude',
        files: new Map([
          ['SKILL.md', Buffer.from('# claude\n', 'utf8')],
        ]),
      },
    ])

    const review = await reviewSkillMerge('copilot', proposal, [
      {
        root: 'codex',
        files: new Map([
          ['SKILL.md', Buffer.from('# codex\n', 'utf8')],
        ]),
      },
      {
        root: 'claude',
        files: new Map([
          ['SKILL.md', Buffer.from('# claude\n', 'utf8')],
        ]),
      },
    ])

    expect(proposal).toEqual(
      expect.objectContaining({
        skillName: 'document-topic-search',
        mergeAgent: 'copilot',
        summary: 'Copilot merged the skill.',
        warnings: ['Review the merged helper note manually.'],
      }),
    )
    expect(proposal.files).toEqual([
      {
        path: 'SKILL.md',
        content: '# merged by copilot\n',
      },
    ])
    expect(review).toEqual(
      expect.objectContaining({
        reviewer: 'copilot',
        status: 'approved-with-warnings',
        summary: 'Copilot review found one follow-up.',
      }),
    )
  })
})
