import type {
  CreateProjectInput,
  CreateSessionInput,
  ListSessionsResponse,
  ProjectSnapshot,
  SessionCloseResult,
  SessionConfigEvent,
  SessionDataEvent,
  SessionExitMeta,
  SessionRuntimeEvent,
  SessionSnapshot,
} from './session'
import type {
  ProjectGitDiff,
  ProjectGitFileChange,
  ProjectGitOverview,
  ProjectOpenTarget,
} from './projectTools'
import type {
  FullSyncDone,
  FullSyncProgress,
  FullSyncState,
  SkillAiMergeProposal,
  SkillLibrarySettings,
  SkillSyncResult,
  SkillSyncRoot,
  SkillSyncStatus,
} from './skills'

export interface PersistTransientFileInput {
  name?: string
  type?: string
  data: ArrayBuffer
}

export interface ProjectArchitectureAnalysisResult {
  analyzedProjectCount: number
}

export interface ProjectSessionsAnalysisResult {
  analyzedProjectCount: number
  analyzedSessionCount: number
  skippedSessionCount: number
  cleanedProjectCount: number
  removedEmptySummaryCount: number
  prunedCandidateCount: number
}

export interface SessionTerminalReplay {
  chunks: string[]
  source?: 'transcript' | 'snapshot'
  snapshot?: {
    format: 'text' | 'serialized'
    cols: number
    rows: number
    content: string
  }
}

export interface UpdateSessionTerminalSnapshotInput {
  sessionId: string
  text: string
  serialized?: string
  lineCount: number
  cols: number
  rows: number
  capturedAt: string
}

export const IPC_CHANNELS = {
  restoreSessions: 'session:restore',
  listSessions: 'session:list',
  getSessionTerminalReplay: 'session:terminal-replay',
  updateSessionTerminalSnapshot: 'session:terminal-snapshot-update',
  createProject: 'project:create',
  createSession: 'session:create',
  renameSession: 'session:rename',
  activateSession: 'session:activate',
  restartSession: 'session:restart',
  closeSession: 'session:close',
  writeToSession: 'session:write',
  resizeSession: 'session:resize',
  getSkillLibrarySettings: 'skills:get-settings',
  updateSkillLibrarySettings: 'skills:update-settings',
  analyzeProjectArchitecture: 'project-memory:analyze-architecture',
  analyzeProjectSessions: 'project-memory:analyze-sessions',
  openArchitectureAnalysisWindow: 'project-memory:open-architecture-analysis',
  openSessionsAnalysisWindow: 'project-memory:open-sessions-analysis',
  analysisTerminalData: 'analysis:terminal-data',
  analysisTerminalExit: 'analysis:terminal-exit',
  analysisTerminalWrite: 'analysis:terminal-write',
  analysisTerminalResize: 'analysis:terminal-resize',
  getSkillSyncStatus: 'skills:get-status',
  syncSkills: 'skills:sync',
  resolveSkillConflict: 'skills:resolve-conflict',
  generateSkillAiMerge: 'skills:generate-ai-merge',
  applySkillAiMerge: 'skills:apply-ai-merge',
  openSkillSyncWindow: 'skills:open-sync-window',
  startFullSync: 'skills:start-full-sync',
  getFullSyncState: 'skills:get-full-sync-state',
  fullSyncProgress: 'skills:full-sync-progress',
  fullSyncDone: 'skills:full-sync-done',
  persistTransientFile: 'file:persist-transient',
  pickDirectory: 'dialog:pick-directory',
  openPath: 'shell:open-path',
  openExternalLink: 'shell:open-external-link',
  openProject: 'project:open',
  getProjectGitOverview: 'project:git-overview',
  switchProjectGitBranch: 'project:git-switch-branch',
  getProjectGitDiff: 'project:git-diff',
  revertProjectGitFile: 'project:git-revert-file',
  openFileReference: 'shell:open-file-reference',
  listWindowsCommandPrompts: 'shell:list-windows-command-prompts',
  openWindowsCommandPrompt: 'shell:open-windows-command-prompt',
  closeWindowsCommandPrompt: 'shell:close-windows-command-prompt',
  writeToWindowsCommandPrompt: 'shell:write-windows-command-prompt',
  resizeWindowsCommandPrompt: 'shell:resize-windows-command-prompt',
  windowsCommandPromptData: 'shell:data-windows-command-prompt',
  windowsCommandPromptExit: 'shell:exit-windows-command-prompt',
  sessionData: 'session:data',
  sessionConfig: 'session:config',
  sessionRuntime: 'session:runtime',
  sessionExit: 'session:exit',
} as const

export interface AgentCliApi {
  restoreSessions(): Promise<ListSessionsResponse>
  listSessions(): Promise<ListSessionsResponse>
  getSessionTerminalReplay(sessionId: string): Promise<SessionTerminalReplay>
  updateSessionTerminalSnapshot(input: UpdateSessionTerminalSnapshotInput): void
  createProject(input: CreateProjectInput): Promise<ProjectSnapshot>
  createSession(input: CreateSessionInput): Promise<SessionSnapshot>
  renameSession(id: string, title: string): Promise<SessionSnapshot>
  activateSession(id: string): Promise<void>
  restartSession(id: string): Promise<SessionSnapshot>
  closeSession(id: string): Promise<SessionCloseResult>
  writeToSession(id: string, data: string): void
  resizeSession(id: string, cols: number, rows: number): Promise<void>
  getSkillLibrarySettings(): Promise<SkillLibrarySettings>
  updateSkillLibrarySettings(
    settings: SkillLibrarySettings,
  ): Promise<SkillLibrarySettings>
  analyzeProjectArchitecture(): Promise<ProjectArchitectureAnalysisResult>
  analyzeProjectSessions(): Promise<ProjectSessionsAnalysisResult>
  openArchitectureAnalysisWindow(): Promise<void>
  openSessionsAnalysisWindow(): Promise<void>
  onAnalysisTerminalData(listener: (event: { chunk: string }) => void): () => void
  onAnalysisTerminalExit(listener: (event: { exitCode: number; message: string }) => void): () => void
  writeToAnalysisTerminal(data: string): Promise<void>
  resizeAnalysisTerminal(cols: number, rows: number): Promise<void>
  getSkillSyncStatus(): Promise<SkillSyncStatus>
  syncSkills(): Promise<SkillSyncResult>
  resolveSkillConflict(
    skillName: string,
    sourceRoot: SkillSyncRoot,
  ): Promise<SkillSyncResult>
  generateSkillAiMerge(skillName: string): Promise<SkillAiMergeProposal>
  applySkillAiMerge(proposal: SkillAiMergeProposal): Promise<SkillSyncResult>
  openSkillSyncWindow(startSync?: boolean): Promise<void>
  startFullSync(): Promise<FullSyncState>
  getFullSyncState(): Promise<FullSyncState>
  onFullSyncProgress(listener: (event: FullSyncProgress) => void): () => void
  onFullSyncDone(listener: (event: FullSyncDone) => void): () => void
  persistTransientFile(input: PersistTransientFileInput): Promise<string>
  pickDirectory(defaultPath?: string): Promise<string | null>
  openPath(targetPath: string): Promise<void>
  openExternalLink(target: string): Promise<void>
  openProject(target: ProjectOpenTarget, projectPath: string): Promise<void>
  getProjectGitOverview(projectPath: string): Promise<ProjectGitOverview>
  switchProjectGitBranch(
    projectPath: string,
    branchName: string,
  ): Promise<ProjectGitOverview>
  getProjectGitDiff(
    projectPath: string,
    filePath: string,
    staged: boolean,
  ): Promise<ProjectGitDiff>
  revertProjectGitFile(
    projectPath: string,
    file: ProjectGitFileChange,
  ): Promise<void>
  openFileReference(target: string): Promise<void>
  getPathForFile(file: File): string
  listWindowsCommandPrompts(): Promise<string[]>
  openWindowsCommandPrompt(sessionId: string, cwd: string): Promise<void>
  closeWindowsCommandPrompt(sessionId: string): Promise<void>
  writeToWindowsCommandPrompt(sessionId: string, data: string): void
  resizeWindowsCommandPrompt(
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<void>
  onSessionData(listener: (event: SessionDataEvent) => void): () => void
  onSessionConfig(listener: (event: SessionConfigEvent) => void): () => void
  onSessionRuntime(listener: (event: SessionRuntimeEvent) => void): () => void
  onSessionExit(listener: (event: SessionExitMeta) => void): () => void
  onWindowsCommandPromptData(
    listener: (event: SessionDataEvent) => void,
  ): () => void
  onWindowsCommandPromptExit(
    listener: (event: SessionExitMeta) => void,
  ): () => void
}
