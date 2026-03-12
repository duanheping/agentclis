// @vitest-environment node

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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

  async function createManagerWithLibrary(): Promise<{
    manager: SkillLibraryManager
    libraryRoot: string
    codexRoot: string
    claudeRoot: string
  }> {
    const libraryRoot = path.join(tempRoot, 'library')
    const codexRoot = path.join(tempRoot, 'codex-target')
    const claudeRoot = path.join(tempRoot, 'claude-target')
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

  it('discovers shared skills, ignores root files, and flags a missing SKILL.md', async () => {
    const { manager, libraryRoot } = await createManagerWithLibrary()

    await writeFiles(libraryRoot, {
      'common/document-topic-search/SKILL.md': '# skill',
      'common/readme.txt': 'ignore me',
      'common/missing-md/scripts/tool.py': 'print("hi")',
    })

    const status = await manager.getStatus()

    expect(status.discoveredSkills).toEqual([
      'document-topic-search',
      'missing-md',
    ])
    expect(status.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing-skill-md',
          skillName: 'missing-md',
        }),
      ]),
    )
  })

  it('merges provider overlays by replacing matching files and adding new ones', async () => {
    const { manager, libraryRoot, codexRoot } = await createManagerWithLibrary()

    await writeFiles(libraryRoot, {
      'common/document-topic-search/SKILL.md': 'base skill',
      'common/document-topic-search/scripts/search.py': 'print("base")\n',
      'overlays/codex/document-topic-search/scripts/search.py': 'print("codex")\n',
      'overlays/codex/document-topic-search/references/notes.md': 'codex only\n',
    })

    await manager.sync()

    expect(
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then(
        async ({ readFile }) =>
          readFile(
            path.join(
              codexRoot,
              'document-topic-search',
              'scripts',
              'search.py',
            ),
            'utf8',
          ),
      ),
    ).toBe('print("codex")\n')
    expect(
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then(
        async ({ readFile }) =>
          readFile(
            path.join(
              codexRoot,
              'document-topic-search',
              'references',
              'notes.md',
            ),
            'utf8',
          ),
      ),
    ).toBe('codex only\n')
  })

  it('applies provider export name overrides and rejects duplicates', async () => {
    const { manager, libraryRoot } = await createManagerWithLibrary()

    await writeFiles(libraryRoot, {
      'common/document-topic-search/SKILL.md': 'base skill',
      'common/another-topic-search/SKILL.md': 'base skill',
      'registry.json': JSON.stringify(
        {
          skills: {
            'document-topic-search': {
              providers: {
                claude: {
                  exportName: 'pdf-topic-search',
                },
              },
            },
            'another-topic-search': {
              providers: {
                claude: {
                  exportName: 'pdf-topic-search',
                },
              },
            },
          },
        },
        null,
        2,
      ),
    })

    const status = await manager.getStatus()
    const claudeStatus = status.providers.find(
      (entry) => entry.provider === 'claude',
    )

    expect(claudeStatus?.plannedExports).toContain('pdf-topic-search')
    expect(status.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'duplicate-export-name',
          provider: 'claude',
        }),
      ]),
    )
  })

  it('removes previously managed exports without touching unmanaged or dot-prefixed folders', async () => {
    const { manager, libraryRoot, codexRoot } = await createManagerWithLibrary()

    await writeFiles(libraryRoot, {
      'common/new-skill/SKILL.md': 'new skill',
    })
    await writeFiles(codexRoot, {
      '.system/keep.txt': 'keep',
      'manual-skill/keep.txt': 'keep',
      'old-skill/SKILL.md': 'remove me',
      '.agenclis-skill-sync.json': JSON.stringify(
        {
          version: 1,
          managedExports: ['old-skill'],
        },
        null,
        2,
      ),
    })

    await manager.sync()

    await expect(
      vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then(
        async ({ readFile }) =>
          readFile(path.join(codexRoot, '.system', 'keep.txt'), 'utf8'),
      ),
    ).resolves.toBe('keep')
    await expect(
      vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then(
        async ({ readFile }) =>
          readFile(path.join(codexRoot, 'manual-skill', 'keep.txt'), 'utf8'),
      ),
    ).resolves.toBe('keep')
    await expect(
      vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then(
        async ({ readFile }) =>
          readFile(path.join(codexRoot, 'new-skill', 'SKILL.md'), 'utf8'),
      ),
    ).resolves.toBe('new skill')
    await expect(
      vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then(
        async ({ readFile }) =>
          readFile(path.join(codexRoot, 'old-skill', 'SKILL.md'), 'utf8'),
      ),
    ).rejects.toThrow()
  })

  it('reports a no-op sync when the manifest and exported files already match', async () => {
    const { manager, libraryRoot } = await createManagerWithLibrary()

    await writeFiles(libraryRoot, {
      'common/document-topic-search/SKILL.md': 'base skill',
    })

    const firstResult = await manager.sync()
    const secondResult = await manager.sync()

    expect(firstResult.providers.every((provider) => provider.changed)).toBe(true)
    expect(secondResult.providers.every((provider) => !provider.changed)).toBe(true)
  })

  it('syncs both providers with rename and provider-specific disable rules', async () => {
    const { manager, libraryRoot, codexRoot, claudeRoot } =
      await createManagerWithLibrary()

    await writeFiles(libraryRoot, {
      'common/document-topic-search/SKILL.md': 'shared doc skill',
      'common/security-best-practices/SKILL.md': 'security skill',
      'common/vectorcfgcli/SKILL.md': 'vector skill',
      'registry.json': JSON.stringify(
        {
          skills: {
            'document-topic-search': {
              providers: {
                claude: {
                  exportName: 'pdf-topic-search',
                },
              },
            },
            'security-best-practices': {
              providers: {
                claude: {
                  disabled: true,
                },
              },
            },
          },
        },
        null,
        2,
      ),
    })

    const result = await manager.sync()

    expect(result.success).toBe(true)
    await expect(
      vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then(
        async ({ readFile }) =>
          readFile(
            path.join(codexRoot, 'document-topic-search', 'SKILL.md'),
            'utf8',
          ),
      ),
    ).resolves.toBe('shared doc skill')
    await expect(
      vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then(
        async ({ readFile }) =>
          readFile(path.join(claudeRoot, 'pdf-topic-search', 'SKILL.md'), 'utf8'),
      ),
    ).resolves.toBe('shared doc skill')
    await expect(
      vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then(
        async ({ readFile }) =>
          readFile(
            path.join(claudeRoot, 'security-best-practices', 'SKILL.md'),
            'utf8',
          ),
      ),
    ).rejects.toThrow()
    await expect(
      vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then(
        async ({ readFile }) =>
          readFile(path.join(codexRoot, 'vectorcfgcli', 'SKILL.md'), 'utf8'),
      ),
    ).resolves.toBe('vector skill')
  })
})
