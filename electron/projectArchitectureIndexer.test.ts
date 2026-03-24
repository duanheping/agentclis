// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { indexProjectArchitecture } from './projectArchitectureIndexer'

const tempRoots: string[] = []

async function createArchitectureFixture(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-arch-index-'))
  tempRoots.push(repoRoot)

  const files = new Map<string, string>([
    ['src/App.tsx', "import { SessionSidebar } from './components/SessionSidebar'\nimport { TerminalWorkspace } from './components/TerminalWorkspace'\nimport { useSessionsStore } from './store/useSessionsStore'\nexport default function App() { return SessionSidebar && TerminalWorkspace && useSessionsStore ? null : null }\n"],
    ['src/App.test.tsx', 'export {}\n'],
    ['src/components/SessionSidebar.tsx', 'export function SessionSidebar() { return null }\n'],
    ['src/components/SessionSidebar.test.tsx', 'export {}\n'],
    ['src/components/TerminalWorkspace.tsx', 'export function TerminalWorkspace() { return null }\n'],
    ['src/components/TerminalWorkspace.test.tsx', 'export {}\n'],
    ['src/store/useSessionsStore.ts', 'export const useSessionsStore = {}\n'],
    ['src/shared/ipc.ts', 'export const IPC_CHANNELS = {}\nexport interface AgentCliApi {}\n'],
    ['src/shared/session.ts', 'export interface SessionConfig {}\nexport function buildRuntime() { return null }\n'],
    ['src/shared/projectMemory.ts', 'export interface AssembledProjectContext {}\n'],
    ['src/shared/projectArchitecture.ts', 'export interface ProjectArchitectureSnapshot {}\n'],
    ['electron/preload.ts', "import { IPC_CHANNELS } from '../src/shared/ipc'\nexport const api = { IPC_CHANNELS }\n"],
    ['electron/main.ts', "import { IPC_CHANNELS } from '../src/shared/ipc'\nimport { SessionManager } from './sessionManager'\nimport { ProjectMemoryService } from './projectMemoryService'\nimport { SkillLibraryManager } from './skillLibraryManager'\nexport function registerIpcHandlers() { return { IPC_CHANNELS, SessionManager, ProjectMemoryService, SkillLibraryManager } }\n"],
    ['electron/sessionManager.ts', "import { TranscriptStore } from './transcriptStore'\nimport { ProjectMemoryService } from './projectMemoryService'\nexport class SessionManager { transcriptStore?: TranscriptStore; projectMemory?: ProjectMemoryService }\n"],
    ['electron/sessionManager.test.ts', 'export {}\n'],
    ['electron/transcriptStore.ts', 'export class TranscriptStore {}\n'],
    ['electron/transcriptStore.test.ts', 'export {}\n'],
    ['electron/projectMemoryService.ts', "import { ProjectMemoryManager } from './projectMemoryManager'\nexport class ProjectMemoryService { manager?: ProjectMemoryManager }\n"],
    ['electron/projectMemoryService.test.ts', 'export {}\n'],
    ['electron/projectMemoryManager.ts', "import { ProjectMemoryAgentExtractor } from './projectMemoryAgent'\nexport class ProjectMemoryManager { extractor?: ProjectMemoryAgentExtractor }\n"],
    ['electron/projectMemoryManager.test.ts', 'export {}\n'],
    ['electron/projectMemoryAgent.ts', 'export class ProjectMemoryAgentExtractor {}\n'],
    ['electron/projectMemoryAgent.test.ts', 'export {}\n'],
    ['electron/skillLibraryManager.ts', 'export class SkillLibraryManager {}\n'],
    ['electron/skillLibraryManager.test.ts', 'export {}\n'],
    ['electron/windowsCommandPromptManager.ts', 'export class WindowsCommandPromptManager {}\n'],
  ])

  await Promise.all(
    Array.from(files.entries()).map(async ([relativePath, content]) => {
      const filePath = path.join(repoRoot, relativePath)
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, content, 'utf8')
    }),
  )

  return repoRoot
}

describe('projectArchitectureIndexer', () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((tempRoot) =>
        rm(tempRoot, { recursive: true, force: true })
      ),
    )
  })

  it('indexes module cards and interactions from a repo-like layout', async () => {
    const repoRoot = await createArchitectureFixture()

    const snapshot = await indexProjectArchitecture({
      projectId: 'remote-github.com-openai-agenclis',
      title: 'agenclis',
      rootPath: repoRoot,
    })

    expect(snapshot).not.toBeNull()
    expect(snapshot?.systemOverview).toContain('React renderer')
    expect(snapshot?.modules.map((module) => module.id)).toEqual(
      expect.arrayContaining([
        'renderer-app-shell',
        'preload-bridge',
        'main-process-composition-root',
        'session-lifecycle-manager',
        'project-memory-queue',
        'project-memory-canonical-store',
      ]),
    )

    const rendererModule = snapshot?.modules.find(
      (module) => module.id === 'renderer-app-shell',
    )
    expect(rendererModule?.paths).toEqual(['src/App.tsx'])
    expect(rendererModule?.dependsOn).toEqual(
      expect.arrayContaining([
        'session-sidebar',
        'terminal-workspace',
        'renderer-session-store',
      ]),
    )

    const sharedContracts = snapshot?.modules.find(
      (module) => module.id === 'shared-contracts',
    )
    expect(sharedContracts?.publicInterfaces).toContain('IPC_CHANNELS')
    expect(sharedContracts?.paths.every((repoPath) => !repoPath.includes('\\'))).toBe(
      true,
    )

    expect(snapshot?.interactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'renderer-to-preload',
          via: 'window.agentCli',
        }),
        expect.objectContaining({
          id: 'session-to-project-memory-queue',
        }),
      ]),
    )
  })
})
