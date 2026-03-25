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

interface TopLevelRepoEntry {
  name: string
  repoPath: string
  isDirectory: boolean
}

interface ArchitectureDocumentSection {
  heading: string
  body: string
}

interface ArchitectureDocumentSnapshot {
  repoPath: string
  overview: string
  sections: ArchitectureDocumentSection[]
}

const SOURCE_DIRECTORIES = ['src', 'electron']
const SOURCE_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])
const OUTPUT_DIRECTORIES = new Set(['dist', 'dist-electron', 'release', 'build', 'out', 'coverage'])
const IGNORED_TOP_LEVEL_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
])
const ARCHITECTURE_DOC_CANDIDATES = [
  'architecture.md',
  'ARCHITECTURE.md',
  'docs/architecture.md',
  'docs/ARCHITECTURE.md',
  'docs/architecture/index.md',
  'Doc/architecture.md',
  'Doc/Architecture.md',
  'Design_Docs/architecture.md',
  'Design_Docs/Architecture.md',
]
const README_CANDIDATES = ['README.md', 'Readme.md', 'readme.md']
const GENERIC_MANIFEST_FILES = new Set([
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'cmakelists.txt',
  'makefile',
])
const DOC_SECTION_BLACKLIST = new Set([
  'overview',
  'system overview',
  'introduction',
  'background',
  'glossary',
  'references',
  'appendix',
])
const AUTOSAR_MARKER_DIRECTORIES = [
  'applications',
  'swc',
  'bsw',
  'bswmd',
  'davinciconfigurator',
  'generators',
  'vpconfig',
  'unit_test',
]

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
      'Builds a bounded transcript prompt and asks the configured model to extract durable memory such as troubleshooting patterns, component workflows, conventions, critical files, and other high-signal project guidance.',
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

const AUTOSAR_INVARIANTS: ArchitectureInvariant[] = [
  {
    id: 'autosar-generated-artifacts',
    statement:
      'Generated BSW and integration artifacts should stay traceable to configuration inputs instead of being treated as standalone hand-edited sources.',
    relatedModules: [
      'autosar-bsw-platform',
      'autosar-configuration-toolchain',
    ],
  },
  {
    id: 'autosar-test-alignment',
    statement:
      'Changes in SWC or BSW behavior should keep targeted unit-test and validation assets aligned with the updated initialization and configuration flow.',
    relatedModules: [
      'autosar-application-layer',
      'autosar-bsw-platform',
      'autosar-verification',
    ],
  },
]

const AUTOSAR_GLOSSARY: ArchitectureGlossaryTerm[] = [
  {
    term: 'SWC',
    meaning:
      'Application software component code that implements ECU feature behavior above the basic software stack.',
  },
  {
    term: 'BSW',
    meaning:
      'Basic software modules and integration layers that provide platform services, communication, and initialization behavior.',
  },
  {
    term: 'DaVinci / generator inputs',
    meaning:
      'Configuration sources such as DaVinci projects, vpconfig data, and generator inputs that produce BSW or integration artifacts.',
  },
]

function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function normalizeText(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function trimExcerpt(value: string, limit: number): string {
  const normalized = normalizeText(value)
  if (normalized.length <= limit) {
    return normalized
  }

  return `${normalized.slice(0, limit - 3).trimEnd()}...`
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '') || 'module'
  )
}

function humanizeName(value: string): string {
  return value
    .replace(/\.[^.]+$/u, '')
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((part) =>
      /^[A-Z0-9]+$/u.test(part) || /[A-Z].*[a-z]/u.test(part)
        ? part
        : `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`,
    )
    .join(' ')
}

function stripMarkdownSyntax(value: string): string {
  return value
    .replace(/^---[\s\S]*?\n---\n?/u, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/^>\s+/gmu, '')
    .replace(/^[*-]\s+/gmu, '')
    .replace(/^#+\s+/gmu, '')
}

function buildSnapshot(
  input: ProjectArchitectureIndexInput,
  details: {
    systemOverview: string
    modules: ArchitectureModuleCard[]
    interactions?: ArchitectureInteraction[]
    invariants?: ArchitectureInvariant[]
    glossary?: ArchitectureGlossaryTerm[]
  },
): ProjectArchitectureSnapshot {
  return {
    projectId: input.projectId,
    title: input.title,
    generatedAt: new Date().toISOString(),
    systemOverview: details.systemOverview,
    modules: details.modules,
    interactions: details.interactions ?? [],
    invariants: details.invariants ?? [],
    glossary: details.glossary ?? [],
  }
}

function populateUsedBy(modules: ArchitectureModuleCard[]): ArchitectureModuleCard[] {
  const moduleById = new Map(modules.map((module) => [module.id, module]))
  for (const module of modules) {
    module.usedBy = []
  }

  for (const module of modules) {
    for (const dependencyId of module.dependsOn) {
      const dependency = moduleById.get(dependencyId)
      if (!dependency) {
        continue
      }

      dependency.usedBy = uniqueStrings([...dependency.usedBy, module.id]).sort()
    }
  }

  return modules
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
      if (OUTPUT_DIRECTORIES.has(entry.name)) {
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

async function listTopLevelEntries(rootPath: string): Promise<TopLevelRepoEntry[]> {
  try {
    const entries = await readdir(rootPath, { withFileTypes: true })
    return entries
      .filter((entry) => !OUTPUT_DIRECTORIES.has(entry.name))
      .map((entry) => ({
        name: entry.name,
        repoPath: normalizeRepoPath(entry.name),
        isDirectory: entry.isDirectory(),
      }))
      .sort((left, right) => left.repoPath.localeCompare(right.repoPath))
  } catch {
    return []
  }
}

async function readPreferredFile(
  rootPath: string,
  candidates: string[],
): Promise<{ repoPath: string; content: string } | null> {
  for (const repoPath of candidates) {
    try {
      const content = await readFile(path.join(rootPath, repoPath), 'utf8')
      if (normalizeText(content)) {
        return {
          repoPath,
          content,
        }
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null
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

function extractDocumentOverview(content: string): string {
  const normalizedContent = stripMarkdownSyntax(content).replace(/\r/g, '')
  const paragraphs = normalizedContent
    .split(/\n\s*\n/u)
    .map((paragraph) => trimExcerpt(paragraph, 320))
    .filter(Boolean)

  return paragraphs[0] ?? 'Architecture overview derived from repository documentation.'
}

function extractMarkdownSections(content: string): ArchitectureDocumentSection[] {
  const lines = content.replace(/\r/g, '').split('\n')
  const sections: Array<{ heading: string; bodyLines: string[] }> = []
  let current: { heading: string; bodyLines: string[] } | null = null
  let inCodeBlock = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock
    }
    if (inCodeBlock) {
      continue
    }

    const headingMatch = rawLine.match(/^(##|###)\s+(.+)$/u)
    if (headingMatch) {
      if (current) {
        sections.push(current)
      }
      current = {
        heading: headingMatch[2].trim(),
        bodyLines: [],
      }
      continue
    }

    if (current) {
      current.bodyLines.push(rawLine)
    }
  }

  if (current) {
    sections.push(current)
  }

  return sections
    .map((section) => ({
      heading: section.heading,
      body: trimExcerpt(stripMarkdownSyntax(section.bodyLines.join('\n')), 220),
    }))
    .filter(
      (section) =>
        section.heading &&
        !DOC_SECTION_BLACKLIST.has(section.heading.trim().toLowerCase()),
    )
    .slice(0, 6)
}

function guessModuleKind(label: string): ArchitectureModuleKind {
  const normalized = label.toLowerCase()
  if (normalized.includes('renderer') || normalized.includes('ui')) {
    return 'renderer'
  }
  if (normalized.includes('store')) {
    return 'store'
  }
  if (
    normalized.includes('shared') ||
    normalized.includes('contract') ||
    normalized.includes('schema')
  ) {
    return 'shared-contract'
  }
  if (normalized.includes('preload')) {
    return 'preload-bridge'
  }
  if (normalized.includes('main')) {
    return 'main-process'
  }
  if (
    normalized.includes('manager') ||
    normalized.includes('config') ||
    normalized.includes('generator')
  ) {
    return 'manager'
  }
  if (
    normalized.includes('service') ||
    normalized.includes('platform') ||
    normalized.includes('runtime') ||
    normalized.includes('bsw')
  ) {
    return 'service'
  }

  return 'utility'
}

function isTestLikeName(value: string): boolean {
  return /(test|tests|spec|specs|qa)/iu.test(value)
}

function isToolLikeName(value: string): boolean {
  return /(tool|tools|script|scripts|generator|generators|build)/iu.test(value)
}

function isDocLikeName(value: string): boolean {
  return /(doc|docs|design)/iu.test(value)
}

function buildGenericResponsibility(entryName: string, isDirectory: boolean): string {
  const normalized = entryName.toLowerCase()
  if (isTestLikeName(normalized)) {
    return 'Contains automated tests, harnesses, or validation artifacts for the project.'
  }
  if (isToolLikeName(normalized)) {
    return 'Provides scripts, generators, or build-time tooling that support development and integration workflows.'
  }
  if (isDocLikeName(normalized)) {
    return 'Holds documentation or design references that describe how the project is structured and operated.'
  }
  if (normalized.includes('config')) {
    return 'Owns configuration inputs that shape how the project is built, generated, or run.'
  }
  if (normalized.includes('src') || normalized.includes('app') || normalized.includes('service')) {
    return 'Contains primary implementation code for the project.'
  }
  if (isDirectory) {
    return `Contains files beneath the top-level ${entryName} area.`
  }

  return `Provides project-level metadata or build configuration through ${entryName}.`
}

function buildGenericOwns(entryName: string): string[] {
  const normalized = entryName.toLowerCase()
  if (isTestLikeName(normalized)) {
    return ['test suites', 'validation harnesses']
  }
  if (isToolLikeName(normalized)) {
    return ['tooling', 'build scripts']
  }
  if (isDocLikeName(normalized)) {
    return ['architecture notes', 'design references']
  }
  if (normalized.includes('config')) {
    return ['configuration', 'environment defaults']
  }
  if (normalized.includes('src') || normalized.includes('app') || normalized.includes('service')) {
    return ['core implementation']
  }

  return []
}

function buildGenericChangeGuidance(entryName: string): string[] {
  const normalized = entryName.toLowerCase()
  if (isTestLikeName(normalized)) {
    return ['Keep focused tests aligned with the behavior they validate.']
  }
  if (isToolLikeName(normalized)) {
    return ['Review tool or generator changes for downstream churn before keeping generated output.']
  }
  if (isDocLikeName(normalized)) {
    return ['Update documentation when architectural boundaries or workflows change.']
  }
  if (normalized.includes('config')) {
    return ['Trace configuration edits through the generated or runtime behavior they influence.']
  }

  return ['Prefer edits in owned source areas over one-off changes in derived output.']
}

async function readArchitectureDocument(
  rootPath: string,
): Promise<ArchitectureDocumentSnapshot | null> {
  const document = await readPreferredFile(rootPath, ARCHITECTURE_DOC_CANDIDATES)
  if (!document) {
    return null
  }

  return {
    repoPath: document.repoPath,
    overview: extractDocumentOverview(document.content),
    sections: extractMarkdownSections(document.content),
  }
}

function buildDocumentedArchitectureSnapshot(
  input: ProjectArchitectureIndexInput,
  document: ArchitectureDocumentSnapshot,
): ProjectArchitectureSnapshot {
  const modules: ArchitectureModuleCard[] =
    document.sections.length > 0
      ? document.sections.map((section, index) => ({
          id: `documented-${slugify(section.heading) || `section-${index + 1}`}`,
          name: section.heading,
          kind: guessModuleKind(section.heading),
          paths: [document.repoPath],
          responsibility:
            section.body || `Responsibilities for this area are described in ${document.repoPath}.`,
          owns: [],
          dependsOn: [],
          usedBy: [],
          publicInterfaces: [],
          keyTypes: [],
          invariants: [`Derived from ${document.repoPath}.`],
          changeGuidance: [
            `Update ${document.repoPath} when the responsibilities of this area change.`,
          ],
          testLocations: [],
          confidence: 0.92,
        }))
      : [
          {
            id: 'documented-architecture',
            name: 'Documented architecture',
            kind: 'utility',
            paths: [document.repoPath],
            responsibility: document.overview,
            owns: ['architecture guidance'],
            dependsOn: [],
            usedBy: [],
            publicInterfaces: [],
            keyTypes: [],
            invariants: [`Derived from ${document.repoPath}.`],
            changeGuidance: [
              `Update ${document.repoPath} when major architectural boundaries change.`,
            ],
            testLocations: [],
            confidence: 0.9,
          },
        ]

  return buildSnapshot(input, {
    systemOverview: `Primary architecture notes were read from ${document.repoPath}. ${document.overview}`,
    modules,
    invariants: [
      {
        id: 'documented-architecture-source',
        statement: `Keep ${document.repoPath} updated when the architecture changes, because project memory treats it as the authoritative source.`,
        relatedModules: modules.slice(0, 4).map((module) => module.id),
      },
    ],
    glossary: [
      {
        term: 'architecture source',
        meaning: `Primary architecture details were taken from ${document.repoPath}.`,
      },
    ],
  })
}

function selectTopLevelPaths(
  entries: TopLevelRepoEntry[],
  names: string[],
): string[] {
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  return entries
    .filter((entry) => wanted.has(entry.name.toLowerCase()))
    .map((entry) => entry.repoPath)
    .sort()
}

function buildAutosarModules(entries: TopLevelRepoEntry[]): ArchitectureModuleCard[] {
  const applicationPaths = selectTopLevelPaths(entries, ['Applications', 'SWC'])
  const bswPaths = selectTopLevelPaths(entries, ['BSW', 'BSWMD'])
  const configurationPaths = selectTopLevelPaths(entries, [
    'DaVinciConfigurator',
    'vpconfig',
    'Generators',
  ])
  const verificationPaths = selectTopLevelPaths(entries, ['unit_test'])
  const supportPaths = selectTopLevelPaths(entries, [
    'Tools',
    'ThirdParty',
    'Doc',
    'Design_Docs',
  ])

  const modules: ArchitectureModuleCard[] = []

  if (applicationPaths.length > 0) {
    modules.push({
      id: 'autosar-application-layer',
      name: 'Application layer',
      kind: 'service',
      paths: applicationPaths,
      responsibility:
        'Contains application software components and feature-level logic that sit above the basic software stack.',
      owns: ['application SWCs', 'feature logic', 'integration entrypoints'],
      dependsOn: [],
      usedBy: [],
      publicInterfaces: [],
      keyTypes: [],
      invariants: [
        'Application behavior should usually land here rather than in generated BSW output.',
      ],
      changeGuidance: [
        'Trace feature edits through SWC or application code before touching generated artifacts.',
      ],
      testLocations: verificationPaths,
      confidence: confidenceForExistingPaths(applicationPaths.length, 2),
    })
  }

  if (bswPaths.length > 0) {
    modules.push({
      id: 'autosar-bsw-platform',
      name: 'Basic software platform',
      kind: 'service',
      paths: bswPaths,
      responsibility:
        'Provides configured basic software modules, integration glue, and metadata that support ECU runtime behavior.',
      owns: ['BSW modules', 'integration glue', 'module metadata'],
      dependsOn: [],
      usedBy: [],
      publicInterfaces: [],
      keyTypes: [],
      invariants: [
        'BSW behavior must stay aligned with its configuration sources and generated artifacts.',
      ],
      changeGuidance: [
        'Prefer edits in configuration sources or owned source files over one-off changes in generated output.',
      ],
      testLocations: verificationPaths,
      confidence: confidenceForExistingPaths(bswPaths.length, 2),
    })
  }

  if (configurationPaths.length > 0) {
    modules.push({
      id: 'autosar-configuration-toolchain',
      name: 'Configuration toolchain',
      kind: 'manager',
      paths: configurationPaths,
      responsibility:
        'Holds ECU configuration inputs and generation tooling that feed BSW integration and derived artifacts.',
      owns: ['DaVinci inputs', 'generator workflows', 'variant configuration'],
      dependsOn: [],
      usedBy: [],
      publicInterfaces: [],
      keyTypes: [],
      invariants: [
        'Configuration-driven artifacts should stay reproducible from these tool-owned inputs.',
      ],
      changeGuidance: [
        'Regenerate affected modules after configuration edits and review unrelated churn before keeping it.',
      ],
      testLocations: [],
      confidence: confidenceForExistingPaths(configurationPaths.length, 3),
    })
  }

  if (verificationPaths.length > 0) {
    modules.push({
      id: 'autosar-verification',
      name: 'Verification and test',
      kind: 'utility',
      paths: verificationPaths,
      responsibility:
        'Contains host-side tests or harnesses that validate SWC, BSW, and initialization behavior.',
      owns: ['unit tests', 'test harnesses'],
      dependsOn: [],
      usedBy: [],
      publicInterfaces: [],
      keyTypes: [],
      invariants: [
        'Regression coverage should follow behavior changes in SWC or BSW logic.',
      ],
      changeGuidance: [
        'Add or update focused tests when initialization or configuration behavior changes.',
      ],
      testLocations: verificationPaths,
      confidence: confidenceForExistingPaths(verificationPaths.length, 1),
    })
  }

  if (supportPaths.length > 0) {
    modules.push({
      id: 'autosar-supporting-assets',
      name: 'Supporting assets',
      kind: 'utility',
      paths: supportPaths,
      responsibility:
        'Provides tooling, third-party inputs, and documentation that support the ECU development workflow.',
      owns: ['supporting tooling', 'third-party assets', 'design documents'],
      dependsOn: [],
      usedBy: [],
      publicInterfaces: [],
      keyTypes: [],
      invariants: [],
      changeGuidance: [
        'Keep support assets in sync with the runtime and configuration areas they describe or build.',
      ],
      testLocations: [],
      confidence: confidenceForExistingPaths(supportPaths.length, 4),
    })
  }

  const moduleById = new Map(modules.map((module) => [module.id, module]))
  moduleById.get('autosar-application-layer')?.dependsOn.push('autosar-bsw-platform')
  moduleById
    .get('autosar-bsw-platform')
    ?.dependsOn.push('autosar-configuration-toolchain')
  moduleById
    .get('autosar-verification')
    ?.dependsOn.push('autosar-application-layer', 'autosar-bsw-platform')

  for (const module of modules) {
    module.dependsOn = module.dependsOn.filter((dependencyId) => moduleById.has(dependencyId))
  }

  return populateUsedBy(modules)
}

function buildAutosarInteractions(
  modules: ArchitectureModuleCard[],
): ArchitectureInteraction[] {
  const moduleIds = new Set(modules.map((module) => module.id))
  const interactions: ArchitectureInteraction[] = []

  if (
    moduleIds.has('autosar-configuration-toolchain') &&
    moduleIds.has('autosar-bsw-platform')
  ) {
    interactions.push({
      id: 'autosar-config-to-bsw',
      from: 'autosar-configuration-toolchain',
      to: 'autosar-bsw-platform',
      via: 'generator inputs and ECU configuration',
      purpose:
        'Configuration projects and generator inputs feed the basic software platform and its derived integration artifacts.',
      trigger: 'Variant configuration changes or generator reruns.',
      failureModes: [
        'Hand-edited generated output can drift from the tool-owned configuration source.',
      ],
      notes: [],
    })
  }

  if (
    moduleIds.has('autosar-application-layer') &&
    moduleIds.has('autosar-bsw-platform')
  ) {
    interactions.push({
      id: 'autosar-application-to-bsw',
      from: 'autosar-application-layer',
      to: 'autosar-bsw-platform',
      via: 'platform services and integration hooks',
      purpose:
        'Application logic depends on configured BSW modules and integration hooks for ECU services and initialization.',
      trigger: 'Feature development, initialization changes, or runtime service usage.',
      failureModes: [
        'Behavior can regress when SWC assumptions no longer match configured BSW behavior.',
      ],
      notes: [],
    })
  }

  if (
    moduleIds.has('autosar-verification') &&
    moduleIds.has('autosar-application-layer')
  ) {
    interactions.push({
      id: 'autosar-tests-to-application',
      from: 'autosar-verification',
      to: 'autosar-application-layer',
      via: 'unit-test harnesses',
      purpose:
        'Focused tests exercise application and initialization behavior without requiring the full target runtime path.',
      trigger: 'Regression testing and targeted validation after code or config changes.',
      failureModes: [
        'Test expectations can drift when behavior changes but harnesses are not updated.',
      ],
      notes: [],
    })
  }

  return interactions
}

async function indexAutosarArchitecture(
  input: ProjectArchitectureIndexInput,
): Promise<ProjectArchitectureSnapshot | null> {
  const topLevelEntries = await listTopLevelEntries(input.rootPath)
  const lowerCaseDirectoryNames = new Set(
    topLevelEntries
      .filter((entry) => entry.isDirectory)
      .map((entry) => entry.name.toLowerCase()),
  )
  const markerCount = AUTOSAR_MARKER_DIRECTORIES.filter((marker) =>
    lowerCaseDirectoryNames.has(marker),
  ).length
  const hasRuntimeArea =
    lowerCaseDirectoryNames.has('applications') ||
    lowerCaseDirectoryNames.has('swc') ||
    lowerCaseDirectoryNames.has('bsw')
  const hasConfigurationArea =
    lowerCaseDirectoryNames.has('davinciconfigurator') ||
    lowerCaseDirectoryNames.has('vpconfig') ||
    lowerCaseDirectoryNames.has('generators')

  if (markerCount < 3 || !hasRuntimeArea || !hasConfigurationArea) {
    return null
  }

  const modules = buildAutosarModules(topLevelEntries)
  if (modules.length === 0) {
    return null
  }

  const readme = await readPreferredFile(input.rootPath, README_CANDIDATES)
  const overviewParts = [
    'AUTOSAR-style repository layout detected from top-level ECU software directories.',
  ]
  if (
    modules.some((module) => module.id === 'autosar-application-layer') &&
    modules.some((module) => module.id === 'autosar-bsw-platform') &&
    modules.some((module) => module.id === 'autosar-configuration-toolchain')
  ) {
    overviewParts.push(
      'Application logic is separated from the basic software platform, while generator and configuration inputs drive derived BSW integration artifacts.',
    )
  }
  if (readme) {
    overviewParts.push(`README summary: ${extractDocumentOverview(readme.content)}`)
  }

  return buildSnapshot(input, {
    systemOverview: overviewParts.join(' '),
    modules,
    interactions: buildAutosarInteractions(modules),
    invariants: AUTOSAR_INVARIANTS.filter((invariant) =>
      invariant.relatedModules.some((moduleId) => modules.some((module) => module.id === moduleId)),
    ),
    glossary: AUTOSAR_GLOSSARY,
  })
}

function buildGenericModules(
  topLevelEntries: TopLevelRepoEntry[],
): ArchitectureModuleCard[] {
  const candidateDirectories = topLevelEntries.filter(
    (entry) =>
      entry.isDirectory &&
      !IGNORED_TOP_LEVEL_DIRECTORIES.has(entry.name) &&
      !entry.name.startsWith('.'),
  )
  const candidateFiles = topLevelEntries.filter(
    (entry) =>
      !entry.isDirectory && GENERIC_MANIFEST_FILES.has(entry.name.toLowerCase()),
  )

  const chosenEntries = [
    ...candidateDirectories.slice(0, 6),
    ...(candidateDirectories.length === 0 ? candidateFiles.slice(0, 3) : []),
  ]
  const testPaths = candidateDirectories
    .filter((entry) => isTestLikeName(entry.name))
    .map((entry) => entry.repoPath)

  const modules: ArchitectureModuleCard[] = chosenEntries.map((entry) => ({
    id: `top-level-${slugify(entry.name)}`,
    name: humanizeName(entry.name),
    kind: guessModuleKind(entry.name),
    paths: [entry.repoPath],
    responsibility: buildGenericResponsibility(entry.name, entry.isDirectory),
    owns: buildGenericOwns(entry.name),
    dependsOn: [],
    usedBy: [],
    publicInterfaces: [],
    keyTypes: [],
    invariants: [],
    changeGuidance: buildGenericChangeGuidance(entry.name),
    testLocations: isTestLikeName(entry.name) ? [entry.repoPath] : testPaths,
    confidence: entry.isDirectory ? 0.66 : 0.58,
  }))

  const primaryModule = modules.find(
    (module) =>
      !isTestLikeName(module.name) &&
      !isToolLikeName(module.name) &&
      !isDocLikeName(module.name),
  )
  const testModule = modules.find((module) => isTestLikeName(module.name))
  const toolModule = modules.find((module) => isToolLikeName(module.name))

  if (primaryModule && testModule && testModule.id !== primaryModule.id) {
    testModule.dependsOn.push(primaryModule.id)
  }
  if (primaryModule && toolModule && toolModule.id !== primaryModule.id) {
    toolModule.dependsOn.push(primaryModule.id)
  }

  return populateUsedBy(modules)
}

function buildGenericInteractions(
  modules: ArchitectureModuleCard[],
): ArchitectureInteraction[] {
  const interactions: ArchitectureInteraction[] = []
  const primaryModule = modules.find(
    (module) =>
      !isTestLikeName(module.name) &&
      !isToolLikeName(module.name) &&
      !isDocLikeName(module.name),
  )
  const testModule = modules.find((module) => isTestLikeName(module.name))
  const toolModule = modules.find((module) => isToolLikeName(module.name))

  if (testModule && primaryModule && testModule.id !== primaryModule.id) {
    interactions.push({
      id: 'generic-tests-to-primary',
      from: testModule.id,
      to: primaryModule.id,
      via: 'project test harness',
      purpose:
        'Top-level tests validate the primary implementation area represented in this structural snapshot.',
      trigger: 'Automated or manual validation runs.',
      failureModes: [
        'Tests can drift from implementation behavior when changes land without matching expectation updates.',
      ],
      notes: [],
    })
  }

  if (toolModule && primaryModule && toolModule.id !== primaryModule.id) {
    interactions.push({
      id: 'generic-tools-to-primary',
      from: toolModule.id,
      to: primaryModule.id,
      via: 'build or generation workflow',
      purpose:
        'Tooling and scripts influence how the primary implementation area is built, generated, or validated.',
      trigger: 'Builds, generation steps, or repository maintenance tasks.',
      failureModes: [
        'Primary code and supporting scripts can drift if workflows change without corresponding updates.',
      ],
      notes: [],
    })
  }

  return interactions
}

function buildGenericInvariants(
  modules: ArchitectureModuleCard[],
  readmePath: string | null,
): ArchitectureInvariant[] {
  const relatedModuleIds = modules.slice(0, 4).map((module) => module.id)
  const invariants: ArchitectureInvariant[] = [
    {
      id: 'generic-heuristic-snapshot',
      statement:
        'This architecture snapshot is heuristic and should be refined with repo-specific architecture documentation when available.',
      relatedModules: relatedModuleIds,
    },
  ]

  if (readmePath) {
    invariants.push({
      id: 'generic-readme-source',
      statement: `README-derived context came from ${readmePath}; keep it current if it describes project structure or workflows.`,
      relatedModules: relatedModuleIds,
    })
  }

  return invariants
}

function buildGenericGlossary(readmePath: string | null): ArchitectureGlossaryTerm[] {
  const glossary: ArchitectureGlossaryTerm[] = [
    {
      term: 'structural snapshot',
      meaning:
        'A lightweight architecture view inferred from top-level directories, manifests, and simple repository heuristics.',
    },
  ]
  if (readmePath) {
    glossary.push({
      term: 'README summary',
      meaning: `Additional overview context was derived from ${readmePath}.`,
    })
  }

  return glossary
}

async function indexGenericArchitecture(
  input: ProjectArchitectureIndexInput,
): Promise<ProjectArchitectureSnapshot | null> {
  const topLevelEntries = await listTopLevelEntries(input.rootPath)
  if (topLevelEntries.length === 0) {
    return null
  }

  const modules = buildGenericModules(topLevelEntries)
  if (modules.length === 0) {
    return null
  }

  const readme = await readPreferredFile(input.rootPath, README_CANDIDATES)
  const topLevelAreas = topLevelEntries
    .filter((entry) => entry.isDirectory && !IGNORED_TOP_LEVEL_DIRECTORIES.has(entry.name))
    .map((entry) => entry.name)
    .slice(0, 5)
  const manifestNames = topLevelEntries
    .filter((entry) => !entry.isDirectory && GENERIC_MANIFEST_FILES.has(entry.name.toLowerCase()))
    .map((entry) => entry.name)
    .slice(0, 4)

  const overviewParts = readme
    ? [`Structural snapshot derived from top-level directories and ${readme.repoPath}.`]
    : ['Structural snapshot derived from top-level directories and key project manifests.']

  if (topLevelAreas.length > 0) {
    overviewParts.push(`Primary top-level areas include ${topLevelAreas.join(', ')}.`)
  }
  if (manifestNames.length > 0) {
    overviewParts.push(`Key manifests: ${manifestNames.join(', ')}.`)
  }
  if (readme) {
    overviewParts.push(`README summary: ${extractDocumentOverview(readme.content)}`)
  }

  return buildSnapshot(input, {
    systemOverview: overviewParts.join(' '),
    modules,
    interactions: buildGenericInteractions(modules),
    invariants: buildGenericInvariants(modules, readme?.repoPath ?? null),
    glossary: buildGenericGlossary(readme?.repoPath ?? null),
  })
}

async function indexElectronAppArchitecture(
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

  populateUsedBy(modules)

  const interactions: ArchitectureInteraction[] = INTERACTION_BLUEPRINTS.filter(
    (entry) => moduleIds.has(entry.from) && moduleIds.has(entry.to),
  ).map((entry) => ({
    ...entry,
    failureModes: [...entry.failureModes],
    notes: [...entry.notes],
  }))

  return buildSnapshot(input, {
    systemOverview: buildSystemOverview(moduleIds),
    modules,
    interactions,
    invariants: buildRelevantInvariants(moduleIds),
    glossary: buildRelevantGlossary(moduleIds),
  })
}

export async function indexProjectArchitecture(
  input: ProjectArchitectureIndexInput,
): Promise<ProjectArchitectureSnapshot | null> {
  const documentedArchitecture = await readArchitectureDocument(input.rootPath)
  if (documentedArchitecture) {
    return buildDocumentedArchitectureSnapshot(input, documentedArchitecture)
  }

  const electronArchitecture = await indexElectronAppArchitecture(input)
  if (electronArchitecture) {
    return electronArchitecture
  }

  const autosarArchitecture = await indexAutosarArchitecture(input)
  if (autosarArchitecture) {
    return autosarArchitecture
  }

  return await indexGenericArchitecture(input)
}
