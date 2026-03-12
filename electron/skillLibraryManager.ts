import { createHash } from 'node:crypto'
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
  SKILL_SYNC_ROOTS,
  type SkillConflict,
  type SkillConflictRootVersion,
  type SkillLibrarySettings,
  type SkillSyncIssue,
  type SkillSyncResult,
  type SkillSyncRoot,
  type SkillSyncRootResult,
  type SkillSyncRootStatus,
  type SkillSyncStatus,
  type SkillTargetProvider,
} from '../src/shared/skills'

interface PersistedSkillLibraryState {
  settings: SkillLibrarySettings
  lastSyncResult: SkillSyncResult | null
}

interface SkillSnapshot {
  root: SkillSyncRoot
  rootPath: string
  skillName: string
  files: Map<string, Buffer>
  fileHashes: Map<string, string>
  fingerprint: string
  modifiedAt: string
  modifiedTimestamp: number
  fileCount: number
}

interface ScannedRoot {
  root: SkillSyncRoot
  configured: boolean
  rootPath: string
  skillNames: string[]
  syncable: boolean
  skipMessage?: string
  snapshots: Map<string, SkillSnapshot>
}

interface PlannedSkillSync {
  skillName: string
  source: SkillSnapshot
  targetRoots: SkillSyncRoot[]
}

interface SkillInspection {
  blockSync: boolean
  issues: SkillSyncIssue[]
  conflicts: SkillConflict[]
  rootStatuses: SkillSyncRootStatus[]
  scannedRoots: Map<SkillSyncRoot, ScannedRoot>
  plans: PlannedSkillSync[]
  snapshotsBySkill: Map<string, Map<SkillSyncRoot, SkillSnapshot>>
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

function normalizeLastSyncResult(
  value: unknown,
): SkillSyncResult | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<SkillSyncResult> & {
    roots?: unknown
  }

  return Array.isArray(candidate.roots)
    ? (structuredClone(candidate) as SkillSyncResult)
    : null
}

function normalizePersistedState(
  value: unknown,
): PersistedSkillLibraryState {
  const candidate = (value ?? {}) as Partial<PersistedSkillLibraryState>

  return {
    settings: normalizeSettings(candidate.settings ?? buildDefaultSettings()),
    lastSyncResult: normalizeLastSyncResult(candidate.lastSyncResult),
  }
}

function sortStrings(values: Iterable<string>): string[] {
  return Array.from(values).sort((left, right) => left.localeCompare(right))
}

function rootLabel(root: SkillSyncRoot): string {
  if (root === 'library') {
    return 'Library'
  }

  return root === 'codex' ? 'Codex' : 'Claude'
}

function buildRootPathMap(
  settings: SkillLibrarySettings,
): Record<SkillSyncRoot, string> {
  return {
    library: settings.libraryRoot,
    codex: settings.providers.codex.targetRoot,
    claude: settings.providers.claude.targetRoot,
  }
}

function sortIssues(issues: SkillSyncIssue[]): SkillSyncIssue[] {
  return [...issues].sort((left, right) => {
    const leftKey = [
      left.severity,
      left.root ?? '',
      left.skillName ?? '',
      left.code,
      left.message,
    ].join('|')
    const rightKey = [
      right.severity,
      right.root ?? '',
      right.skillName ?? '',
      right.code,
      right.message,
    ].join('|')

    return leftKey.localeCompare(rightKey)
  })
}

function sortConflicts(conflicts: SkillConflict[]): SkillConflict[] {
  return [...conflicts].sort((left, right) =>
    left.skillName.localeCompare(right.skillName),
  )
}

function toPublicStatus(
  scannedRoot: ScannedRoot,
): SkillSyncRootStatus {
  return {
    root: scannedRoot.root,
    configured: scannedRoot.configured,
    rootPath: scannedRoot.rootPath,
    skillNames: sortStrings(scannedRoot.skillNames),
  }
}

async function pathStat(targetPath: string) {
  try {
    return await stat(targetPath)
  } catch {
    return null
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  return (await pathStat(targetPath)) !== null
}

async function listSkillDirectories(rootPath: string): Promise<string[]> {
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

async function listFilesRecursive(rootPath: string): Promise<DirectoryFiles> {
  const files = new Map<string, string>()
  const directories = new Set<string>()

  async function visit(currentPath: string, relativePath = ''): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => [])

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

async function removeEmptyDirectories(rootPath: string): Promise<void> {
  if (!(await pathExists(rootPath))) {
    return
  }

  const entries = await readdir(rootPath, { withFileTypes: true }).catch(() => [])

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

function buildFingerprint(
  fileHashes: Map<string, string>,
): string {
  const hash = createHash('sha256')

  for (const relativePath of sortStrings(fileHashes.keys())) {
    hash.update(relativePath)
    hash.update('\0')
    hash.update(fileHashes.get(relativePath) ?? '')
    hash.update('\0')
  }

  return hash.digest('hex')
}

function buildConflict(
  skillName: string,
  snapshots: SkillSnapshot[],
): SkillConflict {
  const differingFiles = collectDifferingFiles(snapshots)

  return {
    skillName,
    recommendedRoot: recommendRoot(snapshots),
    differingFiles,
    roots: snapshots
      .map<SkillConflictRootVersion>((snapshot) => ({
        root: snapshot.root,
        rootPath: snapshot.rootPath,
        modifiedAt: snapshot.modifiedAt,
        fileCount: snapshot.fileCount,
      }))
      .sort((left, right) => left.root.localeCompare(right.root)),
  }
}

function collectDifferingFiles(snapshots: SkillSnapshot[]): string[] {
  const allPaths = new Set<string>()

  for (const snapshot of snapshots) {
    for (const relativePath of snapshot.fileHashes.keys()) {
      allPaths.add(relativePath)
    }
  }

  const differingFiles: string[] = []

  for (const relativePath of sortStrings(allPaths)) {
    const values = new Set<string>()

    for (const snapshot of snapshots) {
      values.add(snapshot.fileHashes.get(relativePath) ?? '__missing__')
    }

    if (values.size > 1) {
      differingFiles.push(relativePath)
    }
  }

  return differingFiles
}

function recommendRoot(
  snapshots: SkillSnapshot[],
): SkillSyncRoot | null {
  const snapshotsByFingerprint = new Map<string, SkillSnapshot[]>()

  for (const snapshot of snapshots) {
    const group = snapshotsByFingerprint.get(snapshot.fingerprint) ?? []
    group.push(snapshot)
    snapshotsByFingerprint.set(snapshot.fingerprint, group)
  }

  const rankedGroups = [...snapshotsByFingerprint.values()].sort((left, right) => {
    if (left.length !== right.length) {
      return right.length - left.length
    }

    return (
      Math.max(...right.map((snapshot) => snapshot.modifiedTimestamp)) -
      Math.max(...left.map((snapshot) => snapshot.modifiedTimestamp))
    )
  })

  const topGroup = rankedGroups[0]
  const secondGroup = rankedGroups[1]

  if (!topGroup) {
    return null
  }

  if (!secondGroup || topGroup.length > secondGroup.length) {
    return topGroup
      .slice()
      .sort((left, right) => right.modifiedTimestamp - left.modifiedTimestamp)[0]
      ?.root ?? null
  }

  return snapshots
    .slice()
    .sort((left, right) => right.modifiedTimestamp - left.modifiedTimestamp)[0]
    ?.root ?? null
}

async function readSkillSnapshot(
  root: SkillSyncRoot,
  rootPath: string,
  skillName: string,
): Promise<{ issues: SkillSyncIssue[]; snapshot: SkillSnapshot | null }> {
  const skillRoot = path.join(rootPath, skillName)
  const skillMdPath = path.join(skillRoot, 'SKILL.md')

  if (!(await pathExists(skillMdPath))) {
    return {
      issues: [
        {
          severity: 'warning',
          code: 'missing-skill-md',
          message: `${rootLabel(root)} copy is missing SKILL.md.`,
          root,
          skillName,
        },
      ],
      snapshot: null,
    }
  }

  const directoryFiles = await listFilesRecursive(skillRoot)
  const files = new Map<string, Buffer>()
  const fileHashes = new Map<string, string>()
  let modifiedTimestamp = 0

  try {
    for (const [relativePath, absolutePath] of directoryFiles.files.entries()) {
      const [content, fileStat] = await Promise.all([
        readFile(absolutePath),
        stat(absolutePath),
      ])

      files.set(relativePath, content)
      fileHashes.set(relativePath, createHash('sha256').update(content).digest('hex'))
      modifiedTimestamp = Math.max(modifiedTimestamp, fileStat.mtimeMs)
    }
  } catch (error) {
    return {
      issues: [
        {
          severity: 'error',
          code: 'skill-read-failed',
          message:
            error instanceof Error
              ? `Failed to read ${skillName}: ${error.message}`
              : `Failed to read ${skillName}.`,
          root,
          skillName,
        },
      ],
      snapshot: null,
    }
  }

  return {
    issues: [],
    snapshot: {
      root,
      rootPath,
      skillName,
      files,
      fileHashes,
      fingerprint: buildFingerprint(fileHashes),
      modifiedAt: new Date(modifiedTimestamp || Date.now()).toISOString(),
      modifiedTimestamp,
      fileCount: files.size,
    },
  }
}

async function compareFileContents(
  sourceContent: Buffer,
  targetPath: string,
): Promise<boolean> {
  try {
    const target = await readFile(targetPath)
    return sourceContent.equals(target)
  } catch {
    return false
  }
}

export class SkillLibraryManager {
  private readonly store = new Store<PersistedSkillLibraryState>({
    name: 'agenclis-skills',
    defaults: {
      settings: buildDefaultSettings(),
      lastSyncResult: null,
    },
  })

  constructor() {
    const normalizedState = normalizePersistedState(this.store.store)
    this.store.set(normalizedState)
  }

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
    const inspection = await this.inspectRoots()
    return {
      issues: inspection.issues,
      conflicts: inspection.conflicts,
      roots: inspection.rootStatuses,
      lastSyncResult: this.store.store.lastSyncResult,
    }
  }

  async sync(): Promise<SkillSyncResult> {
    const startedAt = new Date().toISOString()
    const inspection = await this.inspectRoots()
    const changedSkillsByRoot = this.initializeChangedSkillMap()

    if (!inspection.blockSync) {
      for (const plan of inspection.plans) {
        for (const root of plan.targetRoots) {
          const scannedRoot = inspection.scannedRoots.get(root)

          if (!scannedRoot?.syncable || !scannedRoot.rootPath) {
            continue
          }

          const changed = await this.syncSkillDirectory(
            path.join(scannedRoot.rootPath, plan.skillName),
            plan.source.files,
          )

          if (changed) {
            changedSkillsByRoot.get(root)?.add(plan.skillName)
          }
        }
      }
    }

    const result = await this.buildResult(
      startedAt,
      inspection,
      inspection.plans.map((plan) => plan.skillName),
      changedSkillsByRoot,
    )
    this.persistResult(result)
    return result
  }

  async resolveConflict(
    skillName: string,
    sourceRoot: SkillSyncRoot,
  ): Promise<SkillSyncResult> {
    const startedAt = new Date().toISOString()
    const inspection = await this.inspectRoots()

    if (inspection.blockSync) {
      const result = await this.buildResult(
        startedAt,
        inspection,
        [],
        this.initializeChangedSkillMap(),
      )
      this.persistResult(result)
      return result
    }

    const conflict = inspection.conflicts.find(
      (entry) => entry.skillName === skillName,
    )

    if (!conflict) {
      throw new Error(`No unresolved conflict was found for "${skillName}".`)
    }

    const snapshot = inspection.snapshotsBySkill.get(skillName)?.get(sourceRoot)
    if (!snapshot) {
      throw new Error(
        `${rootLabel(sourceRoot)} does not have a valid version of "${skillName}".`,
      )
    }

    const changedSkillsByRoot = this.initializeChangedSkillMap()

    for (const scannedRoot of inspection.scannedRoots.values()) {
      if (!scannedRoot.configured || !scannedRoot.syncable || !scannedRoot.rootPath) {
        continue
      }

      const changed = await this.syncSkillDirectory(
        path.join(scannedRoot.rootPath, skillName),
        snapshot.files,
      )

      if (changed) {
        changedSkillsByRoot.get(scannedRoot.root)?.add(skillName)
      }
    }

    const result = await this.buildResult(
      startedAt,
      inspection,
      [skillName],
      changedSkillsByRoot,
    )
    this.persistResult(result)
    return result
  }

  async syncOnAppStart(): Promise<SkillSyncResult | null> {
    const settings = this.getSettings()
    if (!settings.autoSyncOnAppStart) {
      return null
    }

    return this.sync()
  }

  private persistResult(result: SkillSyncResult): void {
    this.store.set({
      ...this.store.store,
      lastSyncResult: result,
    })
  }

  private initializeChangedSkillMap(): Map<SkillSyncRoot, Set<string>> {
    return new Map(
      SKILL_SYNC_ROOTS.map((root) => [root, new Set<string>()]),
    )
  }

  private async buildResult(
    startedAt: string,
    preInspection: SkillInspection,
    synchronizedSkills: string[],
    changedSkillsByRoot: Map<SkillSyncRoot, Set<string>>,
  ): Promise<SkillSyncResult> {
    const postInspection = await this.inspectRoots()
    const synchronizedSkillNames = sortStrings(new Set(synchronizedSkills))
    const roots = SKILL_SYNC_ROOTS.map((root) =>
      this.buildRootResult(
        root,
        preInspection.scannedRoots.get(root),
        synchronizedSkillNames,
        changedSkillsByRoot.get(root) ?? new Set<string>(),
      ),
    )

    return {
      startedAt,
      completedAt: new Date().toISOString(),
      success:
        !postInspection.issues.some((issue) => issue.severity === 'error') &&
        postInspection.conflicts.length === 0,
      issues: postInspection.issues,
      conflicts: postInspection.conflicts,
      synchronizedSkills: synchronizedSkillNames,
      roots,
    }
  }

  private buildRootResult(
    root: SkillSyncRoot,
    scannedRoot: ScannedRoot | undefined,
    synchronizedSkills: string[],
    changedSkills: Set<string>,
  ): SkillSyncRootResult {
    if (!scannedRoot?.configured) {
      return {
        root,
        rootPath: scannedRoot?.rootPath ?? '',
        synchronizedSkills: [],
        changedSkills: [],
        changed: false,
        skipped: true,
        message: 'Root is not configured.',
      }
    }

    if (!scannedRoot.syncable) {
      return {
        root,
        rootPath: scannedRoot.rootPath,
        synchronizedSkills: [],
        changedSkills: [],
        changed: false,
        skipped: true,
        message: scannedRoot.skipMessage ?? 'Root is unavailable.',
      }
    }

    return {
      root,
      rootPath: scannedRoot.rootPath,
      synchronizedSkills,
      changedSkills: sortStrings(changedSkills),
      changed: changedSkills.size > 0,
      skipped: false,
    }
  }

  private async inspectRoots(): Promise<SkillInspection> {
    const settings = this.getSettings()
    const issues: SkillSyncIssue[] = []
    const scannedRoots = new Map<SkillSyncRoot, ScannedRoot>()
    const rootPathMap = buildRootPathMap(settings)

    if (!settings.libraryRoot) {
      issues.push({
        severity: 'error',
        code: 'missing-library-root',
        message: 'Library root is not configured.',
        root: 'library',
      })
    }

    const scanned = await Promise.all(
      SKILL_SYNC_ROOTS.map((root) => this.scanRoot(root, rootPathMap[root])),
    )

    for (const scannedRoot of scanned) {
      scannedRoots.set(scannedRoot.root.root, scannedRoot.root)
      issues.push(...scannedRoot.issues)
    }

    if (SKILL_SYNC_ROOTS.every((root) => !scannedRoots.get(root)?.configured)) {
      issues.push({
        severity: 'error',
        code: 'no-configured-roots',
        message: 'Configure at least one skill root before syncing.',
      })
    }

    const snapshotsBySkill = new Map<string, Map<SkillSyncRoot, SkillSnapshot>>()
    const allSkillNames = new Set<string>()

    for (const scannedRoot of scannedRoots.values()) {
      for (const skillName of scannedRoot.skillNames) {
        allSkillNames.add(skillName)
      }

      for (const [skillName, snapshot] of scannedRoot.snapshots.entries()) {
        const entry = snapshotsBySkill.get(skillName) ?? new Map<SkillSyncRoot, SkillSnapshot>()
        entry.set(scannedRoot.root, snapshot)
        snapshotsBySkill.set(skillName, entry)
      }
    }

    const plans: PlannedSkillSync[] = []
    const conflicts: SkillConflict[] = []
    const targetRoots = SKILL_SYNC_ROOTS.filter((root) => {
      const scannedRoot = scannedRoots.get(root)
      return Boolean(scannedRoot?.configured && scannedRoot.syncable)
    })

    for (const skillName of sortStrings(allSkillNames)) {
      const validSnapshots = [...(snapshotsBySkill.get(skillName)?.values() ?? [])]

      if (validSnapshots.length === 0) {
        issues.push({
          severity: 'error',
          code: 'no-valid-skill-source',
          message: 'No valid SKILL.md version was found for this skill.',
          skillName,
        })
        continue
      }

      const uniqueFingerprints = new Set(
        validSnapshots.map((snapshot) => snapshot.fingerprint),
      )

      if (uniqueFingerprints.size === 1) {
        const source = validSnapshots
          .slice()
          .sort((left, right) => right.modifiedTimestamp - left.modifiedTimestamp)[0]!

        plans.push({
          skillName,
          source,
          targetRoots,
        })
        continue
      }

      conflicts.push(buildConflict(skillName, validSnapshots))
    }

    const libraryRoot = scannedRoots.get('library')
    const blockingIssueCodes = new Set([
      'missing-library-root',
      'no-configured-roots',
      'root-not-directory',
      'root-read-failed',
    ])
    const blockSync =
      issues.some(
        (issue) =>
          issue.severity === 'error' &&
          blockingIssueCodes.has(issue.code) &&
          (!issue.root || issue.root === 'library'),
      ) || !libraryRoot?.configured || !libraryRoot.syncable

    return {
      blockSync,
      issues: sortIssues(issues),
      conflicts: sortConflicts(conflicts),
      rootStatuses: SKILL_SYNC_ROOTS.map((root) =>
        toPublicStatus(
          scannedRoots.get(root) ?? {
            root,
            configured: false,
            rootPath: '',
            skillNames: [],
            syncable: false,
            snapshots: new Map<string, SkillSnapshot>(),
          },
        ),
      ),
      scannedRoots,
      plans,
      snapshotsBySkill,
    }
  }

  private async scanRoot(
    root: SkillSyncRoot,
    rootPath: string,
  ): Promise<{ issues: SkillSyncIssue[]; root: ScannedRoot }> {
    const configured = Boolean(rootPath)
    const scannedRoot: ScannedRoot = {
      root,
      configured,
      rootPath,
      skillNames: [],
      syncable: configured,
      snapshots: new Map<string, SkillSnapshot>(),
    }
    const issues: SkillSyncIssue[] = []

    if (!configured) {
      scannedRoot.syncable = false
      scannedRoot.skipMessage = 'Root is not configured.'
      return {
        issues,
        root: scannedRoot,
      }
    }

    const rootStat = await pathStat(rootPath)
    if (rootStat && !rootStat.isDirectory()) {
      scannedRoot.syncable = false
      scannedRoot.skipMessage = 'Configured path is not a directory.'
      issues.push({
        severity: 'error',
        code: 'root-not-directory',
        message: `${rootLabel(root)} root must point to a directory.`,
        root,
      })
      return {
        issues,
        root: scannedRoot,
      }
    }

    if (!rootStat) {
      return {
        issues,
        root: scannedRoot,
      }
    }

    let skillNames: string[]
    try {
      skillNames = await listSkillDirectories(rootPath)
    } catch (error) {
      scannedRoot.syncable = false
      scannedRoot.skipMessage = 'Failed to read the configured directory.'
      issues.push({
        severity: 'error',
        code: 'root-read-failed',
        message:
          error instanceof Error
            ? `Failed to read ${rootLabel(root)} root: ${error.message}`
            : `Failed to read ${rootLabel(root)} root.`,
        root,
      })
      return {
        issues,
        root: scannedRoot,
      }
    }

    scannedRoot.skillNames = skillNames

    for (const skillName of skillNames) {
      const snapshot = await readSkillSnapshot(root, rootPath, skillName)
      issues.push(...snapshot.issues)

      if (snapshot.snapshot) {
        scannedRoot.snapshots.set(skillName, snapshot.snapshot)
      }
    }

    return {
      issues,
      root: scannedRoot,
    }
  }

  private async syncSkillDirectory(
    targetDirectory: string,
    desiredFiles: Map<string, Buffer>,
  ): Promise<boolean> {
    await mkdir(targetDirectory, { recursive: true })

    const existingFiles = (await pathExists(targetDirectory))
      ? await listFilesRecursive(targetDirectory)
      : {
          files: new Map<string, string>(),
          directories: [],
        }
    let changed = false

    for (const [relativePath, content] of desiredFiles.entries()) {
      const targetPath = path.join(targetDirectory, ...relativePath.split('/'))

      if (await compareFileContents(content, targetPath)) {
        continue
      }

      await mkdir(path.dirname(targetPath), { recursive: true })
      await writeFile(targetPath, content)
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
