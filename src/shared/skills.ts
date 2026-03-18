export const SKILL_AI_MERGE_AGENTS = ['codex', 'claude', 'copilot'] as const

export type SkillAiMergeAgent = (typeof SKILL_AI_MERGE_AGENTS)[number]

export const SKILL_AI_REVIEW_AGENTS = ['none', ...SKILL_AI_MERGE_AGENTS] as const

export type SkillAiReviewAgent = (typeof SKILL_AI_REVIEW_AGENTS)[number]

export const SKILL_SYNC_ROOTS = ['library', 'discovered'] as const

export type SkillSyncRoot = (typeof SKILL_SYNC_ROOTS)[number]

export interface SkillLibrarySettings {
  libraryRoot: string
  autoSyncOnAppStart: boolean
  primaryMergeAgent: SkillAiMergeAgent
  reviewMergeAgent: SkillAiReviewAgent
}

export type SkillSyncIssueSeverity = 'error' | 'warning'

export interface SkillSyncIssue {
  severity: SkillSyncIssueSeverity
  code: string
  message: string
  skillName?: string
  root?: SkillSyncRoot
  rootLabel?: string
}

export interface SkillConflictRootVersion {
  root: SkillSyncRoot
  label: string
  rootPath: string
  modifiedAt: string
  fileCount: number
}

export interface SkillConflict {
  skillName: string
  recommendedRoot: SkillSyncRoot | null
  recommendedRootLabel: string | null
  differingFiles: string[]
  roots: SkillConflictRootVersion[]
}

export interface SkillAiMergeFile {
  path: string
  content: string
}

export type SkillAiMergeReviewStatus =
  | 'approved'
  | 'approved-with-warnings'
  | 'changes-requested'

export interface SkillAiMergeReview {
  reviewer: SkillAiMergeAgent
  reviewedAt: string
  status: SkillAiMergeReviewStatus
  summary: string
  rationale: string
  warnings: string[]
}

export interface SkillAiMergeProposal {
  skillName: string
  mergeAgent: SkillAiMergeAgent
  generatedAt: string
  summary: string
  rationale: string
  warnings: string[]
  sourceRoots: SkillSyncRoot[]
  files: SkillAiMergeFile[]
  review: SkillAiMergeReview | null
}

export interface SkillSyncRootStatus {
  root: SkillSyncRoot
  label: string
  configured: boolean
  rootPath: string
  skillNames: string[]
  folderCount?: number
  message?: string
}

export interface SkillSyncRootResult {
  root: SkillSyncRoot
  label: string
  rootPath: string
  synchronizedSkills: string[]
  changedSkills: string[]
  changed: boolean
  skipped: boolean
  message?: string
  folderCount?: number
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

export type FullSyncStepId =
  | 'scan-codex'
  | 'scan-claude'
  | 'compare'
  | 'ai-merge'
  | 'review'
  | 'apply-merge'
  | 'sync-back'
  | 'backup'

export type FullSyncStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error'

export interface FullSyncStep {
  id: FullSyncStepId
  label: string
  status: FullSyncStepStatus
  detail?: string
}

export type FullSyncLogLevel = 'info' | 'success' | 'warning' | 'error'

export interface FullSyncLogEntry {
  id: string
  timestamp: string
  stepId: FullSyncStepId | null
  level: FullSyncLogLevel
  message: string
}

export interface FullSyncProgress {
  steps: FullSyncStep[]
  currentStepId: FullSyncStepId | null
  done: boolean
  logs: FullSyncLogEntry[]
  error?: string
}

export interface FullSyncDone {
  success: boolean
  summary: string
  steps: FullSyncStep[]
  logs: FullSyncLogEntry[]
}

export interface FullSyncState {
  running: boolean
  progress: FullSyncProgress | null
  result: FullSyncDone | null
}
