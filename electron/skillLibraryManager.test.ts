// @vitest-environment node

import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  let persistedState: unknown = null
  const generateSkillMerge = vi.fn()
  const reviewSkillMerge = vi.fn()

  return {
    getPersistedState: () => persistedState,
    setPersistedState: (value: unknown) => {
      persistedState = structuredClone(value)
    },
    generateSkillMerge,
    reviewSkillMerge,
    reset: () => {
      persistedState = null
      generateSkillMerge.mockReset()
      reviewSkillMerge.mockReset()
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

vi.mock('./skillMergeAgent', () => ({
  generateSkillMerge: mocks.generateSkillMerge,
  reviewSkillMerge: mocks.reviewSkillMerge,
}))

import {
  SkillLibraryManager,
  shouldRefreshProjectMemoryAfterSkillSettingsUpdate,
} from './skillLibraryManager'

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
  let previousScanRoot: string | undefined

  beforeEach(async () => {
    mocks.reset()
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-skills-'))
    previousScanRoot = process.env.AGENCLIS_SKILL_SCAN_ROOT
    process.env.AGENCLIS_SKILL_SCAN_ROOT = tempRoot
  })

  afterEach(async () => {
    if (previousScanRoot === undefined) {
      delete process.env.AGENCLIS_SKILL_SCAN_ROOT
    } else {
      process.env.AGENCLIS_SKILL_SCAN_ROOT = previousScanRoot
    }

    await rm(tempRoot, { recursive: true, force: true })
  })

  async function createManager(): Promise<{
    manager: SkillLibraryManager
    libraryRoot: string
  }> {
    const libraryRoot = path.join(tempRoot, 'library')
    const manager = new SkillLibraryManager()

    manager.updateSettings({
      libraryRoot,
      primaryMergeAgent: 'codex',
      reviewMergeAgent: 'none',
    })

    return {
      manager,
      libraryRoot,
    }
  }

  function knownSkillRoot(provider: 'codex' | 'claude' | 'copilot'): string {
    return path.join(tempRoot, `.${provider}`, 'skills')
  }

  it('only requests project-memory refresh when a usable library root changes', () => {
    const baseSettings = {
      libraryRoot: 'C:\\skills',
      primaryMergeAgent: 'codex',
      reviewMergeAgent: 'none',
    } as const

    expect(
      shouldRefreshProjectMemoryAfterSkillSettingsUpdate(baseSettings, {
        ...baseSettings,
        primaryMergeAgent: 'copilot',
      }),
    ).toBe(false)
    expect(
      shouldRefreshProjectMemoryAfterSkillSettingsUpdate(baseSettings, {
        ...baseSettings,
        reviewMergeAgent: 'claude',
      }),
    ).toBe(false)
    expect(
      shouldRefreshProjectMemoryAfterSkillSettingsUpdate(baseSettings, {
        ...baseSettings,
        libraryRoot: '',
      }),
    ).toBe(false)
    expect(
      shouldRefreshProjectMemoryAfterSkillSettingsUpdate(
        {
          ...baseSettings,
          libraryRoot: '',
        },
        baseSettings,
      ),
    ).toBe(true)
    expect(
      shouldRefreshProjectMemoryAfterSkillSettingsUpdate(baseSettings, {
        ...baseSettings,
        libraryRoot: 'C:\\other-skills',
      }),
    ).toBe(true)
  })

  it('syncs discovered skills into the configured library root', async () => {
    const { manager, libraryRoot } = await createManager()
    const discoveredRoot = knownSkillRoot('codex')

    await writeFiles(discoveredRoot, {
      'document-topic-search/SKILL.md': '# skill\n',
      'document-topic-search/references/readme.md': 'shared\n',
    })

    const result = await manager.sync()
    const status = await manager.getStatus()

    expect(result.success).toBe(true)
    expect(status.conflicts).toEqual([])
    expect(status.issues).toEqual([])
    await expect(
      readFile(
        path.join(libraryRoot, 'document-topic-search', 'SKILL.md'),
        'utf8',
      ),
    ).resolves.toBe('# skill\n')
  })

  it('detects a library conflict against the newest discovered copy', async () => {
    const { manager, libraryRoot } = await createManager()
    const discoveredRoot = knownSkillRoot('codex')

    await writeFiles(libraryRoot, {
      'document-topic-search/SKILL.md': '# library\n',
    })
    await writeFiles(discoveredRoot, {
      'document-topic-search/SKILL.md': '# discovered\n',
      'document-topic-search/notes.txt': 'discovered\n',
    })

    const status = await manager.getStatus()

    expect(status.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillName: 'document-topic-search',
          roots: expect.arrayContaining([
            expect.objectContaining({
              root: 'discovered',
              label: expect.stringContaining('.codex\\skills'),
            }),
          ]),
        }),
      ]),
    )
    expect(status.conflicts[0]?.differingFiles).toEqual(
      expect.arrayContaining(['SKILL.md', 'notes.txt']),
    )
  })

  it('syncs clear winners while leaving true conflicts unresolved', async () => {
    const { manager, libraryRoot } = await createManager()
    const discoveredRoot = knownSkillRoot('codex')

    await writeFiles(libraryRoot, {
      'document-topic-search/SKILL.md': '# library\n',
    })
    await writeFiles(discoveredRoot, {
      'document-topic-search/SKILL.md': '# discovered\n',
      'vectorcfgcli/SKILL.md': '# vector\n',
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
      readFile(path.join(libraryRoot, 'vectorcfgcli', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# vector\n')
    expect(status.conflicts).toHaveLength(1)
  })

  it('resolves a chosen discovered conflict into the library root', async () => {
    const { manager, libraryRoot } = await createManager()
    const discoveredRoot = knownSkillRoot('codex')

    await writeFiles(libraryRoot, {
      'document-topic-search/SKILL.md': '# library\n',
    })
    await writeFiles(discoveredRoot, {
      'document-topic-search/SKILL.md': '# discovered\n',
      'document-topic-search/notes.txt': 'preferred\n',
    })

    const result = await manager.resolveConflict(
      'document-topic-search',
      'discovered',
    )
    const status = await manager.getStatus()

    expect(result.success).toBe(true)
    expect(result.synchronizedSkills).toEqual(['document-topic-search'])
    expect(status.conflicts).toEqual([])
    await expect(
      readFile(path.join(libraryRoot, 'document-topic-search', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# discovered\n')
    await expect(
      readFile(path.join(libraryRoot, 'document-topic-search', 'notes.txt'), 'utf8'),
    ).resolves.toBe('preferred\n')
  })

  it('ignores dot-prefixed folders inside the library root when scanning canonical skills', async () => {
    const { manager, libraryRoot } = await createManager()

    await writeFiles(libraryRoot, {
      '.system/keep.txt': 'keep\n',
      'document-topic-search/SKILL.md': '# library\n',
    })

    const status = await manager.getStatus()
    const libraryStatus = status.roots.find((entry) => entry.root === 'library')

    expect(libraryStatus?.skillNames).toEqual(['document-topic-search'])
  })

  it('uses the configured primary agent and optional reviewer', async () => {
    const { manager, libraryRoot } = await createManager()
    const discoveredRoot = knownSkillRoot('codex')

    manager.updateSettings({
      ...manager.getSettings(),
      primaryMergeAgent: 'claude',
      reviewMergeAgent: 'copilot',
    })

    await writeFiles(libraryRoot, {
      'document-topic-search/SKILL.md': '# library\n',
    })
    await writeFiles(discoveredRoot, {
      'document-topic-search/SKILL.md': '# discovered\n',
    })

    mocks.generateSkillMerge.mockResolvedValue({
      skillName: 'document-topic-search',
      mergeAgent: 'claude',
      generatedAt: '2026-03-12T18:00:00.000Z',
      summary: 'Merged by Claude.',
      rationale: 'Chose the stronger combined instructions.',
      warnings: [],
      sourceRoots: ['library', 'discovered'],
      files: [
        {
          path: 'SKILL.md',
          content: '# merged\n',
        },
      ],
      review: null,
    })
    mocks.reviewSkillMerge.mockResolvedValue({
      reviewer: 'copilot',
      reviewedAt: '2026-03-12T18:01:00.000Z',
      status: 'approved-with-warnings',
      summary: 'Looks good overall.',
      rationale: 'The merge preserved the important content.',
      warnings: ['Double-check one helper note manually.'],
    })

    const proposal = await manager.generateAiMerge('document-topic-search')

    expect(mocks.generateSkillMerge).toHaveBeenCalledWith(
      'claude',
      'document-topic-search',
      expect.arrayContaining([
        expect.objectContaining({ root: 'library' }),
        expect.objectContaining({ root: 'discovered' }),
      ]),
    )
    expect(mocks.reviewSkillMerge).toHaveBeenCalledWith(
      'copilot',
      expect.objectContaining({
        skillName: 'document-topic-search',
        mergeAgent: 'claude',
      }),
      expect.arrayContaining([
        expect.objectContaining({ root: 'library' }),
        expect.objectContaining({ root: 'discovered' }),
      ]),
    )
    expect(proposal.review).toEqual(
      expect.objectContaining({
        reviewer: 'copilot',
        status: 'approved-with-warnings',
      }),
    )
  })

  it('drops legacy provider-based settings and sync results from persisted state', async () => {
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
      primaryMergeAgent: 'codex',
      reviewMergeAgent: 'none',
    })
    expect(status.lastSyncResult).toBeNull()
  })
})
