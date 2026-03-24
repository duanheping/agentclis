import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import type {
  ArchitectureGlossaryTerm,
  ArchitectureInteraction,
  ArchitectureInvariant,
  ArchitectureModuleCard,
  ArchitectureModuleKind,
  ProjectArchitectureSnapshot,
} from '../src/shared/projectArchitecture'

interface ProjectArchitectureIndexInput {
  projectId: string
  title: string
  rootPath: string
}

interface ArchitectureModuleBlueprint {
  id: string
  name: string
  kind: ArchitectureModuleKind
  paths: string[]
  responsibility: string
  owns: string[]
  invariants: string[]
  changeGuidance: string[]
  testLocations?: string[]
}

interface InteractionBlueprint {
  id: string
  from: string
  to: string
  via: string
  purpose: string
  trigger: string
  failureModes: string[]
  notes: string[]
}

const SOURCE_DIRECTORIES = ['src', 'electron']
const SOURCE_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])

const MODULE_BLUEPRINTS: ArchitectureModuleBlueprint[] = [
  {
    id: 'renderer-app-shell',
    name: 'Renderer app shell',
    kind: 'renderer',
    paths: ['src/App.tsx'],
    responsibility:
      'Composes the main renderer workspace, drives session/project UI state, and calls the preload bridge for desktop actions.',
    owns: [
      'top-level layout',
      'settings actions',
      'project diff panel orchestration',
      'workspace hydration',
    ],
    invariants: [
      'The renderer should interact with Electron through window.agentCli rather than direct Node access.',
      'Top-level UI state stays in React state while shared session data lives in the Zustand store.',
    ],
    changeGuidance: [
      'When adding a new desktop action, update src/shared/ipc.ts, electron/preload.ts, and electron/main.ts in sync.',
      'Keep expensive background work out of the renderer hot path and surface only lightweight status.',
    ],
    testLocations: ['src/App.test.tsx'],
  },
  {
    id: 'session-sidebar',
    name: 'Session sidebar',
    kind: 'renderer',
    paths: ['src/components/SessionSidebar.tsx'],
    responsibility:
      'Renders project and session navigation, inline settings, and project-memory import/sync entry points.',
    owns: [
      'project/session list',
      'settings dialog',
      'session context actions',
    ],
    invariants: [
      'Settings actions are forwarded through callbacks from App rather than owning IPC directly.',
    ],
    changeGuidance: [
      'Keep settings actions declarative and route side effects through the parent component.',
    ],
    testLocations: ['src/components/SessionSidebar.test.tsx'],
  },
  {
    id: 'terminal-workspace',
    name: 'Terminal workspace',
    kind: 'renderer',
    paths: ['src/components/TerminalWorkspace.tsx'],
    responsibility:
      'Hosts the xterm instances, forwards user input, and resolves file or web links rendered in terminal output.',
    owns: [
      'terminal mounting',
      'terminal link handling',
      'clipboard/file paste helpers',
    ],
    invariants: [
      'Terminal click actions must use the preload bridge for shell or file opening.',
    ],
    changeGuidance: [
      'Keep renderer-only terminal concerns here and avoid moving Electron responsibilities into the component.',
    ],
    testLocations: ['src/components/TerminalWorkspace.test.tsx'],
  },
  {
    id: 'renderer-session-store',
    name: 'Renderer session store',
    kind: 'store',
    paths: ['src/store/useSessionsStore.ts'],
    responsibility:
      'Provides the canonical renderer-side project/session snapshot and targeted update helpers.',
    owns: [
      'hydrated session state',
      'active session selection',
      'config/runtime updates from main-process events',
    ],
    invariants: [
      'The store remains a normalized projection of the main-process snapshot instead of duplicating service logic.',
    ],
    changeGuidance: [
      'Add narrow update helpers rather than rebuilding store shape in many components.',
    ],
  },
  {
    id: 'shared-contracts',
    name: 'Shared contracts',
    kind: 'shared-contract',
    paths: [
      'src/shared/ipc.ts',
      'src/shared/session.ts',
      'src/shared/projectMemory.ts',
      'src/shared/projectArchitecture.ts',
    ],
    responsibility:
      'Defines renderer/Electron contracts, session data shapes, and project-memory architecture schemas shared across processes.',
    owns: [
      'IPC channel names',
      'session and runtime types',
      'project-memory schemas',
    ],
    invariants: [
      'Cross-process contracts must live in src/shared to avoid type drift between renderer and Electron.',
    ],
    changeGuidance: [
      'Any new IPC channel or project-memory artifact should be represented here before implementation code changes.',
    ],
  },
  {
    id: 'preload-bridge',
    name: 'Preload bridge',
    kind: 'preload-bridge',
    paths: ['electron/preload.ts'],
    responsibility:
      'Exposes the safe Agent CLI API surface to the renderer and wires renderer listeners to Electron IPC events.',
    owns: [
      'window.agentCli exposure',
      'renderer IPC listener helpers',
    ],
    invariants: [
      'Only the preload bridge should expose main-process capabilities to the renderer.',
    ],
    changeGuidance: [
      'Mirror every new AgentCliApi method with a matching preload implementation.',
    ],
  },
  {
    id: 'main-process-composition-root',
    name: 'Main process composition root',
    kind: 'main-process',
    paths: ['electron/main.ts'],
    responsibility:
      'Instantiates Electron services, creates BrowserWindows, and registers IPC handlers that compose the app.',
    owns: [
      'service construction',
      'window creation',
      'IPC handler registration',
    ],
    invariants: [
      'Long-lived service wiring belongs in the main process composition root rather than in renderer code.',
    ],
    changeGuidance: [
      'When introducing a new service, construct it here and keep IPC handlers as thin delegation layers.',
    ],
  },
  {
    id: 'session-lifecycle-manager',
    name: 'Session lifecycle manager',
    kind: 'manager',
    paths: ['electron/sessionManager.ts'],
    responsibility:
      'Owns project/session persistence, terminal lifecycle, transcript appends, and project-memory bootstrap/capture orchestration.',
    owns: [
      'project/session persistence',
      'active session restore',
      'terminal process lifecycle',
      'project-memory queue triggers',
    ],
    invariants: [
      'Session lifecycle, transcript appends, and bootstrap context attachment are centralized here.',
      'Project-memory capture should be queued or backgrounded rather than executed inline on the user hot path.',
    ],
    changeGuidance: [
      'Prefer adding new session-side effects via helper methods here rather than scattering them across main.ts.',
    ],
    testLocations: ['electron/sessionManager.test.ts'],
  },
  {
    id: 'transcript-persistence',
    name: 'Transcript persistence',
    kind: 'service',
    paths: ['electron/transcriptStore.ts'],
    responsibility:
      'Persists transcript events and transcript index files for later project-memory capture and historical import.',
    owns: [
      'jsonl transcript persistence',
      'transcript index files',
      'pending write serialization per session',
    ],
    invariants: [
      'Transcript reads must wait for pending writes to settle to avoid partial reads.',
    ],
    changeGuidance: [
      'Keep transcript persistence append-only and session-local to avoid cross-session coupling.',
    ],
    testLocations: ['electron/transcriptStore.test.ts'],
  },
  {
    id: 'project-memory-queue',
    name: 'Project memory queue',
    kind: 'service',
    paths: ['electron/projectMemoryService.ts'],
    responsibility:
      'Queues project-memory capture and backfill work, deduplicates jobs, retries failures, and records diagnostics.',
    owns: [
      'project-memory job queue',
      'retry policy',
      'diagnostics persistence',
    ],
    invariants: [
      'Project-memory extraction and backfill should stay off the immediate user path.',
      'High-priority capture should override queued low-priority backfill for the same session.',
    ],
    changeGuidance: [
      'Add new background project-memory work here instead of attaching heavy logic directly to session lifecycle hooks.',
    ],
    testLocations: ['electron/projectMemoryService.test.ts'],
  },
  {
    id: 'project-memory-canonical-store',
    name: 'Project memory canonical store',
    kind: 'manager',
    paths: ['electron/projectMemoryManager.ts'],
    responsibility:
      'Validates durable memory candidates, persists canonical memory files, and assembles bootstrap context for future sessions.',
    owns: [
      'canonical memory files',
      'candidate merge rules',
      'bootstrap context assembly',
      'architecture snapshot persistence',
    ],
    invariants: [
      'Canonical memory should stay project-scoped unless there is a strong reason to keep an entry location-scoped.',
      'Bootstrap context should be short, task-relevant, and derived from persisted memory artifacts.',
    ],
    changeGuidance: [
      'Keep canonical memory portable: prefer repo-relative references and durable abstractions over machine-local state.',
    ],
    testLocations: ['electron/projectMemoryManager.test.ts'],
  },
  {
    id: 'project-memory-extractor',
    name: 'Project memory extractor',
    kind: 'service',
    paths: ['electron/projectMemoryAgent.ts'],
    responsibility:
      'Builds a bounded transcript prompt and asks the configured model to extract durable facts, decisions, preferences, and workflows.',
    owns: [
      'transcript prompt shaping',
      'extractor response parsing',
      'runtime validation of model output',
    ],
    invariants: [
      'Extractor prompts and responses must stay bounded and schema-validated.',
    ],
    changeGuidance: [
      'Adjust extraction rules here when project memory quality changes; keep malformed model output from reaching canonical storage.',
    ],
    testLocations: ['electron/projectMemoryAgent.test.ts'],
  },
  {
    id: 'skill-library-manager',
    name: 'Skill library manager',
    kind: 'manager',
    paths: ['electron/skillLibraryManager.ts'],
    responsibility:
      'Tracks skill-library settings, validates roots, and orchestrates sync or merge flows for skills.',
    owns: [
      'skill settings persistence',
      'skill sync state',
      'full-sync orchestration',
    ],
    invariants: [
      'Project memory is effectively disabled until the library root is configured.',
    ],
    changeGuidance: [
      'Treat the library root as the gating configuration for project-memory persistence and sync features.',
    ],
    testLocations: ['electron/skillLibraryManager.test.ts'],
  },
  {
    id: 'windows-command-prompt-manager',
    name: 'Windows command prompt manager',
    kind: 'service',
    paths: ['electron/windowsCommandPromptManager.ts'],
    responsibility:
      'Maintains detached Windows command prompt windows linked to sessions.',
    owns: [
      'cmd sidecar process lifecycle',
      'Windows command prompt IO forwarding',
    ],
    invariants: [
      'Windows command prompt state stays separate from the main node-pty session runtime.',
    ],
    changeGuidance: [
      'Keep Windows-specific shell handling isolated here instead of adding branching logic to SessionManager.',
    ],
  },
]

const INTERACTION_BLUEPRINTS: InteractionBlueprint[] = [
  {
    id: 'renderer-to-preload',
    from: 'renderer-app-shell',
    to: 'preload-bridge',
    via: 'window.agentCli',
    purpose: 'Renderer actions and listeners flow through the preload bridge instead of direct Electron access.',
    trigger: 'Any UI action that needs session, file, shell, or sync behavior.',
    failureModes: [
      'Renderer and preload drift if src/shared/ipc.ts and electron/preload.ts are not updated together.',
    ],
    notes: [],
  },
  {
    id: 'preload-to-main',
    from: 'preload-bridge',
    to: 'main-process-composition-root',
    via: 'IPC_CHANNELS',
    purpose: 'Preload forwards typed renderer requests to main-process IPC handlers.',
    trigger: 'IPC method invocation or event listener subscription.',
    failureModes: [
      'IPC methods become unavailable if channel names or handler wiring diverge.',
    ],
    notes: [
      'Shared IPC contracts are defined in src/shared/ipc.ts.',
    ],
  },
  {
    id: 'renderer-to-store',
    from: 'renderer-app-shell',
    to: 'renderer-session-store',
    via: 'useSessionsStore',
    purpose: 'The top-level renderer reads and mutates hydrated session state through Zustand.',
    trigger: 'Renderer hydration and session/runtime updates from the main process.',
    failureModes: [],
    notes: [],
  },
  {
    id: 'main-to-session-manager',
    from: 'main-process-composition-root',
    to: 'session-lifecycle-manager',
    via: 'direct service composition',
    purpose: 'Main delegates project/session IPC handlers to SessionManager.',
    trigger: 'Session lifecycle IPC calls or startup restore.',
    failureModes: [
      'Thin handlers drift if composition code reimplements lifecycle logic instead of delegating.',
    ],
    notes: [],
  },
  {
    id: 'session-to-transcript-store',
    from: 'session-lifecycle-manager',
    to: 'transcript-persistence',
    via: 'appendTranscriptEvent',
    purpose: 'SessionManager records user, system, runtime, and terminal events for later replay and memory capture.',
    trigger: 'Session IO, runtime changes, and bootstrap messages.',
    failureModes: [
      'Historical import quality drops if transcript events are missing or incomplete.',
    ],
    notes: [],
  },
  {
    id: 'session-to-project-memory-queue',
    from: 'session-lifecycle-manager',
    to: 'project-memory-queue',
    via: 'assembleContext / captureSession / scheduleBackfillSessions',
    purpose: 'SessionManager requests bootstrap memory and queues background capture or historical import work.',
    trigger: 'Session restore, shutdown, close, or manual history import.',
    failureModes: [
      'User hot-path regressions occur if heavy project-memory work moves back into SessionManager.',
    ],
    notes: [],
  },
  {
    id: 'queue-to-transcript-store',
    from: 'project-memory-queue',
    to: 'transcript-persistence',
    via: 'readIndex / readEvents',
    purpose: 'Queued memory jobs read persisted transcript material to avoid blocking the session hot path.',
    trigger: 'Job drain and retry processing.',
    failureModes: [
      'Low-value summaries appear when backfill processes sessions without useful transcript data.',
    ],
    notes: [],
  },
  {
    id: 'queue-to-canonical-store',
    from: 'project-memory-queue',
    to: 'project-memory-canonical-store',
    via: 'captureSession / assembleContext',
    purpose: 'The queue feeds transcript-backed jobs into canonical memory persistence and later context assembly.',
    trigger: 'Queued capture/backfill or bootstrap requests.',
    failureModes: [
      'Project memory quality regresses if invalid jobs or diagnostics handling are bypassed.',
    ],
    notes: [],
  },
  {
    id: 'canonical-store-to-extractor',
    from: 'project-memory-canonical-store',
    to: 'project-memory-extractor',
    via: 'extract',
    purpose: 'Canonical storage delegates transcript summarization to the extractor but keeps validation and merge rules local.',
    trigger: 'Transcript-backed project-memory capture.',
    failureModes: [
      'Malformed candidates or oversized prompts can pollute memory if extractor validation is weakened.',
    ],
    notes: [],
  },
  {
    id: 'main-to-skill-library',
    from: 'main-process-composition-root',
    to: 'skill-library-manager',
    via: 'direct service composition',
    purpose: 'Main uses skill settings to gate project-memory persistence and sync UI actions.',
    trigger: 'Skill settings updates and full-sync flows.',
    failureModes: [],
    notes: [],
  },
]

const ARCHITECTURE_INVARIANTS: ArchitectureInvariant[] = [
  {
    id: 'renderer-preload-main-boundary',
    statement:
      'Renderer code should use the preload bridge and shared IPC contracts instead of direct Electron or Node access.',
    relatedModules: [
      'renderer-app-shell',
      'shared-contracts',
      'preload-bridge',
      'main-process-composition-root',
    ],
  },
  {
    id: 'session-manager-centrality',
    statement:
      'Session lifecycle, transcript appends, and project-memory queue triggers stay centralized in SessionManager.',
    relatedModules: [
      'session-lifecycle-manager',
      'transcript-persistence',
      'project-memory-queue',
    ],
  },
  {
    id: 'background-project-memory',
    statement:
      'Project-memory capture, backfill, and historical import should run through queued background work rather than the active user path.',
    relatedModules: [
      'session-lifecycle-manager',
      'project-memory-queue',
      'project-memory-canonical-store',
    ],
  },
]

const ARCHITECTURE_GLOSSARY: ArchitectureGlossaryTerm[] = [
  {
    term: 'logical project',
    meaning:
      'A project-memory identity keyed primarily by remote fingerprint so multiple local checkouts can share durable memory.',
  },
  {
    term: 'location',
    meaning:
      'A specific local checkout of a logical project. Location-scoped memory applies only to the matching checkout.',
  },
  {
    term: 'bootstrap context',
    meaning:
      'The short project-memory message injected into a session to remind the agent of relevant memory and architecture before work begins.',
  },
  {
    term: 'historical import',
    meaning:
      'A low-priority backfill pass that reprocesses stored Agent CLIs sessions with local transcripts into project memory.',
  },
]

function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function confidenceForExistingPaths(
  existingPathCount: number,
  declaredPathCount: number,
): number {
  if (declaredPathCount === 0) {
    return 0.7
  }

  const ratio = existingPathCount / declaredPathCount
  return Math.max(0.55, Math.min(0.98, 0.7 + ratio * 0.25))
}

async function listSourceFiles(rootPath: string): Promise<string[]> {
  const results: string[] = []

  const visit = async (currentPath: string) => {
    let entries
    try {
      entries = await readdir(currentPath, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name === 'dist' || entry.name === 'dist-electron' || entry.name === 'release') {
        continue
      }

      const absolutePath = path.join(currentPath, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath)
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      if (!SOURCE_FILE_EXTENSIONS.has(path.extname(entry.name))) {
        continue
      }

      results.push(normalizeRepoPath(path.relative(rootPath, absolutePath)))
    }
  }

  for (const directory of SOURCE_DIRECTORIES) {
    await visit(path.join(rootPath, directory))
  }

  return results.sort()
}

async function filterExistingRepoPaths(
  rootPath: string,
  repoPaths: string[],
): Promise<string[]> {
  const existing: string[] = []

  await Promise.all(repoPaths.map(async (repoPath) => {
    try {
      await readFile(path.join(rootPath, repoPath), 'utf8')
      existing.push(repoPath)
    } catch {
      // Skip missing blueprint paths.
    }
  }))

  return existing.sort()
}

function extractExports(content: string): {
  publicInterfaces: string[]
  keyTypes: string[]
} {
  const publicInterfaces = new Set<string>()
  const keyTypes = new Set<string>()

  const addMatches = (pattern: RegExp, target: Set<string>) => {
    for (const match of content.matchAll(pattern)) {
      const name = match[1]?.trim()
      if (name) {
        target.add(name)
      }
    }
  }

  addMatches(/export\s+class\s+([A-Za-z0-9_]+)/gu, publicInterfaces)
  addMatches(/export\s+function\s+([A-Za-z0-9_]+)/gu, publicInterfaces)
  addMatches(/export\s+const\s+([A-Za-z0-9_]+)/gu, publicInterfaces)
  addMatches(/export\s+async\s+function\s+([A-Za-z0-9_]+)/gu, publicInterfaces)
  addMatches(/export\s+default\s+function\s+([A-Za-z0-9_]+)/gu, publicInterfaces)
  addMatches(/export\s+default\s+([A-Za-z0-9_]+)/gu, publicInterfaces)

  addMatches(/export\s+interface\s+([A-Za-z0-9_]+)/gu, keyTypes)
  addMatches(/export\s+type\s+([A-Za-z0-9_]+)/gu, keyTypes)
  addMatches(/export\s+enum\s+([A-Za-z0-9_]+)/gu, keyTypes)

  return {
    publicInterfaces: Array.from(publicInterfaces).sort(),
    keyTypes: Array.from(keyTypes).sort(),
  }
}

function extractImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>()
  const importPatterns = [
    /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
    /import\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ]

  for (const pattern of importPatterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1]?.trim()
      if (specifier) {
        specifiers.add(specifier)
      }
    }
  }

  return Array.from(specifiers)
}

function resolveRelativeImport(
  fromRepoPath: string,
  specifier: string,
  sourceFiles: Set<string>,
): string | null {
  if (!specifier.startsWith('.')) {
    return null
  }

  const fromDirectory = path.posix.dirname(fromRepoPath)
  const basePath = path.posix.normalize(path.posix.join(fromDirectory, specifier))
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    path.posix.join(basePath, 'index.ts'),
    path.posix.join(basePath, 'index.tsx'),
    path.posix.join(basePath, 'index.js'),
  ]

  return candidates.find((candidate) => sourceFiles.has(candidate)) ?? null
}

function buildSystemOverview(moduleIds: Set<string>): string {
  const overviewParts: string[] = []

  if (
    moduleIds.has('renderer-app-shell') &&
    moduleIds.has('preload-bridge') &&
    moduleIds.has('main-process-composition-root')
  ) {
    overviewParts.push(
      'The app is layered into a React renderer, a preload bridge, and an Electron main process coordinated through shared contracts.',
    )
  }

  if (
    moduleIds.has('session-lifecycle-manager') &&
    moduleIds.has('transcript-persistence')
  ) {
    overviewParts.push(
      'Session lifecycle is centralized in SessionManager, which emits runtime/config/data updates and persists transcript events through TranscriptStore.',
    )
  }

  if (
    moduleIds.has('project-memory-queue') &&
    moduleIds.has('project-memory-canonical-store')
  ) {
    overviewParts.push(
      'Project memory is captured off the hot path: queued work reads transcripts, validates durable memory, and assembles short bootstrap context for future sessions.',
    )
  }

  if (moduleIds.has('skill-library-manager')) {
    overviewParts.push(
      'Skill-library settings gate project-memory persistence and expose sync-related controls through the same Electron composition root.',
    )
  }

  return overviewParts.join(' ').trim() || 'Architecture snapshot derived from the repo structure and imports.'
}

function buildRelevantInvariants(moduleIds: Set<string>): ArchitectureInvariant[] {
  return ARCHITECTURE_INVARIANTS.filter((invariant) =>
    invariant.relatedModules.some((moduleId) => moduleIds.has(moduleId)),
  )
}

function buildRelevantGlossary(moduleIds: Set<string>): ArchitectureGlossaryTerm[] {
  const glossary = [...ARCHITECTURE_GLOSSARY]
  if (!moduleIds.has('project-memory-queue')) {
    return glossary.filter((entry) => entry.term !== 'historical import')
  }

  return glossary
}

export async function indexProjectArchitecture(
  input: ProjectArchitectureIndexInput,
): Promise<ProjectArchitectureSnapshot | null> {
  const sourceFiles = new Set(await listSourceFiles(input.rootPath))
  if (sourceFiles.size === 0) {
    return null
  }

  const existingBlueprints = await Promise.all(
    MODULE_BLUEPRINTS.map(async (blueprint) => {
      const existingPaths = await filterExistingRepoPaths(input.rootPath, blueprint.paths)
      if (existingPaths.length === 0) {
        return null
      }

      return {
        blueprint,
        existingPaths,
      }
    }),
  )

  const presentBlueprints = existingBlueprints.filter(
    (entry): entry is { blueprint: ArchitectureModuleBlueprint; existingPaths: string[] } =>
      entry !== null,
  )
  if (presentBlueprints.length === 0) {
    return null
  }

  const moduleIds = new Set(presentBlueprints.map((entry) => entry.blueprint.id))
  const repoPathToModuleId = new Map<string, string>()
  for (const entry of presentBlueprints) {
    for (const repoPath of entry.existingPaths) {
      repoPathToModuleId.set(repoPath, entry.blueprint.id)
    }
  }

  const modules: ArchitectureModuleCard[] = []
  for (const entry of presentBlueprints) {
    const publicInterfaces = new Set<string>()
    const keyTypes = new Set<string>()
    const dependencyIds = new Set<string>()

    for (const repoPath of entry.existingPaths) {
      const content = await readFile(path.join(input.rootPath, repoPath), 'utf8')
      const exports = extractExports(content)
      exports.publicInterfaces.forEach((name) => publicInterfaces.add(name))
      exports.keyTypes.forEach((name) => keyTypes.add(name))

      for (const specifier of extractImportSpecifiers(content)) {
        const resolvedPath = resolveRelativeImport(repoPath, specifier, sourceFiles)
        const dependencyId = resolvedPath ? repoPathToModuleId.get(resolvedPath) : null
        if (dependencyId && dependencyId !== entry.blueprint.id) {
          dependencyIds.add(dependencyId)
        }
      }
    }

    const existingTests = (entry.blueprint.testLocations ?? []).filter((repoPath) =>
      sourceFiles.has(repoPath),
    )

    modules.push({
      id: entry.blueprint.id,
      name: entry.blueprint.name,
      kind: entry.blueprint.kind,
      paths: entry.existingPaths,
      responsibility: entry.blueprint.responsibility,
      owns: [...entry.blueprint.owns],
      dependsOn: Array.from(dependencyIds).sort(),
      usedBy: [],
      publicInterfaces: Array.from(publicInterfaces).sort(),
      keyTypes: Array.from(keyTypes).sort(),
      invariants: [...entry.blueprint.invariants],
      changeGuidance: [...entry.blueprint.changeGuidance],
      testLocations: existingTests,
      confidence: confidenceForExistingPaths(
        entry.existingPaths.length,
        entry.blueprint.paths.length,
      ),
    })
  }

  const moduleById = new Map(modules.map((module) => [module.id, module]))
  for (const module of modules) {
    for (const dependencyId of module.dependsOn) {
      const dependency = moduleById.get(dependencyId)
      if (!dependency) {
        continue
      }

      dependency.usedBy = uniqueStrings([...dependency.usedBy, module.id]).sort()
    }
  }

  const interactions: ArchitectureInteraction[] = INTERACTION_BLUEPRINTS.filter(
    (entry) => moduleIds.has(entry.from) && moduleIds.has(entry.to),
  ).map((entry) => ({
    ...entry,
    failureModes: [...entry.failureModes],
    notes: [...entry.notes],
  }))

  return {
    projectId: input.projectId,
    title: input.title,
    generatedAt: new Date().toISOString(),
    systemOverview: buildSystemOverview(moduleIds),
    modules,
    interactions,
    invariants: buildRelevantInvariants(moduleIds),
    glossary: buildRelevantGlossary(moduleIds),
  }
}
