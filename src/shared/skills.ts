export const SKILL_TARGET_PROVIDERS = ['codex', 'claude'] as const

export type SkillTargetProvider = (typeof SKILL_TARGET_PROVIDERS)[number]

export interface SkillLibraryProviderSettings {
  targetRoot: string
}

export interface SkillLibrarySettings {
  libraryRoot: string
  providers: Record<SkillTargetProvider, SkillLibraryProviderSettings>
  autoSyncOnAppStart: boolean
}

export interface SkillDefinitionProviderOverride {
  exportName?: string
  disabled?: boolean
}

export interface SkillDefinitionOverride {
  allowOverlayOnly?: boolean
  providers?: Partial<Record<SkillTargetProvider, SkillDefinitionProviderOverride>>
}

export type SkillSyncIssueSeverity = 'error' | 'warning'

export interface SkillSyncIssue {
  severity: SkillSyncIssueSeverity
  code: string
  message: string
  skillName?: string
  provider?: SkillTargetProvider
}

export interface SkillSyncProviderStatus {
  provider: SkillTargetProvider
  configured: boolean
  plannedExports: string[]
}

export interface SkillSyncProviderResult {
  provider: SkillTargetProvider
  targetRoot: string
  syncedExports: string[]
  removedExports: string[]
  changed: boolean
  skipped: boolean
  message?: string
}

export interface SkillSyncResult {
  startedAt: string
  completedAt: string
  success: boolean
  issues: SkillSyncIssue[]
  providers: SkillSyncProviderResult[]
}

export interface SkillSyncStatus {
  discoveredSkills: string[]
  issues: SkillSyncIssue[]
  providers: SkillSyncProviderStatus[]
  lastSyncResult: SkillSyncResult | null
}
