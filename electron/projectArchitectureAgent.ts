import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import type { ProjectLocation } from '../src/shared/projectMemory'
import type {
  ArchitectureGlossaryTerm,
  ArchitectureInteraction,
  ArchitectureInvariant,
  ArchitectureModuleCard,
  ArchitectureModuleKind,
  ProjectArchitectureSnapshot,
} from '../src/shared/projectArchitecture'
import {
  ARCHITECTURE_MODULE_KINDS,
} from '../src/shared/projectArchitecture'
import type { ProjectConfig } from '../src/shared/session'
import type { SkillAiMergeAgent } from '../src/shared/skills'
import { loadProjectMemorySkill } from './projectMemorySkillLoader'
import {
  prepareStructuredAgent,
  runStructuredAgent,
  truncateUtf8,
} from './structuredAgentRunner'
import type { PreparedStructuredAgent } from './structuredAgentRunner'

const MAX_ARCHITECTURE_PROMPT_BYTES = 240_000
const MAX_HEURISTIC_DIGEST_BYTES = 48_000
const MAX_TEXT_EXCERPT_BYTES = 20_000
const AGENTS_CANDIDATES = ['AGENTS.md']
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

interface ArchitectureAgentResponse {
  systemOverview: string
  modules: ArchitectureModuleCard[]
  interactions: ArchitectureInteraction[]
  invariants: ArchitectureInvariant[]
  glossary: ArchitectureGlossaryTerm[]
}

export interface ProjectArchitectureExtractor {
  extract(input: {
    project: ProjectConfig
    location: ProjectLocation | null
    heuristicSnapshot: ProjectArchitectureSnapshot | null
  }): Promise<ProjectArchitectureSnapshot | null>

  prepare?(input: {
    project: ProjectConfig
    location: ProjectLocation | null
    heuristicSnapshot: ProjectArchitectureSnapshot | null
  }): Promise<PreparedStructuredAgent>
}

export function finalizeArchitectureExtraction(
  rawOutput: string,
  project: ProjectConfig,
): ProjectArchitectureSnapshot | null {
  const response = parseArchitectureResponse(rawOutput)

  if (
    !response.systemOverview &&
    response.modules.length === 0 &&
    response.interactions.length === 0
  ) {
    return null
  }

  return {
    projectId: deriveArchitectureProjectId(project),
    title: deriveArchitectureTitle(project),
    generatedAt: new Date().toISOString(),
    systemOverview: response.systemOverview,
    modules: response.modules,
    interactions: response.interactions,
    invariants: response.invariants,
    glossary: response.glossary,
  }
}

const VALID_MODULE_KINDS = new Set(ARCHITECTURE_MODULE_KINDS)

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || 'project'
}

function deriveArchitectureProjectId(project: ProjectConfig): string {
  const remoteFingerprint = project.identity?.remoteFingerprint?.trim()
  if (remoteFingerprint) {
    return `remote-${slugify(remoteFingerprint)}`
  }

  return `project-${project.id}`
}

function deriveArchitectureTitle(project: ProjectConfig): string {
  const remoteFingerprint = project.identity?.remoteFingerprint?.trim()
  if (!remoteFingerprint) {
    return project.title
  }

  const repoName = remoteFingerprint.split('/').filter(Boolean).at(-1)
  return repoName ? repoName.replace(/\.git$/i, '') : project.title
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.min(1, Math.max(0, value))
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.flatMap((value) => (typeof value === 'string' ? [value.trim()] : [])).filter(Boolean))]
}

function normalizeModule(
  value: unknown,
  index: number,
): ArchitectureModuleCard | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<ArchitectureModuleCard>
  const name = normalizeText(candidate.name)
  const responsibility = normalizeText(candidate.responsibility)
  const kind =
    typeof candidate.kind === 'string' &&
    VALID_MODULE_KINDS.has(candidate.kind as ArchitectureModuleKind)
      ? (candidate.kind as ArchitectureModuleKind)
      : null

  if (!name || !responsibility || !kind) {
    return null
  }

  const id = normalizeText(candidate.id) || `module-${index + 1}`
  return {
    id,
    name,
    kind,
    paths: uniqueStrings(Array.isArray(candidate.paths) ? candidate.paths : []),
    responsibility,
    owns: uniqueStrings(Array.isArray(candidate.owns) ? candidate.owns : []),
    dependsOn: uniqueStrings(
      Array.isArray(candidate.dependsOn) ? candidate.dependsOn : [],
    ),
    usedBy: uniqueStrings(Array.isArray(candidate.usedBy) ? candidate.usedBy : []),
    publicInterfaces: uniqueStrings(
      Array.isArray(candidate.publicInterfaces) ? candidate.publicInterfaces : [],
    ),
    keyTypes: uniqueStrings(
      Array.isArray(candidate.keyTypes) ? candidate.keyTypes : [],
    ),
    invariants: uniqueStrings(
      Array.isArray(candidate.invariants) ? candidate.invariants : [],
    ),
    changeGuidance: uniqueStrings(
      Array.isArray(candidate.changeGuidance) ? candidate.changeGuidance : [],
    ),
    testLocations: uniqueStrings(
      Array.isArray(candidate.testLocations) ? candidate.testLocations : [],
    ),
    confidence: clampConfidence(candidate.confidence ?? 0.75),
  }
}

function normalizeInteraction(
  value: unknown,
  index: number,
): ArchitectureInteraction | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<ArchitectureInteraction>
  const from = normalizeText(candidate.from)
  const to = normalizeText(candidate.to)
  const via = normalizeText(candidate.via)
  const purpose = normalizeText(candidate.purpose)
  const trigger = normalizeText(candidate.trigger)
  if (!from || !to || !via || !purpose || !trigger) {
    return null
  }

  return {
    id: normalizeText(candidate.id) || `interaction-${index + 1}`,
    from,
    to,
    via,
    purpose,
    trigger,
    failureModes: uniqueStrings(
      Array.isArray(candidate.failureModes) ? candidate.failureModes : [],
    ),
    notes: uniqueStrings(Array.isArray(candidate.notes) ? candidate.notes : []),
  }
}

function normalizeInvariant(
  value: unknown,
  index: number,
): ArchitectureInvariant | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<ArchitectureInvariant>
  const statement = normalizeText(candidate.statement)
  if (!statement) {
    return null
  }

  return {
    id: normalizeText(candidate.id) || `invariant-${index + 1}`,
    statement,
    relatedModules: uniqueStrings(
      Array.isArray(candidate.relatedModules) ? candidate.relatedModules : [],
    ),
  }
}

function normalizeGlossaryTerm(value: unknown): ArchitectureGlossaryTerm | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<ArchitectureGlossaryTerm>
  const term = normalizeText(candidate.term)
  const meaning = normalizeText(candidate.meaning)
  if (!term || !meaning) {
    return null
  }

  return { term, meaning }
}

function buildSchema(): string {
  return JSON.stringify(
    {
      type: 'object',
      additionalProperties: false,
      required: [
        'systemOverview',
        'modules',
        'interactions',
        'invariants',
        'glossary',
      ],
      properties: {
        systemOverview: {
          type: 'string',
        },
        modules: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'name', 'kind', 'paths', 'responsibility', 'confidence'],
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              kind: {
                type: 'string',
                enum: ARCHITECTURE_MODULE_KINDS,
              },
              paths: {
                type: 'array',
                items: { type: 'string' },
              },
              responsibility: { type: 'string' },
              owns: {
                type: 'array',
                items: { type: 'string' },
              },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
              },
              usedBy: {
                type: 'array',
                items: { type: 'string' },
              },
              publicInterfaces: {
                type: 'array',
                items: { type: 'string' },
              },
              keyTypes: {
                type: 'array',
                items: { type: 'string' },
              },
              invariants: {
                type: 'array',
                items: { type: 'string' },
              },
              changeGuidance: {
                type: 'array',
                items: { type: 'string' },
              },
              testLocations: {
                type: 'array',
                items: { type: 'string' },
              },
              confidence: { type: 'number' },
            },
          },
        },
        interactions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'from', 'to', 'via', 'purpose', 'trigger'],
            properties: {
              id: { type: 'string' },
              from: { type: 'string' },
              to: { type: 'string' },
              via: { type: 'string' },
              purpose: { type: 'string' },
              trigger: { type: 'string' },
              failureModes: {
                type: 'array',
                items: { type: 'string' },
              },
              notes: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
        invariants: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'statement', 'relatedModules'],
            properties: {
              id: { type: 'string' },
              statement: { type: 'string' },
              relatedModules: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
        glossary: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['term', 'meaning'],
            properties: {
              term: { type: 'string' },
              meaning: { type: 'string' },
            },
          },
        },
      },
    },
    null,
    2,
  )
}

async function listTopLevelEntries(rootPath: string): Promise<string[]> {
  try {
    const entries = await readdir(rootPath, { withFileTypes: true })
    return entries
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 40)
  } catch {
    return []
  }
}

async function readFirstExistingExcerpt(
  rootPath: string,
  relativePaths: string[],
): Promise<string | null> {
  for (const relativePath of relativePaths) {
    try {
      const content = await readFile(path.join(rootPath, relativePath), 'utf8')
      const normalized = content.trim()
      if (normalized) {
        return `${relativePath}\n${truncateUtf8(normalized, MAX_TEXT_EXCERPT_BYTES)}`
      }
    } catch {
      continue
    }
  }

  return null
}

function buildHeuristicDigest(snapshot: ProjectArchitectureSnapshot | null): string {
  if (!snapshot) {
    return 'No heuristic architecture snapshot was available.'
  }

  const moduleLines = snapshot.modules.slice(0, 10).map((module) => {
    const paths = module.paths[0] ? ` [${module.paths[0]}]` : ''
    return `- ${module.name}${paths}: ${module.responsibility}`
  })
  const interactionLines = snapshot.interactions.slice(0, 8).map((interaction) => {
    return `- ${interaction.from} -> ${interaction.to} via ${interaction.via}: ${interaction.purpose}`
  })

  return truncateUtf8(
    [
      `System overview: ${snapshot.systemOverview}`,
      moduleLines.length > 0 ? 'Heuristic modules:' : null,
      ...moduleLines,
      interactionLines.length > 0 ? 'Heuristic interactions:' : null,
      ...interactionLines,
    ]
      .filter(Boolean)
      .join('\n'),
    MAX_HEURISTIC_DIGEST_BYTES,
  )
}

function buildPrompt(input: {
  project: ProjectConfig
  location: ProjectLocation | null
  heuristicSnapshot: ProjectArchitectureSnapshot | null
  topLevelEntries: string[]
  agentsExcerpt: string | null
  readmeExcerpt: string | null
  architectureDocExcerpt: string | null
  skillGuidance: string | null
}): string {
  return truncateUtf8(
    [
      'You are synthesizing a durable repository architecture reference for Agent CLIs.',
      'Return only structured JSON matching the provided schema.',
      'Use the repository as the source of truth. You may inspect files, but do not modify the repository.',
      'The output should help a future agent quickly understand:',
      '- the major subsystems and ownership boundaries',
      '- where state or lifecycle control lives',
      '- how work flows between components',
      '- what invariants and edit boundaries must be preserved',
      '- which files or modules matter first when changing behavior',
      'Prefer project-specific terminology and relative repo paths.',
      'If the evidence is weak, return fewer modules and interactions rather than inventing detail.',
      '',
      'Task skill guidance:',
      input.skillGuidance ?? '(none found)',
      `Project title: ${input.project.title}`,
      `Repository root: ${input.location?.rootPath ?? input.project.rootPath}`,
      `Remote fingerprint: ${input.project.identity?.remoteFingerprint ?? 'n/a'}`,
      `Current checkout label: ${input.location?.label ?? 'n/a'}`,
      input.topLevelEntries.length > 0
        ? `Top-level entries: ${input.topLevelEntries.join(', ')}`
        : 'Top-level entries: unavailable',
      '',
      'Repository guidance excerpt:',
      input.agentsExcerpt ?? '(none found)',
      '',
      'README excerpt:',
      input.readmeExcerpt ?? '(none found)',
      '',
      'Existing architecture-doc excerpt:',
      input.architectureDocExcerpt ?? '(none found)',
      '',
      'Heuristic evidence snapshot:',
      buildHeuristicDigest(input.heuristicSnapshot),
    ].join('\n'),
    MAX_ARCHITECTURE_PROMPT_BYTES,
  )
}

function parseArchitectureResponse(rawOutput: string): ArchitectureAgentResponse {
  const parsed = JSON.parse(rawOutput) as Partial<ArchitectureAgentResponse>
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Architecture extraction returned invalid JSON.')
  }

  return {
    systemOverview: normalizeText(parsed.systemOverview),
    modules: Array.isArray(parsed.modules)
      ? parsed.modules
          .map((module, index) => normalizeModule(module, index))
          .filter((module): module is ArchitectureModuleCard => module !== null)
      : [],
    interactions: Array.isArray(parsed.interactions)
      ? parsed.interactions
          .map((interaction, index) => normalizeInteraction(interaction, index))
          .filter((interaction): interaction is ArchitectureInteraction => interaction !== null)
      : [],
    invariants: Array.isArray(parsed.invariants)
      ? parsed.invariants
          .map((invariant, index) => normalizeInvariant(invariant, index))
          .filter((invariant): invariant is ArchitectureInvariant => invariant !== null)
      : [],
    glossary: Array.isArray(parsed.glossary)
      ? parsed.glossary
          .map((entry) => normalizeGlossaryTerm(entry))
          .filter((entry): entry is ArchitectureGlossaryTerm => entry !== null)
      : [],
  }
}

export class ProjectArchitectureAgentExtractor
  implements ProjectArchitectureExtractor
{
  private readonly getAgent: () => SkillAiMergeAgent

  constructor(getAgent: () => SkillAiMergeAgent) {
    this.getAgent = getAgent
  }

  async extract(input: {
    project: ProjectConfig
    location: ProjectLocation | null
    heuristicSnapshot: ProjectArchitectureSnapshot | null
  }): Promise<ProjectArchitectureSnapshot | null> {
    const rootPath = input.location?.rootPath ?? input.project.rootPath
    const [topLevelEntries, agentsExcerpt, readmeExcerpt, architectureDocExcerpt, skill] =
      await Promise.all([
      listTopLevelEntries(rootPath),
      readFirstExistingExcerpt(rootPath, AGENTS_CANDIDATES),
      readFirstExistingExcerpt(rootPath, README_CANDIDATES),
      readFirstExistingExcerpt(rootPath, ARCHITECTURE_DOC_CANDIDATES),
      loadProjectMemorySkill('project-memory-architecture-analysis'),
    ])
    const schema = buildSchema()
    const prompt = buildPrompt({
      ...input,
      topLevelEntries,
      agentsExcerpt,
      readmeExcerpt,
      architectureDocExcerpt,
      skillGuidance: skill?.markdown ?? null,
    })
    const rawOutput = await runStructuredAgent({
      agent: this.getAgent(),
      schema,
      prompt,
      contextDirectories: [
        input.location?.rootPath ?? '',
        input.project.identity?.repoRoot ?? '',
        input.project.rootPath,
        skill?.directory ?? '',
      ],
    })
    const response = parseArchitectureResponse(rawOutput)

    if (
      !response.systemOverview &&
      response.modules.length === 0 &&
      response.interactions.length === 0
    ) {
      return null
    }

    return {
      projectId: deriveArchitectureProjectId(input.project),
      title: deriveArchitectureTitle(input.project),
      generatedAt: new Date().toISOString(),
      systemOverview: response.systemOverview,
      modules: response.modules,
      interactions: response.interactions,
      invariants: response.invariants,
      glossary: response.glossary,
    }
  }

  async prepare(input: {
    project: ProjectConfig
    location: ProjectLocation | null
    heuristicSnapshot: ProjectArchitectureSnapshot | null
  }): Promise<PreparedStructuredAgent> {
    const rootPath = input.location?.rootPath ?? input.project.rootPath
    const [topLevelEntries, agentsExcerpt, readmeExcerpt, architectureDocExcerpt, skill] =
      await Promise.all([
      listTopLevelEntries(rootPath),
      readFirstExistingExcerpt(rootPath, AGENTS_CANDIDATES),
      readFirstExistingExcerpt(rootPath, README_CANDIDATES),
      readFirstExistingExcerpt(rootPath, ARCHITECTURE_DOC_CANDIDATES),
      loadProjectMemorySkill('project-memory-architecture-analysis'),
    ])
    const schema = buildSchema()
    const prompt = buildPrompt({
      ...input,
      topLevelEntries,
      agentsExcerpt,
      readmeExcerpt,
      architectureDocExcerpt,
      skillGuidance: skill?.markdown ?? null,
    })
    return await prepareStructuredAgent({
      agent: this.getAgent(),
      schema,
      prompt,
      contextDirectories: [
        input.location?.rootPath ?? '',
        input.project.identity?.repoRoot ?? '',
        input.project.rootPath,
        skill?.directory ?? '',
      ],
    })
  }
}
