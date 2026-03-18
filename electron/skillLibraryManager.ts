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
  type SkillAiMergeAgent,
  type SkillAiMergeProposal,
  type SkillAiReviewAgent,
  SKILL_AI_MERGE_AGENTS,
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
  type FullSyncStep,
  type FullSyncStepId,
  type FullSyncProgress,
  type FullSyncDone,
  type FullSyncLogEntry,
  type FullSyncLogLevel,
} from '../src/shared/skills'
import { generateSkillMerge, refineSkillMerge, reviewSkillMerge } from './skillMergeAgent'

interface PersistedSkillLibraryState {
  settings: SkillLibrarySettings
  lastSyncResult: SkillSyncResult | null
}

interface SkillSnapshot {
  root: SkillSyncRoot
  label: string
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
  label: string
  configured: boolean
  rootPath: string
  skillNames: string[]
  syncable: boolean
  skipMessage?: string
  folderCount?: number
  snapshots: Map<string, SkillSnapshot>
}

interface PlannedSkillSync {
  skillName: string
  source: SkillSnapshot
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

interface SyncDirectoryResult {
  changed: boolean
  writtenFiles: number
  removedFiles: number
  unchangedFiles: number
}

interface DiscoveredSkillDirectory {
  rootDirectory: string
  skillDirectory: string
  skillName: string
}

const HOME_SKILL_SCAN_ROOT = os.homedir()
const SKILL_SCAN_MAX_DEPTH = 8
const SKILL_SCAN_IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'AppData',
])
const KNOWN_SKILL_ROOT_SEGMENTS = [
  ['.codex', 'skills'],
  ['.claude', 'skills'],
  ['.copilot', 'skills'],
] as const

function buildDefaultSettings(): SkillLibrarySettings {
  return {
    libraryRoot: '',
    autoSyncOnAppStart: false,
    primaryMergeAgent: 'codex',
    reviewMergeAgent: 'none',
  }
}

function normalizeMergeAgent(value: unknown): SkillAiMergeAgent {
  return SKILL_AI_MERGE_AGENTS.includes(value as SkillAiMergeAgent)
    ? (value as SkillAiMergeAgent)
    : 'codex'
}

function normalizeReviewMergeAgent(
  value: unknown,
  primaryMergeAgent: SkillAiMergeAgent,
): SkillAiReviewAgent {
  if (value === 'none') {
    return 'none'
  }

  if (!SKILL_AI_MERGE_AGENTS.includes(value as SkillAiMergeAgent)) {
    return 'none'
  }

  return value === primaryMergeAgent ? 'none' : (value as SkillAiReviewAgent)
}

function normalizeSettings(
  settings: Partial<SkillLibrarySettings> | SkillLibrarySettings,
): SkillLibrarySettings {
  const primaryMergeAgent = normalizeMergeAgent(settings.primaryMergeAgent)

  return {
    libraryRoot:
      typeof settings.libraryRoot === 'string' ? settings.libraryRoot.trim() : '',
    autoSyncOnAppStart: Boolean(settings.autoSyncOnAppStart),
    primaryMergeAgent,
    reviewMergeAgent: normalizeReviewMergeAgent(
      settings.reviewMergeAgent,
      primaryMergeAgent,
    ),
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

  return 'Discovered folders'
}

function getSkillScanRoot(): string {
  const override = process.env.AGENCLIS_SKILL_SCAN_ROOT?.trim()
  return override || HOME_SKILL_SCAN_ROOT
}

function getKnownSkillRoots(scanRoot: string): string[] {
  return KNOWN_SKILL_ROOT_SEGMENTS.map((segments) => path.join(scanRoot, ...segments))
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
    label: scannedRoot.label,
    configured: scannedRoot.configured,
    rootPath: scannedRoot.rootPath,
    skillNames: sortStrings(scannedRoot.skillNames),
    folderCount: scannedRoot.folderCount,
    message: scannedRoot.skipMessage,
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

function toDisplayPath(targetPath: string): string {
  const homePath = getSkillScanRoot().replace(/[\\/]+$/, '')
  const normalizedTarget = targetPath.replace(/[\\/]+$/, '')

  if (normalizedTarget === homePath) {
    return homePath
  }

  if (normalizedTarget.startsWith(`${homePath}${path.sep}`)) {
    return `~${normalizedTarget.slice(homePath.length)}`
  }

  return targetPath
}

async function discoverSkillDirectories(
  rootPath: string,
): Promise<DiscoveredSkillDirectory[]> {
  const discovered = new Map<string, DiscoveredSkillDirectory>()

  async function visit(currentPath: string, depth: number): Promise<void> {
    if (depth > SKILL_SCAN_MAX_DEPTH) {
      return
    }

    const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => [])
    const hasSkillMd = entries.some(
      (entry) => entry.isFile() && entry.name === 'SKILL.md',
    )

    if (hasSkillMd) {
      const skillName = path.basename(currentPath)
      const rootDirectory = path.dirname(currentPath)
      discovered.set(currentPath, {
        rootDirectory,
        skillDirectory: currentPath,
        skillName,
      })
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      if (SKILL_SCAN_IGNORED_DIRECTORIES.has(entry.name)) {
        continue
      }

      await visit(path.join(currentPath, entry.name), depth + 1)
    }
  }

  await visit(rootPath, 0)

  return [...discovered.values()].sort((left, right) =>
    left.skillDirectory.localeCompare(right.skillDirectory),
  )
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
  const recommendedRoot = recommendRoot(snapshots)
  const recommendedSnapshot = recommendedRoot
    ? snapshots.find((snapshot) => snapshot.root === recommendedRoot) ?? null
    : null

  return {
    skillName,
    recommendedRoot,
    recommendedRootLabel: recommendedSnapshot?.label ?? null,
    differingFiles,
    roots: snapshots
      .map<SkillConflictRootVersion>((snapshot) => ({
        root: snapshot.root,
        label: snapshot.label,
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
  label: string,
  skillName: string,
  skillRoot = path.join(rootPath, skillName),
): Promise<{ issues: SkillSyncIssue[]; snapshot: SkillSnapshot | null }> {
  const skillMdPath = path.join(skillRoot, 'SKILL.md')

  if (!(await pathExists(skillMdPath))) {
    return {
      issues: [
        {
          severity: 'warning',
          code: 'missing-skill-md',
          message: `${label} is missing SKILL.md for "${skillName}".`,
          root,
          rootLabel: label,
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
          rootLabel: label,
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
      label,
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
      const libraryRoot = inspection.scannedRoots.get('library')

      for (const plan of inspection.plans) {
        if (!libraryRoot?.syncable || !libraryRoot.rootPath) {
          continue
        }

        const changed = await this.syncSkillDirectory(
          path.join(libraryRoot.rootPath, plan.skillName),
          plan.source.files,
        )

        if (changed.changed) {
          changedSkillsByRoot.get('library')?.add(plan.skillName)
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
    const libraryRoot = inspection.scannedRoots.get('library')

    if (sourceRoot !== 'library' && libraryRoot?.syncable && libraryRoot.rootPath) {
      const changed = await this.syncSkillDirectory(
        path.join(libraryRoot.rootPath, skillName),
        snapshot.files,
      )

      if (changed.changed) {
        changedSkillsByRoot.get('library')?.add(skillName)
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

  async generateAiMerge(skillName: string): Promise<SkillAiMergeProposal> {
    const inspection = await this.inspectRoots()
    const settings = this.getSettings()
    const conflict = inspection.conflicts.find(
      (entry) => entry.skillName === skillName,
    )

    if (!conflict) {
      throw new Error(`No unresolved conflict was found for "${skillName}".`)
    }

    const snapshots = this.buildMergeSources(inspection, skillName)

    if (snapshots.length < 2) {
      throw new Error(`At least two valid versions are required to AI-merge "${skillName}".`)
    }

    const proposal = await generateSkillMerge(
      settings.primaryMergeAgent,
      skillName,
      snapshots,
    )

    if (settings.reviewMergeAgent !== 'none') {
      proposal.review = await reviewSkillMerge(
        settings.reviewMergeAgent,
        proposal,
        snapshots,
      )
    }

    return proposal
  }

  async applyAiMerge(proposal: SkillAiMergeProposal): Promise<SkillSyncResult> {
    const startedAt = new Date().toISOString()
    const inspection = await this.inspectRoots()
    const changedSkillsByRoot = this.initializeChangedSkillMap()
    const desiredFiles = this.buildDesiredFilesFromProposal(proposal)
    const libraryRoot = inspection.scannedRoots.get('library')

    if (libraryRoot?.syncable && libraryRoot.rootPath) {
      const changed = await this.syncSkillDirectory(
        path.join(libraryRoot.rootPath, proposal.skillName),
        desiredFiles,
      )

      if (changed.changed) {
        changedSkillsByRoot.get('library')?.add(proposal.skillName)
      }
    }

    const result = await this.buildResult(
      startedAt,
      inspection,
      [proposal.skillName],
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

  async fullSync(
    onProgress: (progress: FullSyncProgress) => void,
  ): Promise<FullSyncDone> {
    const steps: FullSyncStep[] = [
      { id: 'scan-codex', label: 'Scan .codex/skills', status: 'pending' },
      { id: 'scan-claude', label: 'Scan .claude/skills', status: 'pending' },
      { id: 'compare', label: 'Compare skill versions', status: 'pending' },
      { id: 'ai-merge', label: 'Primary agent merges conflicting skills', status: 'pending' },
      { id: 'review', label: 'Secondary agent reviews merge proposal', status: 'pending' },
      { id: 'apply-merge', label: 'Apply merged skills to all roots', status: 'pending' },
      { id: 'sync-back', label: 'Sync back to .codex/skills and .claude/skills', status: 'pending' },
      { id: 'backup', label: 'Backup skills to library root', status: 'pending' },
    ]
    const logs: FullSyncLogEntry[] = []
    let logSequence = 0

    const emit = (currentStepId: FullSyncStepId | null, done = false, error?: string) => {
      onProgress({
        steps: structuredClone(steps),
        currentStepId,
        done,
        logs: structuredClone(logs),
        error,
      })
    }

    const setStep = (id: FullSyncStepId, status: FullSyncStep['status'], detail?: string) => {
      const step = steps.find((s) => s.id === id)
      if (step) {
        step.status = status
        if (detail !== undefined) step.detail = detail
      }
    }

    const addLog = (
      message: string,
      stepId: FullSyncStepId | null = null,
      level: FullSyncLogLevel = 'info',
    ) => {
      logs.push({
        id: `log-${++logSequence}`,
        timestamp: new Date().toISOString(),
        stepId,
        level,
        message,
      })
    }

    const describeSyncDirectoryResult = (result: SyncDirectoryResult): string => {
      const details = []

      if (result.writtenFiles > 0) {
        details.push(`${result.writtenFiles} file${result.writtenFiles === 1 ? '' : 's'} written`)
      }

      if (result.removedFiles > 0) {
        details.push(`${result.removedFiles} file${result.removedFiles === 1 ? '' : 's'} removed`)
      }

      if (result.unchangedFiles > 0) {
        details.push(`${result.unchangedFiles} unchanged`)
      }

      return details.join(', ') || 'already up to date'
    }

    addLog('Started full skill sync.', null, 'info')
    emit(null)

    try {
      const settings = this.getSettings()
      const scanRoot = getSkillScanRoot()

      // Step 1: Scan .codex/skills
      setStep('scan-codex', 'running')
      addLog('Scanning .codex/skills for available skills.', 'scan-codex')
      emit('scan-codex')
      const codexRoot = path.join(scanRoot, '.codex', 'skills')
      const codexExists = await pathExists(codexRoot)
      const codexSkills = codexExists ? await listSkillDirectories(codexRoot) : []
      const codexSnapshots = new Map<string, SkillSnapshot>()

       if (!codexExists) {
        addLog(`No .codex skills directory found at ${codexRoot}.`, 'scan-codex', 'warning')
        emit('scan-codex')
      }

      for (const skillName of codexSkills) {
        const result = await readSkillSnapshot('discovered', codexRoot, '.codex/skills', skillName)
        if (result.snapshot) {
          codexSnapshots.set(skillName, result.snapshot)
          addLog(
            `Loaded ${skillName} from .codex/skills (${result.snapshot.fileCount} files).`,
            'scan-codex',
            'success',
          )
        } else {
          addLog(`Skipped ${skillName} in .codex/skills because it could not be read.`, 'scan-codex', 'warning')
        }
        emit('scan-codex')
      }
      setStep('scan-codex', 'done', `Found ${codexSkills.length} skills`)
      addLog(`Finished scanning .codex/skills. Found ${codexSkills.length} skills.`, 'scan-codex', 'success')
      emit('scan-codex')

      // Step 2: Scan .claude/skills
      setStep('scan-claude', 'running')
      addLog('Scanning .claude/skills for available skills.', 'scan-claude')
      emit('scan-claude')
      const claudeRoot = path.join(scanRoot, '.claude', 'skills')
      const claudeExists = await pathExists(claudeRoot)
      const claudeSkills = claudeExists ? await listSkillDirectories(claudeRoot) : []
      const claudeSnapshots = new Map<string, SkillSnapshot>()

      if (!claudeExists) {
        addLog(`No .claude skills directory found at ${claudeRoot}.`, 'scan-claude', 'warning')
        emit('scan-claude')
      }

      for (const skillName of claudeSkills) {
        const result = await readSkillSnapshot('discovered', claudeRoot, '.claude/skills', skillName)
        if (result.snapshot) {
          claudeSnapshots.set(skillName, result.snapshot)
          addLog(
            `Loaded ${skillName} from .claude/skills (${result.snapshot.fileCount} files).`,
            'scan-claude',
            'success',
          )
        } else {
          addLog(`Skipped ${skillName} in .claude/skills because it could not be read.`, 'scan-claude', 'warning')
        }
        emit('scan-claude')
      }
      setStep('scan-claude', 'done', `Found ${claudeSkills.length} skills`)
      addLog(`Finished scanning .claude/skills. Found ${claudeSkills.length} skills.`, 'scan-claude', 'success')
      emit('scan-claude')

      // Step 3: Compare
      setStep('compare', 'running')
      addLog('Comparing skill versions across .codex and .claude.', 'compare')
      emit('compare')
      const allSkillNames = sortStrings(new Set([...codexSkills, ...claudeSkills]))
      const identical: string[] = []
      const codexOnly: string[] = []
      const claudeOnly: string[] = []
      const conflicting: string[] = []

      for (const name of allSkillNames) {
        const codex = codexSnapshots.get(name)
        const claude = claudeSnapshots.get(name)
        if (codex && claude) {
          if (codex.fingerprint === claude.fingerprint) {
            identical.push(name)
          } else {
            conflicting.push(name)
            addLog(`Conflict detected for ${name}; both roots have different contents.`, 'compare', 'warning')
            emit('compare')
          }
        } else if (codex && !claude) {
          codexOnly.push(name)
          addLog(`${name} exists only in .codex/skills.`, 'compare')
          emit('compare')
        } else {
          claudeOnly.push(name)
          addLog(`${name} exists only in .claude/skills.`, 'compare')
          emit('compare')
        }
      }

      const compareDetail = [
        `${identical.length} identical`,
        `${codexOnly.length} codex-only`,
        `${claudeOnly.length} claude-only`,
        `${conflicting.length} conflicting`,
      ].join(', ')
      setStep('compare', 'done', compareDetail)
      addLog(`Comparison complete: ${compareDetail}.`, 'compare', 'success')
      emit('compare')

      // Step 4: AI merge conflicts
      if (conflicting.length > 0) {
        setStep('ai-merge', 'running')
        addLog(
          `Sending ${conflicting.length} conflicting skill${conflicting.length === 1 ? '' : 's'} to ${settings.primaryMergeAgent} for merge.`,
          'ai-merge',
        )
        emit('ai-merge')

        const mergedFiles = new Map<string, Map<string, Buffer>>()
        const proposals = new Map<string, import('../src/shared/skills').SkillAiMergeProposal>()
        const sourcesBySkill = new Map<string, Array<{ root: SkillSyncRoot; files: Map<string, Buffer> }>>()
        let mergeFallbacks = 0

        for (const skillName of conflicting) {
          const codex = codexSnapshots.get(skillName)
          const claude = claudeSnapshots.get(skillName)
          const sources = [
            codex ? { root: 'discovered' as SkillSyncRoot, files: codex.files } : null,
            claude ? { root: 'library' as SkillSyncRoot, files: claude.files } : null,
          ].filter(Boolean) as Array<{ root: SkillSyncRoot; files: Map<string, Buffer> }>

          sourcesBySkill.set(skillName, sources)

          try {
            addLog(`Generating merge proposal for ${skillName}.`, 'ai-merge')
            emit('ai-merge')
            const proposal = await generateSkillMerge(
              settings.primaryMergeAgent,
              skillName,
              sources,
            )
            proposals.set(skillName, proposal)
            addLog(
              `Created merge proposal for ${skillName} with ${proposal.files.length} file${proposal.files.length === 1 ? '' : 's'}.`,
              'ai-merge',
              'success',
            )
          } catch (error) {
            // If AI merge fails for a skill, fall back to the newer version
            const codexTs = codex?.modifiedTimestamp ?? 0
            const claudeTs = claude?.modifiedTimestamp ?? 0
            const useCodex = codexTs >= claudeTs
            mergedFiles.set(skillName, useCodex ? codex!.files : claude!.files)
            mergeFallbacks++
            addLog(
              `AI merge failed for ${skillName}; kept the newer ${useCodex ? '.codex/skills' : '.claude/skills'} copy (${error instanceof Error ? error.message : 'unknown error'}).`,
              'ai-merge',
              'warning',
            )
          }

          emit('ai-merge')
        }

        setStep(
          'ai-merge',
          'done',
          [
            `${proposals.size} merged`,
            mergeFallbacks > 0 ? `${mergeFallbacks} fallback${mergeFallbacks === 1 ? '' : 's'}` : null,
          ].filter(Boolean).join(', '),
        )
        addLog(
          `Primary merge step finished with ${proposals.size} proposal${proposals.size === 1 ? '' : 's'} and ${mergeFallbacks} fallback${mergeFallbacks === 1 ? '' : 's'}.`,
          'ai-merge',
          'success',
        )
        emit('ai-merge')

        // Step 5: Secondary agent reviews merge proposals
        if (settings.reviewMergeAgent !== 'none' && proposals.size > 0) {
          setStep('review', 'running')
          addLog(
            `Reviewing ${proposals.size} merge proposal${proposals.size === 1 ? '' : 's'} with ${settings.reviewMergeAgent}.`,
            'review',
          )
          emit('review')

          let approved = 0
          let refined = 0

          for (const [skillName, proposal] of proposals.entries()) {
            const sources = sourcesBySkill.get(skillName) ?? []

            try {
              addLog(`Requesting review for ${skillName}.`, 'review')
              emit('review')
              const review = await reviewSkillMerge(
                settings.reviewMergeAgent,
                proposal,
                sources,
              )
              proposal.review = review

              if (review.status === 'changes-requested') {
                // Secondary agent rejected — feed suggestions back to primary for a refined merge
                try {
                  addLog(`Reviewer requested changes for ${skillName}; refining the proposal.`, 'review', 'warning')
                  emit('review')
                  const refinedProposal = await refineSkillMerge(
                    settings.primaryMergeAgent,
                    proposal,
                    review,
                    sources,
                  )
                  proposals.set(skillName, refinedProposal)
                  refined++
                  addLog(`Refined the ${skillName} proposal after review feedback.`, 'review', 'success')
                } catch {
                  // If refinement fails, keep the original proposal
                  approved++
                  addLog(`Refinement failed for ${skillName}; keeping the original proposal.`, 'review', 'warning')
                }
              } else {
                // Approved or approved-with-warnings — use the proposal as-is
                approved++
                addLog(
                  `${skillName} review completed with status ${review.status}.`,
                  'review',
                  review.status === 'approved-with-warnings' ? 'warning' : 'success',
                )
              }
            } catch {
              // If review fails, use the proposal as-is
              approved++
              addLog(`Review failed for ${skillName}; using the original proposal.`, 'review', 'warning')
            }

            emit('review')
          }

          const reviewDetail = [
            `${approved} approved`,
            refined > 0 ? `${refined} refined after feedback` : null,
          ].filter(Boolean).join(', ')
          setStep('review', 'done', reviewDetail)
          addLog(`Review step complete: ${reviewDetail}.`, 'review', 'success')
          emit('review')
        } else if (proposals.size > 0) {
          setStep('review', 'skipped', 'No secondary agent configured')
          addLog('Skipped secondary review because no review agent is configured.', 'review')
          emit('review')
        } else {
          setStep('review', 'skipped', 'No proposals to review')
          addLog('Skipped secondary review because there were no merge proposals to review.', 'review')
          emit('review')
        }

        // Convert all final proposals to file maps
        for (const [skillName, proposal] of proposals.entries()) {
          const files = new Map<string, Buffer>()
          for (const file of proposal.files) {
            files.set(file.path, Buffer.from(file.content, 'utf8'))
          }
          mergedFiles.set(skillName, files)
        }

        // Step 6: Apply merged skills — write to both roots
        setStep('apply-merge', 'running')
        addLog(`Applying merged skills to .codex/skills and .claude/skills.`, 'apply-merge')
        emit('apply-merge')

        for (const [skillName, files] of mergedFiles.entries()) {
          const codexResult = await this.syncSkillDirectory(path.join(codexRoot, skillName), files)
          addLog(
            `Applied ${skillName} to .codex/skills: ${describeSyncDirectoryResult(codexResult)}.`,
            'apply-merge',
            codexResult.changed ? 'success' : 'info',
          )
          emit('apply-merge')
          const claudeResult = await this.syncSkillDirectory(path.join(claudeRoot, skillName), files)
          addLog(
            `Applied ${skillName} to .claude/skills: ${describeSyncDirectoryResult(claudeResult)}.`,
            'apply-merge',
            claudeResult.changed ? 'success' : 'info',
          )
          emit('apply-merge')
        }

        setStep('apply-merge', 'done', `Applied ${mergedFiles.size} merged skills`)
        addLog(`Finished applying ${mergedFiles.size} merged skill${mergedFiles.size === 1 ? '' : 's'}.`, 'apply-merge', 'success')
        emit('apply-merge')
      } else {
        setStep('ai-merge', 'skipped', 'No conflicts to merge')
        setStep('review', 'skipped', 'No conflicts to review')
        setStep('apply-merge', 'skipped', 'No merges to apply')
        addLog('No conflicts were found, so AI merge, review, and apply steps were skipped.', 'ai-merge')
        emit('ai-merge')
      }

      // Step 6: Sync back — copy skills only in one root to the other root
      setStep('sync-back', 'running')
      addLog('Syncing one-sided skills back across .codex/skills and .claude/skills.', 'sync-back')
      emit('sync-back')

      await mkdir(codexRoot, { recursive: true })
      await mkdir(claudeRoot, { recursive: true })

      for (const skillName of codexOnly) {
        const snapshot = codexSnapshots.get(skillName)
        if (snapshot) {
          const result = await this.syncSkillDirectory(path.join(claudeRoot, skillName), snapshot.files)
          addLog(
            `Copied ${skillName} from .codex/skills to .claude/skills: ${describeSyncDirectoryResult(result)}.`,
            'sync-back',
            result.changed ? 'success' : 'info',
          )
          emit('sync-back')
        }
      }
      for (const skillName of claudeOnly) {
        const snapshot = claudeSnapshots.get(skillName)
        if (snapshot) {
          const result = await this.syncSkillDirectory(path.join(codexRoot, skillName), snapshot.files)
          addLog(
            `Copied ${skillName} from .claude/skills to .codex/skills: ${describeSyncDirectoryResult(result)}.`,
            'sync-back',
            result.changed ? 'success' : 'info',
          )
          emit('sync-back')
        }
      }

      setStep('sync-back', 'done', `Synced ${codexOnly.length + claudeOnly.length} skills across roots`)
      addLog(
        `Sync-back step finished after reconciling ${codexOnly.length + claudeOnly.length} one-sided skill${codexOnly.length + claudeOnly.length === 1 ? '' : 's'}.`,
        'sync-back',
        'success',
      )
      emit('sync-back')

      // Step 7: Backup to library root
      setStep('backup', 'running')
      addLog('Backing up synchronized skills to the library root.', 'backup')
      emit('backup')

      if (settings.libraryRoot) {
        const librarySkillsRoot = path.join(settings.libraryRoot, 'skills')
        await mkdir(librarySkillsRoot, { recursive: true })
        addLog(`Library backup target: ${librarySkillsRoot}.`, 'backup')
        emit('backup')

        // Re-scan the now-synchronized codex root to get the authoritative set
        const finalSkills = await listSkillDirectories(codexRoot)
        for (const skillName of finalSkills) {
          const result = await readSkillSnapshot('discovered', codexRoot, '.codex/skills', skillName)
          if (result.snapshot) {
            const backupResult = await this.syncSkillDirectory(
              path.join(librarySkillsRoot, skillName),
              result.snapshot.files,
            )
            addLog(
              `Backed up ${skillName} to the library root: ${describeSyncDirectoryResult(backupResult)}.`,
              'backup',
              backupResult.changed ? 'success' : 'info',
            )
          } else {
            addLog(`Skipped backing up ${skillName} because the synchronized snapshot could not be read.`, 'backup', 'warning')
          }
          emit('backup')
        }

        setStep('backup', 'done', `Backed up ${finalSkills.length} skills to library root`)
        addLog(`Library backup complete for ${finalSkills.length} skill${finalSkills.length === 1 ? '' : 's'}.`, 'backup', 'success')
      } else {
        setStep('backup', 'skipped', 'Library root not configured')
        addLog('Skipped library backup because the library root is not configured.', 'backup', 'warning')
      }
      emit('backup')

      // Emit done
      addLog('Full skill sync completed successfully.', null, 'success')
      emit(null, true)

      const summary = [
        `Synced ${allSkillNames.length} skills`,
        conflicting.length > 0 ? `${conflicting.length} merged via AI` : null,
        codexOnly.length > 0 ? `${codexOnly.length} copied from codex to claude` : null,
        claudeOnly.length > 0 ? `${claudeOnly.length} copied from claude to codex` : null,
        settings.libraryRoot ? 'backed up to library' : null,
      ].filter(Boolean).join(', ')

      return {
        success: true,
        summary,
        steps: structuredClone(steps),
        logs: structuredClone(logs),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      const runningStep = steps.find((step) => step.status === 'running')?.id ?? null
      // Mark current running step as error
      for (const step of steps) {
        if (step.status === 'running') {
          step.status = 'error'
          step.detail = message
        }
      }
      addLog(`Full skill sync failed: ${message}`, runningStep, 'error')
      emit(null, true, message)

      return {
        success: false,
        summary: `Sync failed: ${message}`,
        steps: structuredClone(steps),
        logs: structuredClone(logs),
      }
    }
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

  private buildDesiredFilesFromProposal(
    proposal: SkillAiMergeProposal,
  ): Map<string, Buffer> {
    const files = new Map<string, Buffer>()

    for (const file of proposal.files) {
      const normalizedPath = file.path.replace(/\\/g, '/').replace(/^\/+/, '')
      if (!normalizedPath || normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
        throw new Error(`Invalid merged file path "${file.path}".`)
      }

      files.set(normalizedPath, Buffer.from(file.content, 'utf8'))
    }

    if (!files.has('SKILL.md')) {
      throw new Error('AI merge proposal must include SKILL.md.')
    }

    return files
  }

  private buildMergeSources(
    inspection: SkillInspection,
    skillName: string,
  ): Array<{ root: SkillSyncRoot; files: Map<string, Buffer> }> {
    return [...(inspection.snapshotsBySkill.get(skillName)?.values() ?? [])]
      .sort((left, right) => left.root.localeCompare(right.root))
      .map((snapshot) => ({
        root: snapshot.root,
        files: snapshot.files,
      }))
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
        label: scannedRoot?.label ?? rootLabel(root),
        rootPath: scannedRoot?.rootPath ?? '',
        synchronizedSkills: [],
        changedSkills: [],
        changed: false,
        skipped: true,
        message: scannedRoot?.skipMessage ?? 'Root is not configured.',
        folderCount: scannedRoot?.folderCount,
      }
    }

    if (!scannedRoot.syncable) {
      return {
        root,
        label: scannedRoot.label,
        rootPath: scannedRoot.rootPath,
        synchronizedSkills: [],
        changedSkills: [],
        changed: false,
        skipped: true,
        message: scannedRoot.skipMessage ?? 'Root is unavailable.',
        folderCount: scannedRoot.folderCount,
      }
    }

    if (root === 'discovered') {
      return {
        root,
        label: scannedRoot.label,
        rootPath: scannedRoot.rootPath,
        synchronizedSkills: [],
        changedSkills: [],
        changed: false,
        skipped: true,
        message:
          scannedRoot.skipMessage ??
          `Automatically scanned ${scannedRoot.folderCount ?? 0} known skill folders.`,
        folderCount: scannedRoot.folderCount,
      }
    }

    return {
      root,
      label: scannedRoot.label,
      rootPath: scannedRoot.rootPath,
      synchronizedSkills,
      changedSkills: sortStrings(changedSkills),
      changed: changedSkills.size > 0,
      skipped: false,
      folderCount: scannedRoot.folderCount,
    }
  }

  private async inspectRoots(): Promise<SkillInspection> {
    const settings = this.getSettings()
    const issues: SkillSyncIssue[] = []
    const scannedRoots = new Map<SkillSyncRoot, ScannedRoot>()

    if (!settings.libraryRoot) {
      issues.push({
        severity: 'error',
        code: 'missing-library-root',
        message: 'Library root is not configured.',
        root: 'library',
      })
    }

    const scanned = await Promise.all([
      this.scanLibraryRoot(settings.libraryRoot),
      this.scanDiscoveredRoot(getSkillScanRoot(), settings.libraryRoot),
    ])

    for (const scannedRoot of scanned) {
      scannedRoots.set(scannedRoot.root.root, scannedRoot.root)
      issues.push(...scannedRoot.issues)
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
        const librarySnapshot = snapshotsBySkill.get(skillName)?.get('library') ?? null

        if (!librarySnapshot || librarySnapshot.fingerprint !== source.fingerprint) {
          plans.push({
            skillName,
            source,
          })
        }
        continue
      }

      conflicts.push(buildConflict(skillName, validSnapshots))
    }

    const libraryRoot = scannedRoots.get('library')
    const blockingIssueCodes = new Set([
      'missing-library-root',
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
            label: rootLabel(root),
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

  private async scanLibraryRoot(
    rootPath: string,
  ): Promise<{ issues: SkillSyncIssue[]; root: ScannedRoot }> {
    const configured = Boolean(rootPath)
    const scannedRoot: ScannedRoot = {
      root: 'library',
      label: rootLabel('library'),
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
        message: 'Library root must point to a directory.',
        root: 'library',
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
            ? `Failed to read Library root: ${error.message}`
            : 'Failed to read Library root.',
        root: 'library',
      })
      return {
        issues,
        root: scannedRoot,
      }
    }

    scannedRoot.skillNames = skillNames

    for (const skillName of skillNames) {
      const snapshot = await readSkillSnapshot(
        'library',
        rootPath,
        rootLabel('library'),
        skillName,
      )
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

  private async scanDiscoveredRoot(
    rootPath: string,
    libraryRootPath: string,
  ): Promise<{ issues: SkillSyncIssue[]; root: ScannedRoot }> {
    const normalizedLibraryRoot = libraryRootPath.replace(/[\\/]+$/, '')
    const discoveredSkillRoots = getKnownSkillRoots(rootPath)
    const discoveredDirectories = (
      await Promise.all(
        discoveredSkillRoots.map((skillRoot) => discoverSkillDirectories(skillRoot)),
      )
    ).flat()
    const discovered = discoveredDirectories.filter((entry) => {
      const normalizedSkillRoot = entry.skillDirectory.replace(/[\\/]+$/, '')
      const normalizedRootDirectory = entry.rootDirectory.replace(/[\\/]+$/, '')

      if (!normalizedLibraryRoot) {
        return true
      }

      return (
        normalizedSkillRoot !== normalizedLibraryRoot &&
        !normalizedSkillRoot.startsWith(`${normalizedLibraryRoot}${path.sep}`) &&
        normalizedRootDirectory !== normalizedLibraryRoot &&
        !normalizedRootDirectory.startsWith(`${normalizedLibraryRoot}${path.sep}`)
      )
    })
    const groupedBySkill = new Map<string, DiscoveredSkillDirectory[]>()

    for (const entry of discovered) {
      const group = groupedBySkill.get(entry.skillName) ?? []
      group.push(entry)
      groupedBySkill.set(entry.skillName, group)
    }

    const uniqueRootDirectories = new Set(
      discovered.map((entry) => entry.rootDirectory),
    )
    const scannedRoot: ScannedRoot = {
      root: 'discovered',
      label: rootLabel('discovered'),
      configured: discovered.length > 0,
      rootPath,
      skillNames: sortStrings(groupedBySkill.keys()),
      syncable: discovered.length > 0,
      skipMessage:
        discovered.length > 0
          ? `Automatically scanned ${uniqueRootDirectories.size} known skill folders.`
          : 'No skill folders were found in .codex/skills, .claude/skills, or .copilot/skills.',
      folderCount: uniqueRootDirectories.size,
      snapshots: new Map<string, SkillSnapshot>(),
    }
    const issues: SkillSyncIssue[] = []

    for (const [skillName, directories] of groupedBySkill.entries()) {
      const candidates: SkillSnapshot[] = []

      for (const directory of directories) {
        const snapshot = await readSkillSnapshot(
          'discovered',
          directory.rootDirectory,
          toDisplayPath(directory.rootDirectory),
          skillName,
          directory.skillDirectory,
        )
        issues.push(...snapshot.issues)

        if (snapshot.snapshot) {
          candidates.push(snapshot.snapshot)
        }
      }

      if (candidates.length === 0) {
        continue
      }

      candidates.sort((left, right) => right.modifiedTimestamp - left.modifiedTimestamp)
      scannedRoot.snapshots.set(skillName, candidates[0]!)

      if (candidates.length > 1) {
        issues.push({
          severity: 'warning',
          code: 'duplicate-discovered-skill',
          message: `Detected ${candidates.length} copies of "${skillName}" across .codex/skills, .claude/skills, or .copilot/skills. Using the newest copy from ${candidates[0]!.label}.`,
          skillName,
          root: 'discovered',
          rootLabel: rootLabel('discovered'),
        })
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
  ): Promise<SyncDirectoryResult> {
    await mkdir(targetDirectory, { recursive: true })

    const existingFiles = (await pathExists(targetDirectory))
      ? await listFilesRecursive(targetDirectory)
      : {
          files: new Map<string, string>(),
          directories: [],
        }
    let changed = false
    let writtenFiles = 0
    let removedFiles = 0
    let unchangedFiles = 0

    for (const [relativePath, content] of desiredFiles.entries()) {
      const targetPath = path.join(targetDirectory, ...relativePath.split('/'))

      if (await compareFileContents(content, targetPath)) {
        unchangedFiles++
        continue
      }

      await mkdir(path.dirname(targetPath), { recursive: true })
      await writeFile(targetPath, content)
      changed = true
      writtenFiles++
    }

    for (const [relativePath, existingPath] of existingFiles.files.entries()) {
      if (desiredFiles.has(relativePath)) {
        continue
      }

      await rm(existingPath, { force: true })
      changed = true
      removedFiles++
    }

    if (changed || existingFiles.directories.length > 0) {
      await removeEmptyDirectories(targetDirectory)
    }

    return {
      changed,
      writtenFiles,
      removedFiles,
      unchangedFiles,
    }
  }
}
