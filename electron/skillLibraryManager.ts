import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import Store from 'electron-store'

import {
  SKILL_TARGET_PROVIDERS,
  type SkillDefinitionOverride,
  type SkillLibrarySettings,
  type SkillSyncIssue,
  type SkillSyncProviderResult,
  type SkillSyncResult,
  type SkillSyncStatus,
  type SkillTargetProvider,
} from '../src/shared/skills'

const COMMON_ROOT_NAME = 'common'
const OVERLAYS_ROOT_NAME = 'overlays'
const REGISTRY_FILE_NAME = 'registry.json'
const MANIFEST_FILE_NAME = '.agenclis-skill-sync.json'

interface SkillRegistryFile {
  skills?: Record<string, SkillDefinitionOverride>
}

interface SkillSyncManifest {
  version: 1
  managedExports: string[]
}

interface PersistedSkillLibraryState {
  settings: SkillLibrarySettings
  lastSyncResult: SkillSyncResult | null
}

interface PlannedProviderExport {
  skillName: string
  exportName: string
  files: Map<string, string>
}

interface LibraryInspection {
  discoveredSkills: string[]
  issues: SkillSyncIssue[]
  providerPlans: Record<SkillTargetProvider, PlannedProviderExport[]>
}

interface DirectoryFiles {
  files: Map<string, string>
  directories: string[]
}

const DEFAULT_TARGET_ROOTS: Record<SkillTargetProvider, string> = {
  codex: path.join(os.homedir(), '.codex', 'skills'),
  claude: path.join(os.homedir(), '.claude', 'skills'),
}

function buildDefaultSettings(): SkillLibrarySettings {
  return {
    libraryRoot: '',
    providers: {
      codex: {
        targetRoot: DEFAULT_TARGET_ROOTS.codex,
      },
      claude: {
        targetRoot: DEFAULT_TARGET_ROOTS.claude,
      },
    },
    autoSyncOnAppStart: false,
  }
}

function normalizeSettings(settings: SkillLibrarySettings): SkillLibrarySettings {
  return {
    libraryRoot: settings.libraryRoot.trim(),
    providers: {
      codex: {
        targetRoot: settings.providers.codex.targetRoot.trim(),
      },
      claude: {
        targetRoot: settings.providers.claude.targetRoot.trim(),
      },
    },
    autoSyncOnAppStart: settings.autoSyncOnAppStart,
  }
}

function cloneSettings(settings: SkillLibrarySettings): SkillLibrarySettings {
  return structuredClone(settings)
}

function sortIssues(issues: SkillSyncIssue[]): SkillSyncIssue[] {
  return [...issues].sort((left, right) => {
    const leftKey = [
      left.severity,
      left.provider ?? '',
      left.skillName ?? '',
      left.code,
      left.message,
    ].join('|')
    const rightKey = [
      right.severity,
      right.provider ?? '',
      right.skillName ?? '',
      right.code,
      right.message,
    ].join('|')

    return leftKey.localeCompare(rightKey)
  })
}

function sortStrings(values: Iterable<string>): string[] {
  return Array.from(values).sort((left, right) => left.localeCompare(right))
}

function isValidExportName(name: string): boolean {
  const normalized = name.trim()
  return (
    Boolean(normalized) &&
    !normalized.startsWith('.') &&
    !normalized.includes('/') &&
    !normalized.includes('\\')
  )
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

async function listDirectoryNames(rootPath: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(rootPath, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
}

async function readRegistry(
  libraryRoot: string,
): Promise<{ overrides: Record<string, SkillDefinitionOverride>; issues: SkillSyncIssue[] }> {
  const registryPath = path.join(libraryRoot, REGISTRY_FILE_NAME)
  if (!(await pathExists(registryPath))) {
    return {
      overrides: {},
      issues: [],
    }
  }

  try {
    const raw = await readFile(registryPath, 'utf8')
    const parsed = JSON.parse(raw) as SkillRegistryFile
    return {
      overrides: parsed.skills ?? {},
      issues: [],
    }
  } catch (error) {
    return {
      overrides: {},
      issues: [
        {
          severity: 'error',
          code: 'invalid-registry',
          message:
            error instanceof Error
              ? `Failed to parse registry.json: ${error.message}`
              : 'Failed to parse registry.json.',
        },
      ],
    }
  }
}

async function listFilesRecursive(rootPath: string): Promise<DirectoryFiles> {
  const files = new Map<string, string>()
  const directories = new Set<string>()

  async function visit(currentPath: string, relativePath = ''): Promise<void> {
    let entries
    try {
      entries = await readdir(currentPath, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const nextRelativePath = relativePath
        ? path.posix.join(relativePath, entry.name)
        : entry.name
      const nextPath = path.join(currentPath, entry.name)

      if (entry.isDirectory()) {
        directories.add(nextRelativePath)
        await visit(nextPath, nextRelativePath)
        continue
      }

      if (entry.isFile()) {
        files.set(nextRelativePath, nextPath)
      }
    }
  }

  await visit(rootPath)

  return {
    files,
    directories: sortStrings(directories),
  }
}

async function compareFileContents(
  sourcePath: string,
  targetPath: string,
): Promise<boolean> {
  try {
    const [source, target] = await Promise.all([
      readFile(sourcePath),
      readFile(targetPath),
    ])

    return source.equals(target)
  } catch {
    return false
  }
}

async function removeEmptyDirectories(rootPath: string): Promise<void> {
  if (!(await pathExists(rootPath))) {
    return
  }

  let entries
  try {
    entries = await readdir(rootPath, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const childPath = path.join(rootPath, entry.name)
    await removeEmptyDirectories(childPath)

    const childEntries = await readdir(childPath, { withFileTypes: true }).catch(() => [])
    if (childEntries.length === 0) {
      await rm(childPath, { recursive: true, force: true })
    }
  }
}

async function loadManifest(targetRoot: string): Promise<SkillSyncManifest> {
  const manifestPath = path.join(targetRoot, MANIFEST_FILE_NAME)
  if (!(await pathExists(manifestPath))) {
    return {
      version: 1,
      managedExports: [],
    }
  }

  try {
    const raw = await readFile(manifestPath, 'utf8')
    const parsed = JSON.parse(raw) as SkillSyncManifest

    return {
      version: 1,
      managedExports: sortStrings(parsed.managedExports ?? []),
    }
  } catch {
    return {
      version: 1,
      managedExports: [],
    }
  }
}

async function writeManifest(
  targetRoot: string,
  exportNames: string[],
): Promise<void> {
  const manifestPath = path.join(targetRoot, MANIFEST_FILE_NAME)
  const manifest: SkillSyncManifest = {
    version: 1,
    managedExports: sortStrings(exportNames),
  }

  await mkdir(targetRoot, { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

export class SkillLibraryManager {
  private readonly store = new Store<PersistedSkillLibraryState>({
    name: 'agenclis-skills',
    defaults: {
      settings: buildDefaultSettings(),
      lastSyncResult: null,
    },
  })

  getSettings(): SkillLibrarySettings {
    return cloneSettings(this.store.store.settings)
  }

  updateSettings(settings: SkillLibrarySettings): SkillLibrarySettings {
    const normalizedSettings = normalizeSettings(settings)
    this.store.set({
      ...this.store.store,
      settings: normalizedSettings,
    })

    return cloneSettings(normalizedSettings)
  }

  async getStatus(): Promise<SkillSyncStatus> {
    const inspection = await this.inspectLibrary()
    return {
      discoveredSkills: inspection.discoveredSkills,
      issues: inspection.issues,
      providers: SKILL_TARGET_PROVIDERS.map((provider) => ({
        provider,
        configured: Boolean(this.getSettings().providers[provider].targetRoot),
        plannedExports: inspection.providerPlans[provider].map(
          (entry) => entry.exportName,
        ),
      })),
      lastSyncResult: this.store.store.lastSyncResult,
    }
  }

  async sync(): Promise<SkillSyncResult> {
    const startedAt = new Date().toISOString()
    const settings = this.getSettings()
    const inspection = await this.inspectLibrary()
    const issues = [...inspection.issues]
    const blockingIssues = issues.filter((issue) => issue.severity === 'error')

    const configuredProviders = SKILL_TARGET_PROVIDERS.filter((provider) =>
      Boolean(settings.providers[provider].targetRoot),
    )

    if (configuredProviders.length === 0) {
      issues.push({
        severity: 'error',
        code: 'no-target-roots',
        message: 'At least one provider target root must be configured.',
      })
    }

    const providerResults: SkillSyncProviderResult[] = []

    for (const provider of SKILL_TARGET_PROVIDERS) {
      const targetRoot = settings.providers[provider].targetRoot
      const providerErrors = issues.filter(
        (issue) => issue.severity === 'error' && issue.provider === provider,
      )
      const hasGlobalError = blockingIssues.some((issue) => !issue.provider)

      if (!targetRoot) {
        providerResults.push({
          provider,
          targetRoot,
          syncedExports: [],
          removedExports: [],
          changed: false,
          skipped: true,
          message: 'Target root is not configured.',
        })
        continue
      }

      if (hasGlobalError || providerErrors.length > 0) {
        providerResults.push({
          provider,
          targetRoot,
          syncedExports: [],
          removedExports: [],
          changed: false,
          skipped: true,
          message:
            providerErrors[0]?.message ??
            blockingIssues.find((issue) => !issue.provider)?.message ??
            'Sync skipped because validation failed.',
        })
        continue
      }

      providerResults.push(
        await this.syncProvider(
          provider,
          targetRoot,
          inspection.providerPlans[provider],
        ),
      )
    }

    const success =
      !issues.some((issue) => issue.severity === 'error') &&
      providerResults.some((result) => !result.skipped)

    const result: SkillSyncResult = {
      startedAt,
      completedAt: new Date().toISOString(),
      success,
      issues: sortIssues(issues),
      providers: providerResults,
    }

    this.store.set({
      ...this.store.store,
      lastSyncResult: result,
    })

    return result
  }

  async syncOnAppStart(): Promise<SkillSyncResult | null> {
    const settings = this.getSettings()
    if (!settings.autoSyncOnAppStart) {
      return null
    }

    return this.sync()
  }

  private async inspectLibrary(): Promise<LibraryInspection> {
    const settings = this.getSettings()
    const providerPlans = {
      codex: [] as PlannedProviderExport[],
      claude: [] as PlannedProviderExport[],
    }
    const issues: SkillSyncIssue[] = []
    const discoveredSkills = new Set<string>()

    if (!settings.libraryRoot) {
      return {
        discoveredSkills: [],
        issues: [
          {
            severity: 'error',
            code: 'missing-library-root',
            message: 'Library root is not configured.',
          },
        ],
        providerPlans,
      }
    }

    if (!(await pathExists(settings.libraryRoot))) {
      return {
        discoveredSkills: [],
        issues: [
          {
            severity: 'error',
            code: 'library-root-not-found',
            message: `Library root does not exist: ${settings.libraryRoot}`,
          },
        ],
        providerPlans,
      }
    }

    const commonRoot = path.join(settings.libraryRoot, COMMON_ROOT_NAME)
    const overlaysRoot = path.join(settings.libraryRoot, OVERLAYS_ROOT_NAME)

    const [commonSkillNames, codexOverlayNames, claudeOverlayNames, registry] =
      await Promise.all([
        listDirectoryNames(commonRoot),
        listDirectoryNames(path.join(overlaysRoot, 'codex')),
        listDirectoryNames(path.join(overlaysRoot, 'claude')),
        readRegistry(settings.libraryRoot),
      ])

    issues.push(...registry.issues)

    const commonSkillSet = new Set(commonSkillNames)
    const overlaySkillSets: Record<SkillTargetProvider, Set<string>> = {
      codex: new Set(codexOverlayNames),
      claude: new Set(claudeOverlayNames),
    }

    for (const skillName of commonSkillNames) {
      discoveredSkills.add(skillName)

      if (!(await pathExists(path.join(commonRoot, skillName, 'SKILL.md')))) {
        issues.push({
          severity: 'error',
          code: 'missing-skill-md',
          message: 'Each shared skill in common/ must include SKILL.md.',
          skillName,
        })
      }
    }

    const allCandidateSkillNames = new Set<string>(commonSkillNames)

    for (const provider of SKILL_TARGET_PROVIDERS) {
      for (const skillName of overlaySkillSets[provider]) {
        const override = registry.overrides[skillName]
        if (commonSkillSet.has(skillName)) {
          allCandidateSkillNames.add(skillName)
          continue
        }

        if (override?.allowOverlayOnly) {
          discoveredSkills.add(skillName)
          allCandidateSkillNames.add(skillName)
          continue
        }

        issues.push({
          severity: 'error',
          code: 'overlay-without-common-skill',
          message:
            'Overlay folders must match a shared skill in common/ unless registry.json allows overlay-only export.',
          skillName,
          provider,
        })
      }
    }

    for (const skillName of sortStrings(allCandidateSkillNames)) {
      const override = registry.overrides[skillName]
      const commonSkillRoot = commonSkillSet.has(skillName)
        ? path.join(commonRoot, skillName)
        : null

      for (const provider of SKILL_TARGET_PROVIDERS) {
        const providerOverride = override?.providers?.[provider]
        const overlaySkillRoot = overlaySkillSets[provider].has(skillName)
          ? path.join(overlaysRoot, provider, skillName)
          : null

        if (providerOverride?.disabled) {
          continue
        }

        if (!commonSkillRoot && !overlaySkillRoot) {
          continue
        }

        const exportName = providerOverride?.exportName?.trim() || skillName
        if (!isValidExportName(exportName)) {
          issues.push({
            severity: 'error',
            code: 'invalid-export-name',
            message: `Invalid export name "${exportName}".`,
            skillName,
            provider,
          })
          continue
        }

        const mergedFiles = new Map<string, string>()

        if (commonSkillRoot) {
          const commonFiles = await listFilesRecursive(commonSkillRoot)
          for (const [relativePath, sourcePath] of commonFiles.files.entries()) {
            mergedFiles.set(relativePath, sourcePath)
          }
        }

        if (overlaySkillRoot) {
          const overlayFiles = await listFilesRecursive(overlaySkillRoot)
          for (const [relativePath, sourcePath] of overlayFiles.files.entries()) {
            mergedFiles.set(relativePath, sourcePath)
          }
        }

        if (!mergedFiles.has('SKILL.md')) {
          issues.push({
            severity: 'error',
            code: 'missing-export-skill-md',
            message: 'Each exported skill must contain SKILL.md after overlays are applied.',
            skillName,
            provider,
          })
          continue
        }

        providerPlans[provider].push({
          skillName,
          exportName,
          files: mergedFiles,
        })
      }
    }

    for (const provider of SKILL_TARGET_PROVIDERS) {
      const seenExportNames = new Map<string, string>()

      for (const entry of providerPlans[provider]) {
        const previousSkillName = seenExportNames.get(entry.exportName)
        if (previousSkillName) {
          issues.push({
            severity: 'error',
            code: 'duplicate-export-name',
            message: `Export name "${entry.exportName}" is used by both "${previousSkillName}" and "${entry.skillName}".`,
            skillName: entry.skillName,
            provider,
          })
          continue
        }

        seenExportNames.set(entry.exportName, entry.skillName)
      }

      providerPlans[provider].sort((left, right) =>
        left.exportName.localeCompare(right.exportName),
      )
    }

    return {
      discoveredSkills: sortStrings(discoveredSkills),
      issues: sortIssues(issues),
      providerPlans,
    }
  }

  private async syncProvider(
    provider: SkillTargetProvider,
    targetRoot: string,
    plannedExports: PlannedProviderExport[],
  ): Promise<SkillSyncProviderResult> {
    await mkdir(targetRoot, { recursive: true })

    const manifest = await loadManifest(targetRoot)
    const desiredExportNames = plannedExports.map((entry) => entry.exportName)
    const removedExports: string[] = []
    let changed = false

    for (const exportName of manifest.managedExports) {
      if (desiredExportNames.includes(exportName)) {
        continue
      }

      await rm(path.join(targetRoot, exportName), {
        recursive: true,
        force: true,
      })
      removedExports.push(exportName)
      changed = true
    }

    for (const plannedExport of plannedExports) {
      const exportChanged = await this.syncExportDirectory(
        path.join(targetRoot, plannedExport.exportName),
        plannedExport.files,
      )
      changed = changed || exportChanged
    }

    await writeManifest(targetRoot, desiredExportNames)
    if (
      !changed &&
      JSON.stringify(manifest.managedExports) !== JSON.stringify(sortStrings(desiredExportNames))
    ) {
      changed = true
    }

    return {
      provider,
      targetRoot,
      syncedExports: desiredExportNames,
      removedExports: removedExports.sort((left, right) => left.localeCompare(right)),
      changed,
      skipped: false,
    }
  }

  private async syncExportDirectory(
    targetDirectory: string,
    desiredFiles: Map<string, string>,
  ): Promise<boolean> {
    const existingFiles = (await pathExists(targetDirectory))
      ? await listFilesRecursive(targetDirectory)
      : {
          files: new Map<string, string>(),
          directories: [],
        }
    let changed = false

    await mkdir(targetDirectory, { recursive: true })

    for (const [relativePath, sourcePath] of desiredFiles.entries()) {
      const targetPath = path.join(targetDirectory, ...relativePath.split('/'))
      const matches = await compareFileContents(sourcePath, targetPath)

      if (matches) {
        continue
      }

      await mkdir(path.dirname(targetPath), { recursive: true })
      await writeFile(targetPath, await readFile(sourcePath))
      changed = true
    }

    for (const [relativePath, existingPath] of existingFiles.files.entries()) {
      if (desiredFiles.has(relativePath)) {
        continue
      }

      await rm(existingPath, { force: true })
      changed = true
    }

    if (changed || existingFiles.directories.length > 0) {
      await removeEmptyDirectories(targetDirectory)
    }

    return changed
  }
}
