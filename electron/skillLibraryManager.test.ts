// @vitest-environment node

import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  let persistedState: unknown = null

  return {
    getPersistedState: () => persistedState,
    setPersistedState: (value: unknown) => {
      persistedState = structuredClone(value)
    },
    reset: () => {
      persistedState = null
    },
  }
})

vi.mock('electron-store', () => {
  return {
    default: class StoreMock<T> {
      store: T

      constructor(options?: { defaults?: T }) {
        const initial = mocks.getPersistedState() ?? options?.defaults ?? {}
        this.store = structuredClone(initial) as T
      }

      set(value: T): void {
        this.store = structuredClone(value)
        mocks.setPersistedState(this.store)
      }
    },
  }
})

import { SkillLibraryManager } from './skillLibraryManager'

async function writeFiles(
  rootPath: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(rootPath, ...relativePath.split('/'))
    await mkdir(path.dirname(targetPath), { recursive: true })
    await writeFile(targetPath, content, 'utf8')
  }
}

describe('SkillLibraryManager', () => {
  let tempRoot: string

  beforeEach(async () => {
    mocks.reset()
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-skills-'))
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  async function createManager(): Promise<{
    manager: SkillLibraryManager
    libraryRoot: string
    codexRoot: string
    claudeRoot: string
  }> {
    const libraryRoot = path.join(tempRoot, 'library')
    const codexRoot = path.join(tempRoot, 'codex')
    const claudeRoot = path.join(tempRoot, 'claude')
    const manager = new SkillLibraryManager()

    manager.updateSettings({
      ...manager.getSettings(),
      libraryRoot,
      providers: {
        codex: {
          targetRoot: codexRoot,
        },
        claude: {
          targetRoot: claudeRoot,
        },
      },
      autoSyncOnAppStart: false,
    })

    return {
      manager,
      libraryRoot,
      codexRoot,
      claudeRoot,
    }
  }

  it('auto-syncs a single valid skill version to the other roots', async () => {
    const { manager, libraryRoot, codexRoot, claudeRoot } = await createManager()

    await writeFiles(libraryRoot, {
      'document-topic-search/SKILL.md': '# skill\n',
      'document-topic-search/references/readme.md': 'shared\n',
    })
    await writeFiles(codexRoot, {
      'document-topic-search/scripts/tool.py': 'print("broken")\n',
    })

    const result = await manager.sync()
    const status = await manager.getStatus()

    expect(result.success).toBe(true)
    expect(status.conflicts).toEqual([])
    expect(status.issues).toEqual([])
    await expect(
      readFile(
        path.join(codexRoot, 'document-topic-search', 'SKILL.md'),
        'utf8',
      ),
    ).resolves.toBe('# skill\n')
    await expect(
      readFile(
        path.join(claudeRoot, 'document-topic-search', 'SKILL.md'),
        'utf8',
      ),
    ).resolves.toBe('# skill\n')
  })

  it('detects conflicting copies and recommends the newest one', async () => {
    const { manager, codexRoot, claudeRoot } = await createManager()

    await writeFiles(codexRoot, {
      'document-topic-search/SKILL.md': '# codex\n',
      'document-topic-search/notes.txt': 'codex\n',
    })
    await writeFiles(claudeRoot, {
      'document-topic-search/SKILL.md': '# claude\n',
      'document-topic-search/notes.txt': 'claude\n',
    })

    await utimes(
      path.join(codexRoot, 'document-topic-search', 'SKILL.md'),
      new Date('2026-03-12T10:00:00.000Z'),
      new Date('2026-03-12T10:00:00.000Z'),
    )
    await utimes(
      path.join(claudeRoot, 'document-topic-search', 'SKILL.md'),
      new Date('2026-03-12T11:00:00.000Z'),
      new Date('2026-03-12T11:00:00.000Z'),
    )

    const status = await manager.getStatus()

    expect(status.conflicts).toEqual([
      expect.objectContaining({
        skillName: 'document-topic-search',
        recommendedRoot: 'claude',
      }),
    ])
    expect(status.conflicts[0]?.differingFiles).toEqual(
      expect.arrayContaining(['SKILL.md', 'notes.txt']),
    )
  })

  it('syncs clear winners while leaving true conflicts unresolved', async () => {
    const { manager, libraryRoot, codexRoot, claudeRoot } = await createManager()

    await writeFiles(libraryRoot, {
      'vectorcfgcli/SKILL.md': '# vector\n',
    })
    await writeFiles(codexRoot, {
      'document-topic-search/SKILL.md': '# codex\n',
    })
    await writeFiles(claudeRoot, {
      'document-topic-search/SKILL.md': '# claude\n',
    })

    const result = await manager.sync()
    const status = await manager.getStatus()

    expect(result.success).toBe(false)
    expect(result.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillName: 'document-topic-search',
        }),
      ]),
    )
    await expect(
      readFile(path.join(codexRoot, 'vectorcfgcli', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# vector\n')
    await expect(
      readFile(path.join(claudeRoot, 'vectorcfgcli', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# vector\n')
    expect(status.conflicts).toHaveLength(1)
  })

  it('resolves a chosen conflict root into all configured roots', async () => {
    const { manager, libraryRoot, codexRoot, claudeRoot } = await createManager()

    await writeFiles(libraryRoot, {
      'document-topic-search/SKILL.md': '# library\n',
    })
    await writeFiles(codexRoot, {
      'document-topic-search/SKILL.md': '# codex\n',
    })
    await writeFiles(claudeRoot, {
      'document-topic-search/SKILL.md': '# claude\n',
      'document-topic-search/notes.txt': 'preferred\n',
    })

    const result = await manager.resolveConflict(
      'document-topic-search',
      'claude',
    )
    const status = await manager.getStatus()

    expect(result.success).toBe(true)
    expect(result.synchronizedSkills).toEqual(['document-topic-search'])
    expect(status.conflicts).toEqual([])
    await expect(
      readFile(path.join(libraryRoot, 'document-topic-search', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# claude\n')
    await expect(
      readFile(path.join(codexRoot, 'document-topic-search', 'notes.txt'), 'utf8'),
    ).resolves.toBe('preferred\n')
  })

  it('ignores dot-prefixed root folders when scanning skills', async () => {
    const { manager, codexRoot } = await createManager()

    await writeFiles(codexRoot, {
      '.system/keep.txt': 'keep\n',
      'document-topic-search/SKILL.md': '# codex\n',
    })

    const status = await manager.getStatus()
    const codexStatus = status.roots.find((entry) => entry.root === 'codex')

    expect(codexStatus?.skillNames).toEqual(['document-topic-search'])
  })

  it('drops legacy provider-based sync results from persisted state', async () => {
    mocks.setPersistedState({
      settings: {
        libraryRoot: 'C:\\legacy\\skills',
        providers: {
          codex: {
            targetRoot: 'C:\\legacy\\.codex\\skills',
          },
          claude: {
            targetRoot: 'C:\\legacy\\.claude\\skills',
          },
        },
        autoSyncOnAppStart: true,
      },
      lastSyncResult: {
        startedAt: '2026-03-12T10:00:00.000Z',
        completedAt: '2026-03-12T10:00:05.000Z',
        success: true,
        issues: [],
        providers: [
          {
            provider: 'codex',
            targetRoot: 'C:\\legacy\\.codex\\skills',
            syncedExports: ['document-topic-search'],
            removedExports: [],
            changed: true,
            skipped: false,
          },
        ],
      },
    })

    const manager = new SkillLibraryManager()
    const status = await manager.getStatus()

    expect(manager.getSettings()).toEqual({
      libraryRoot: 'C:\\legacy\\skills',
      providers: {
        codex: {
          targetRoot: 'C:\\legacy\\.codex\\skills',
        },
        claude: {
          targetRoot: 'C:\\legacy\\.claude\\skills',
        },
      },
      autoSyncOnAppStart: true,
    })
    expect(status.lastSyncResult).toBeNull()
  })
})
