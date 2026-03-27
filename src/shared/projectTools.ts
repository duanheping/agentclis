export const PROJECT_OPEN_TARGETS = ['vscode', 'explorer', 'terminal'] as const

export type ProjectOpenTarget = (typeof PROJECT_OPEN_TARGETS)[number]

export const PROJECT_GIT_CHANGE_KINDS = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'untracked',
  'typechange',
  'conflicted',
] as const

export type ProjectGitChangeKind = (typeof PROJECT_GIT_CHANGE_KINDS)[number]

export interface ProjectGitFileChange {
  path: string
  previousPath?: string
  status: ProjectGitChangeKind
  additions: number
  deletions: number
  staged: boolean
}

export interface ProjectGitTotals {
  additions: number
  deletions: number
}

export interface ProjectGitOverview {
  projectPath: string
  isGitRepository: boolean
  repoRoot: string | null
  branch: string | null
  branches: string[]
  stagedFiles: ProjectGitFileChange[]
  unstagedFiles: ProjectGitFileChange[]
  stagedTotals: ProjectGitTotals
  unstagedTotals: ProjectGitTotals
}

export interface ProjectGitDiff {
  filePath: string
  staged: boolean
  patch: string
}
