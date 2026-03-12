export const SKILL_TARGET_PROVIDERS = ['codex', 'claude'] as const

export type SkillTargetProvider = (typeof SKILL_TARGET_PROVIDERS)[number]

export const SKILL_SYNC_ROOTS = ['library', 'codex', 'claude'] as const

export type SkillSyncRoot = (typeof SKILL_SYNC_ROOTS)[number]

export interface SkillLibraryProviderSettings {
  targetRoot: string
}

export interface SkillLibrarySettings {
  libraryRoot: string
  providers: Record<SkillTargetProvider, SkillLibraryProviderSettings>
  autoSyncOnAppStart: boolean
}

export type SkillSyncIssueSeverity = 'error' | 'warning'

export interface SkillSyncIssue {
  severity: SkillSyncIssueSeverity
  code: string
  message: string
  skillName?: string
  root?: SkillSyncRoot
}

export interface SkillConflictRootVersion {
  root: SkillSyncRoot
  rootPath: string
  modifiedAt: string
  fileCount: number
}

export interface SkillConflict {
  skillName: string
  recommendedRoot: SkillSyncRoot | null
  differingFiles: string[]
  roots: SkillConflictRootVersion[]
}

export interface SkillSyncRootStatus {
  root: SkillSyncRoot
  configured: boolean
  rootPath: string
  skillNames: string[]
}

export interface SkillSyncRootResult {
  root: SkillSyncRoot
  rootPath: string
  synchronizedSkills: string[]
  changedSkills: string[]
  changed: boolean
  skipped: boolean
  message?: string
}

export interface SkillSyncResult {
  startedAt: string
  completedAt: string
  success: boolean
  issues: SkillSyncIssue[]
  conflicts: SkillConflict[]
  synchronizedSkills: string[]
  roots: SkillSyncRootResult[]
}

export interface SkillSyncStatus {
  issues: SkillSyncIssue[]
  conflicts: SkillConflict[]
  roots: SkillSyncRootStatus[]
  lastSyncResult: SkillSyncResult | null
}
