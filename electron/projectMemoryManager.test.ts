// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ProjectArchitectureSnapshot } from '../src/shared/projectArchitecture'
import type {
  ProjectLocation,
  TranscriptEvent,
} from '../src/shared/projectMemory'
import type { ProjectConfig, SessionConfig } from '../src/shared/session'
import { ProjectMemoryManager } from './projectMemoryManager'

const tempRoots: string[] = []

function buildProject(): ProjectConfig {
  return {
    id: 'project-1',
    title: 'agenclis',
    rootPath: 'C:\\repo\\agenclis',
    createdAt: '2026-03-22T12:00:00.000Z',
    updatedAt: '2026-03-22T12:00:00.000Z',
    primaryLocationId: 'location-1',
    identity: {
      repoRoot: 'C:\\repo\\agenclis',
      gitCommonDir: 'C:\\repo\\agenclis\\.git',
      remoteFingerprint: 'github.com/openai/agenclis',
    },
  }
}

function buildLocation(): ProjectLocation {
  return {
    id: 'location-1',
    projectId: 'project-1',
    rootPath: 'C:\\repo\\agenclis',
    repoRoot: 'C:\\repo\\agenclis',
    gitCommonDir: 'C:\\repo\\agenclis\\.git',
    remoteFingerprint: 'github.com/openai/agenclis',
    label: 'agenclis',
    createdAt: '2026-03-22T12:00:00.000Z',
    updatedAt: '2026-03-22T12:00:00.000Z',
    lastSeenAt: '2026-03-22T12:00:00.000Z',
  }
}

function buildLocationTwo(): ProjectLocation {
  return {
    id: 'location-2',
    projectId: 'project-1',
    rootPath: 'D:\\repo\\agenclis-copy',
    repoRoot: 'D:\\repo\\agenclis-copy',
    gitCommonDir: 'D:\\repo\\agenclis-copy\\.git',
    remoteFingerprint: 'github.com/openai/agenclis',
    label: 'agenclis-copy',
    createdAt: '2026-03-22T12:00:00.000Z',
    updatedAt: '2026-03-22T12:00:00.000Z',
    lastSeenAt: '2026-03-22T12:00:00.000Z',
  }
}

function buildProjectTwo(): ProjectConfig {
  return {
    id: 'project-2',
    title: 'agenclis-copy',
    rootPath: 'D:\\repo\\agenclis-copy',
    createdAt: '2026-03-22T12:05:00.000Z',
    updatedAt: '2026-03-22T12:05:00.000Z',
    primaryLocationId: 'location-2',
    identity: {
      repoRoot: 'D:\\repo\\agenclis-copy',
      gitCommonDir: 'D:\\repo\\agenclis-copy\\.git',
      remoteFingerprint: 'github.com/openai/agenclis',
    },
  }
}

function buildSourceLocation(): ProjectLocation {
  return {
    ...buildLocationTwo(),
    projectId: 'project-2',
  }
}

function buildSession(): SessionConfig {
  return {
    id: 'session-1',
    projectId: 'project-1',
    locationId: 'location-1',
    title: 'Codex',
    startupCommand: 'codex',
    pendingFirstPromptTitle: false,
    cwd: 'C:\\repo\\agenclis',
    shell: 'pwsh.exe',
    createdAt: '2026-03-22T12:00:00.000Z',
    updatedAt: '2026-03-22T12:00:00.000Z',
  }
}

function buildSessionTwo(): SessionConfig {
  return {
    ...buildSession(),
    id: 'session-2',
    projectId: 'project-2',
    locationId: 'location-2',
    cwd: 'D:\\repo\\agenclis-copy',
  }
}

function buildTranscript(): TranscriptEvent[] {
  return [
    {
      id: 'event-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      locationId: 'location-1',
      timestamp: '2026-03-22T12:00:00.000Z',
      kind: 'input',
      source: 'user',
      chunk: 'Implement project memory',
    },
    {
      id: 'event-2',
      sessionId: 'session-1',
      projectId: 'project-1',
      locationId: 'location-1',
      timestamp: '2026-03-22T12:00:05.000Z',
      kind: 'output',
      source: 'pty',
      chunk: '\u001b[32mPlanning changes\u001b[39m',
    },
  ]
}

function buildProjectAt(rootPath: string): ProjectConfig {
  return {
    ...buildProject(),
    rootPath,
    identity: {
      repoRoot: rootPath,
      gitCommonDir: path.join(rootPath, '.git'),
      remoteFingerprint: 'github.com/openai/agenclis',
    },
  }
}

function buildLocationAt(rootPath: string): ProjectLocation {
  return {
    ...buildLocation(),
    rootPath,
    repoRoot: rootPath,
    gitCommonDir: path.join(rootPath, '.git'),
  }
}

function buildSessionAt(rootPath: string): SessionConfig {
  return {
    ...buildSession(),
    cwd: rootPath,
  }
}

async function createArchitectureFixture(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-arch-fixture-'))
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
    ['src/shared/projectMemory.ts', 'export interface AssembledProjectContext {}\nexport interface ProjectMemorySnapshot {}\n'],
    ['src/shared/projectArchitecture.ts', 'export interface ProjectArchitectureSnapshot {}\n'],
    ['electron/preload.ts', "import { IPC_CHANNELS } from '../src/shared/ipc'\nexport const api = { IPC_CHANNELS }\n"],
    ['electron/main.ts', "import { IPC_CHANNELS } from '../src/shared/ipc'\nimport { SessionManager } from './sessionManager'\nimport { ProjectMemoryService } from './projectMemoryService'\nexport function registerIpcHandlers() { return { IPC_CHANNELS, SessionManager, ProjectMemoryService } }\n"],
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

describe('ProjectMemoryManager', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { recursive: true, force: true })))
  })

  it('writes canonical memory beneath a dot-prefixed namespace without machine-local paths', async () => {
    const libraryRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-library-'))
    tempRoots.push(libraryRoot)
    const repoRoot = await createArchitectureFixture()
    const manager = new ProjectMemoryManager(() => libraryRoot, {
      extract: async () => ({
        summary: 'Implemented the project memory pipeline.',
        candidates: [
          {
            kind: 'decision',
            scope: 'project',
            key: 'memory-pipeline',
            content: 'Project memory should be validated before promotion.',
            confidence: 0.92,
            sourceEventIds: ['event-1', 'event-2'],
          },
        ],
      }),
    })

    await manager.captureSession({
      project: buildProjectAt(repoRoot),
      location: buildLocationAt(repoRoot),
      session: buildSessionAt(repoRoot),
      transcript: buildTranscript(),
    })

    const memoryRoot = path.join(
      libraryRoot,
      '.agenclis-memory',
      'projects',
      'remote-github.com-openai-agenclis',
    )
    await expect(readFile(path.join(memoryRoot, 'memory.md'), 'utf8')).resolves.toContain(
      'Implemented the project memory pipeline.',
    )
    await expect(readFile(path.join(memoryRoot, 'architecture.md'), 'utf8')).resolves.toContain(
      'Renderer app shell',
    )
    await expect(readFile(path.join(memoryRoot, 'facts.json'), 'utf8')).resolves.toContain(
      'Canonical remote: github.com/openai/agenclis',
    )
    await expect(readFile(path.join(memoryRoot, 'project.json'), 'utf8')).resolves.toContain(
      '"repoRoot": null',
    )
    await expect(readFile(path.join(memoryRoot, 'project.json'), 'utf8')).resolves.toContain(
      '"gitCommonDir": null',
    )
  })

  it('writes focused memory docs and prefers synthesized architecture when an architecture extractor is configured', async () => {
    const libraryRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-library-'))
    tempRoots.push(libraryRoot)
    const repoRoot = await createArchitectureFixture()
    const synthesizedArchitecture: ProjectArchitectureSnapshot = {
      projectId: 'remote-github.com-openai-agenclis',
      title: 'agenclis',
      generatedAt: '2026-03-24T12:00:00.000Z',
      systemOverview:
        'Session work starts in the renderer, crosses the preload bridge, and is serialized by the main-process session coordinator.',
      modules: [
        {
          id: 'custom-session-coordinator',
          name: 'Session coordinator',
          kind: 'manager',
          paths: ['electron/sessionManager.ts'],
          responsibility: 'Owns session startup, bootstrap injection, and transcript-driven memory capture scheduling.',
          owns: ['session lifecycle', 'bootstrap injection'],
          dependsOn: [],
          usedBy: [],
          publicInterfaces: ['createSession', 'restoreSession'],
          keyTypes: ['SessionConfig'],
          invariants: ['Bootstrap runs before user task execution.'],
          changeGuidance: ['Keep bootstrap and capture ordering aligned.'],
          testLocations: ['electron/sessionManager.test.ts'],
          confidence: 0.97,
        },
      ],
      interactions: [
        {
          id: 'renderer-to-session-coordinator',
          from: 'renderer-app-shell',
          to: 'custom-session-coordinator',
          via: 'IPC bootstrap request',
          purpose: 'Starts or restores managed sessions with project context.',
          trigger: 'User opens or restores a session.',
          failureModes: ['Bootstrap omitted before first prompt'],
          notes: ['Main process serializes setup before terminal attach'],
        },
      ],
      invariants: [
        {
          id: 'bootstrap-before-input',
          statement: 'Project memory bootstrap must be injected before regular user input reaches a restored session.',
          relatedModules: ['custom-session-coordinator'],
        },
      ],
      glossary: [
        {
          term: 'bootstrap injection',
          meaning: 'System-authored context written into the session before the user task runs.',
        },
      ],
    }
    const manager = new ProjectMemoryManager(
      () => libraryRoot,
      {
        extract: async () => ({
          summary: 'Captured rich task-acceleration memory.',
          candidates: [
            {
              kind: 'troubleshooting-pattern',
              scope: 'project',
              key: 'bootstrap-race',
              content:
                'When project memory appeared missing on restored sessions, trace bootstrap injection order in electron/sessionManager.ts and confirm the system write happens before the first user prompt.',
              confidence: 0.94,
              sourceEventIds: ['event-1'],
            },
            {
              kind: 'user-assist-pattern',
              scope: 'project',
              key: 'ask-for-expectation-gap',
              content:
                'If generated memory feels shallow, ask the user which missing categories matter most and rebuild the docs around those categories instead of adding more generic summaries.',
              confidence: 0.92,
              sourceEventIds: ['event-1'],
            },
            {
              kind: 'component-workflow',
              scope: 'project',
              key: 'session-bootstrap-flow',
              content:
                'Session creation flows from renderer request to SessionManager, then into ProjectMemoryService. SessionManager injects the assembled bootstrap, starts transcript capture, and only then hands control to the terminal runtime.',
              confidence: 0.95,
              sourceEventIds: ['event-1', 'event-2'],
            },
            {
              kind: 'project-convention',
              scope: 'project',
              key: 'shared-contract-source-of-truth',
              content:
                'Keep cross-process contracts in src/shared and update renderer, preload, and main-process call sites together when an IPC surface changes.',
              confidence: 0.96,
              sourceEventIds: ['event-1'],
            },
            {
              kind: 'debug-approach',
              scope: 'project',
              key: 'session-bootstrap-debug',
              content:
                'Debug session bootstrap issues by reading assembleContext output, confirming the injected system message in SessionManager, and checking transcript capture order before changing UI behavior.',
              confidence: 0.93,
              sourceEventIds: ['event-2'],
            },
            {
              kind: 'critical-file',
              scope: 'project',
              key: 'electron-session-manager-ts',
              content:
                'electron/sessionManager.ts is the session orchestration spine: it restores sessions, writes bootstrap context, and coordinates transcript-backed memory capture.',
              confidence: 0.97,
              sourceEventIds: ['event-1'],
            },
          ],
        }),
      },
      {
        extract: async () => synthesizedArchitecture,
      },
    )

    await manager.captureSession({
      project: buildProjectAt(repoRoot),
      location: buildLocationAt(repoRoot),
      session: buildSessionAt(repoRoot),
      transcript: buildTranscript(),
    })

    const memoryRoot = path.join(
      libraryRoot,
      '.agenclis-memory',
      'projects',
      'remote-github.com-openai-agenclis',
    )

    await expect(readFile(path.join(memoryRoot, 'architecture.md'), 'utf8')).resolves.toContain(
      'Session coordinator',
    )
    await expect(readFile(path.join(memoryRoot, 'architecture.md'), 'utf8')).resolves.toContain(
      'bootstrap injection',
    )
    await expect(readFile(path.join(memoryRoot, 'troubleshooting.md'), 'utf8')).resolves.toContain(
      'bootstrap injection order',
    )
    await expect(readFile(path.join(memoryRoot, 'collaboration.md'), 'utf8')).resolves.toContain(
      'missing categories matter most',
    )
    await expect(
      readFile(path.join(memoryRoot, 'component-workflows.md'), 'utf8'),
    ).resolves.toContain('Session creation flows from renderer request to SessionManager')
    await expect(readFile(path.join(memoryRoot, 'conventions.md'), 'utf8')).resolves.toContain(
      'src/shared',
    )
    await expect(readFile(path.join(memoryRoot, 'debug-playbook.md'), 'utf8')).resolves.toContain(
      'assembleContext output',
    )
    await expect(readFile(path.join(memoryRoot, 'critical-files.md'), 'utf8')).resolves.toContain(
      'electron/sessionManager.ts',
    )
    await expect(readFile(path.join(memoryRoot, 'memory.md'), 'utf8')).resolves.toContain(
      '`troubleshooting.md`',
    )
  })

  it('assembles a short bootstrap context from canonical memory files', async () => {
    const libraryRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-library-'))
    tempRoots.push(libraryRoot)
    const repoRoot = await createArchitectureFixture()
    const manager = new ProjectMemoryManager(() => libraryRoot, {
      extract: async () => ({
        summary: 'Focused on session restore and memory injection.',
        candidates: [
          {
            kind: 'preference',
            scope: 'project',
            key: 'prefer-compact-ui',
            content: 'Prefer conservative UI changes.',
            confidence: 0.88,
            sourceEventIds: ['event-1'],
          },
          {
            kind: 'project-convention',
            scope: 'project',
            key: 'update-ipc-contracts-together',
            content:
              'When changing desktop actions, update src/shared/ipc.ts, electron/preload.ts, and electron/main.ts together to keep the IPC contract aligned.',
            confidence: 0.94,
            sourceEventIds: ['event-1'],
          },
          {
            kind: 'critical-file',
            scope: 'project',
            key: 'electron-project-memory-manager-ts',
            content:
              'electron/projectMemoryManager.ts assembles the bootstrap, writes the canonical memory artifacts, and chooses which memory is shown to the agent.',
            confidence: 0.93,
            sourceEventIds: ['event-1'],
          },
          {
            kind: 'component-workflow',
            scope: 'project',
            key: 'memory-bootstrap-flow',
            content:
              'ProjectMemoryService reads stored memory, ProjectMemoryManager assembles a query-aware bootstrap, and SessionManager injects that message before normal session output resumes.',
            confidence: 0.92,
            sourceEventIds: ['event-1'],
          },
        ],
      }),
    })

    await manager.captureSession({
      project: buildProjectAt(repoRoot),
      location: buildLocationAt(repoRoot),
      session: buildSessionAt(repoRoot),
      transcript: buildTranscript(),
    })

    const context = await manager.assembleContext({
      project: buildProjectAt(repoRoot),
      location: buildLocationAt(repoRoot),
      query: 'session restore preload ipc',
    })

    expect(context.bootstrapMessage).toContain('Use the project memory for this logical project')
    expect(context.bootstrapMessage).toContain('Architecture overview:')
    expect(context.bootstrapMessage).toContain('Project conventions:')
    expect(context.bootstrapMessage).toContain('Critical files:')
    expect(context.bootstrapMessage).toContain('Component workflows:')
    expect(context.bootstrapMessage).toContain('Relevant modules:')
    expect(context.bootstrapMessage).toContain('Session lifecycle manager')
    expect(context.bootstrapMessage).toContain('Current local checkout: agenclis')
    expect(context.fileReferences.some((filePath) => filePath.endsWith('architecture.md'))).toBe(
      true,
    )
    expect(context.fileReferences.some((filePath) => filePath.endsWith('conventions.md'))).toBe(
      true,
    )
    expect(context.architectureExcerpt).toContain(
      'Session lifecycle is centralized in SessionManager',
    )
    expect(context.fileReferences.every((filePath) => filePath.includes('.agenclis-memory'))).toBe(
      true,
    )
  })

  it('limits location-scoped memory to the matching checkout', async () => {
    const libraryRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-library-'))
    tempRoots.push(libraryRoot)
    const extractor = {
      extract: async (input: {
        project: ProjectConfig
        location: ProjectLocation | null
        session: SessionConfig
        transcript: TranscriptEvent[]
        normalizedTranscript: string
      }) => ({
        summary: 'Captured location-specific workflow guidance.',
        candidates:
          input.location?.id === 'location-2'
            ? [
                {
                  kind: 'workflow' as const,
                  scope: 'location' as const,
                  key: 'copy-worktree-bootstrap',
                  content: 'Use the local bootstrap script from the copy checkout.',
                  confidence: 0.86,
                  sourceEventIds: ['event-1'],
                },
              ]
            : [],
      }),
    }
    const manager = new ProjectMemoryManager(() => libraryRoot, extractor)

    await manager.captureSession({
      project: buildProject(),
      location: buildLocation(),
      session: buildSession(),
      transcript: buildTranscript(),
    })
    await manager.captureSession({
      project: buildProject(),
      location: buildLocationTwo(),
      session: {
        ...buildSession(),
        id: 'session-2',
        locationId: 'location-2',
        cwd: 'D:\\repo\\agenclis-copy',
      },
      transcript: buildTranscript().map((event) => ({
        ...event,
        sessionId: 'session-2',
        locationId: 'location-2',
      })),
    })

    const primaryContext = await manager.assembleContext({
      project: buildProject(),
      location: buildLocation(),
      query: 'bootstrap script',
    })
    const copyContext = await manager.assembleContext({
      project: buildProject(),
      location: buildLocationTwo(),
      query: 'bootstrap script',
    })

    expect(primaryContext.bootstrapMessage).not.toContain(
      'Use the local bootstrap script from the copy checkout.',
    )
    expect(copyContext.bootstrapMessage).toContain(
      'Use the local bootstrap script from the copy checkout.',
    )
  })

  it('stores different clone projects for the same remote in one shared memory directory', async () => {
    const libraryRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-library-'))
    tempRoots.push(libraryRoot)
    const manager = new ProjectMemoryManager(() => libraryRoot, {
      extract: async (input: {
        project: ProjectConfig
        location: ProjectLocation | null
        session: SessionConfig
        transcript: TranscriptEvent[]
        normalizedTranscript: string
      }) => ({
        summary:
          input.project.id === 'project-2'
            ? 'Captured workflows from the backup checkout.'
            : 'Captured workflows from the main checkout.',
        candidates: [
          {
            kind: 'decision' as const,
            scope: 'project' as const,
            key: input.project.id === 'project-2' ? 'backup-flow' : 'main-flow',
            content:
              input.project.id === 'project-2'
                ? 'Use the backup checkout for historical imports.'
                : 'Use the main checkout for active development.',
            confidence: 0.91,
            sourceEventIds: ['event-1'],
          },
        ],
      }),
    })

    await manager.captureSession({
      project: buildProject(),
      location: buildLocation(),
      session: buildSession(),
      transcript: buildTranscript(),
    })
    await manager.captureSession({
      project: buildProjectTwo(),
      location: buildSourceLocation(),
      session: buildSessionTwo(),
      transcript: buildTranscript().map((event) => ({
        ...event,
        sessionId: 'session-2',
        projectId: 'project-2',
        locationId: 'location-2',
      })),
    })
    const sharedRoot = path.join(
      libraryRoot,
      '.agenclis-memory',
      'projects',
      'remote-github.com-openai-agenclis',
    )

    await expect(readFile(path.join(sharedRoot, 'memory.md'), 'utf8')).resolves.toContain(
      'Use the backup checkout for historical imports.',
    )
    await expect(readFile(path.join(sharedRoot, 'memory.md'), 'utf8')).resolves.toContain(
      'Use the main checkout for active development.',
    )
    await expect(
      readFile(path.join(sharedRoot, 'summaries', 'session-2.json'), 'utf8'),
    ).resolves.toContain('"projectId": "project-2"')
    await expect(
      readFile(path.join(sharedRoot, 'project.json'), 'utf8'),
    ).resolves.toContain('"title": "agenclis"')
  })

  it('refreshes stored historical memory before transcript backfill', async () => {
    const libraryRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-library-'))
    tempRoots.push(libraryRoot)
    const repoRoot = await createArchitectureFixture()
    const manager = new ProjectMemoryManager(() => libraryRoot)
    const project = buildProjectAt(repoRoot)
    const memoryRoot = path.join(
      libraryRoot,
      '.agenclis-memory',
      'projects',
      'remote-github.com-openai-agenclis',
    )

    await mkdir(path.join(memoryRoot, 'summaries'), { recursive: true })
    await writeFile(
      path.join(memoryRoot, 'project.json'),
      JSON.stringify(
        {
          id: 'project-1',
          title: 'Workspace copy',
          createdAt: '2026-03-20T12:00:00.000Z',
          updatedAt: '2026-03-20T12:00:00.000Z',
          identity: {
            repoRoot,
            gitCommonDir: path.join(repoRoot, '.git'),
            remoteFingerprint: 'github.com/openai/agenclis',
          },
        },
        null,
        2,
      ),
      'utf8',
    )
    await writeFile(
      path.join(memoryRoot, 'summaries', 'session-empty.json'),
      JSON.stringify(
        {
          sessionId: 'session-empty',
          projectId: 'project-1',
          locationId: null,
          generatedAt: '2026-03-20T12:00:00.000Z',
          summary: 'This empty summary should be removed.',
          sourceEventIds: [],
        },
        null,
        2,
      ),
      'utf8',
    )
    await writeFile(
      path.join(memoryRoot, 'summaries', 'session-valid.json'),
      JSON.stringify(
        {
          sessionId: 'session-valid',
          projectId: 'project-1',
          locationId: null,
          generatedAt: '2026-03-21T12:00:00.000Z',
          summary: 'Historical import rebuilt the canonical latest summary.',
          sourceEventIds: Array.from({ length: 40 }, (_, index) => `event-${index + 1}`),
        },
        null,
        2,
      ),
      'utf8',
    )
    await writeFile(
      path.join(memoryRoot, 'summaries', 'latest.json'),
      JSON.stringify(
        {
          sessionId: 'latest-broken',
          projectId: 'project-1',
          locationId: null,
          generatedAt: '2026-03-22T12:00:00.000Z',
          summary: 'Broken latest summary.',
          sourceEventIds: [],
        },
        null,
        2,
      ),
      'utf8',
    )
    await writeFile(
      path.join(memoryRoot, 'facts.json'),
      JSON.stringify(
        [
          {
            id: 'fact-1',
            projectId: 'project-1',
            locationId: null,
            kind: 'fact',
            scope: 'project',
            key: 'default-agent-cli',
            content: 'Default managed CLI: codex',
            confidence: 0.92,
            status: 'active',
            createdAt: '2026-03-20T12:00:00.000Z',
            updatedAt: '2026-03-22T12:00:00.000Z',
            sourceSessionId: 'session-valid',
            sourceEventIds: Array.from({ length: 45 }, (_, index) => `fact-${index + 1}`),
          },
          {
            id: 'fact-2',
            projectId: 'project-1',
            locationId: null,
            kind: 'fact',
            scope: 'project',
            key: 'default-agent-cli',
            content: 'Default managed CLI: claude',
            confidence: 0.61,
            status: 'active',
            createdAt: '2026-03-20T12:00:00.000Z',
            updatedAt: '2026-03-21T12:00:00.000Z',
            sourceSessionId: 'session-valid',
            sourceEventIds: ['fact-dup'],
          },
          {
            id: 'fact-3',
            projectId: 'project-1',
            locationId: null,
            kind: 'fact',
            scope: 'project',
            key: 'branch',
            content: 'Current branch: fix/project-memory-import',
            confidence: 0.7,
            status: 'active',
            createdAt: '2026-03-20T12:00:00.000Z',
            updatedAt: '2026-03-20T12:00:00.000Z',
            sourceSessionId: 'session-valid',
            sourceEventIds: ['branch-1'],
          },
          {
            id: 'fact-4',
            projectId: 'project-1',
            locationId: null,
            kind: 'fact',
            scope: 'project',
            key: 'local-path',
            content: `Open ${repoRoot}\\src\\App.tsx when debugging the renderer.`,
            confidence: 0.7,
            status: 'active',
            createdAt: '2026-03-20T12:00:00.000Z',
            updatedAt: '2026-03-20T12:00:00.000Z',
            sourceSessionId: 'session-valid',
            sourceEventIds: ['path-1'],
          },
        ],
        null,
        2,
      ),
      'utf8',
    )
    await writeFile(path.join(memoryRoot, 'decisions.json'), '[]', 'utf8')
    await writeFile(path.join(memoryRoot, 'preferences.json'), '[]', 'utf8')
    await writeFile(path.join(memoryRoot, 'workflows.json'), '[]', 'utf8')

    await expect(manager.refreshHistoricalImport([project])).resolves.toEqual({
      cleanedProjectCount: 1,
      removedEmptySummaryCount: 2,
      prunedCandidateCount: 2,
      regeneratedArchitectureCount: 1,
    })

    const latestSummary = JSON.parse(
      await readFile(path.join(memoryRoot, 'summaries', 'latest.json'), 'utf8'),
    ) as {
      sessionId: string
      summary: string
      sourceEventIds: string[]
    }
    const facts = JSON.parse(
      await readFile(path.join(memoryRoot, 'facts.json'), 'utf8'),
    ) as Array<{
      content: string
      status: string
      sourceEventIds: string[]
    }>
    const projectRecord = JSON.parse(
      await readFile(path.join(memoryRoot, 'project.json'), 'utf8'),
    ) as {
      title: string
      identity: {
        repoRoot: string | null
        gitCommonDir: string | null
      }
    }

    expect(projectRecord.title).toBe('agenclis')
    expect(projectRecord.identity.repoRoot).toBeNull()
    expect(projectRecord.identity.gitCommonDir).toBeNull()
    expect(latestSummary.sessionId).toBe('session-valid')
    expect(latestSummary.summary).toContain('canonical latest summary')
    expect(latestSummary.sourceEventIds).toHaveLength(32)
    await expect(
      readFile(path.join(memoryRoot, 'summaries', 'session-empty.json'), 'utf8'),
    ).rejects.toThrow()
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: 'Default managed CLI: codex',
          status: 'active',
          sourceEventIds: expect.arrayContaining(['fact-1']),
        }),
        expect.objectContaining({
          content: 'Default managed CLI: claude',
          status: 'conflicted',
        }),
      ]),
    )
    expect(
      facts.some((candidate) => candidate.content.includes('Current branch:')),
    ).toBe(false)
    expect(
      facts.some((candidate) => candidate.content.includes(repoRoot)),
    ).toBe(false)
    await expect(readFile(path.join(memoryRoot, 'memory.md'), 'utf8')).resolves.toContain(
      'Historical import rebuilt the canonical latest summary.',
    )
    await expect(readFile(path.join(memoryRoot, 'memory.md'), 'utf8')).resolves.not.toContain(
      'Default managed CLI: claude',
    )
    await expect(
      readFile(path.join(memoryRoot, 'architecture.md'), 'utf8'),
    ).resolves.toContain('Renderer app shell')
    await expect(
      readFile(path.join(memoryRoot, 'architecture.json'), 'utf8'),
    ).resolves.toContain('Session lifecycle is centralized in SessionManager')
  })
})
