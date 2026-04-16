import { deriveMempalaceWing } from '../src/shared/memoryIndex'
import type { AssembledProjectContext, ProjectLocation } from '../src/shared/projectMemory'
import type { MemoryBackendStatus, MemorySearchHit, MemorySearchResult } from '../src/shared/memorySearch'
import type { ProjectConfig } from '../src/shared/session'

interface LegacyBootstrapSource {
  assembleContext(input: {
    project: ProjectConfig
    location: ProjectLocation | null
    query?: string
  }): Promise<AssembledProjectContext>
}

interface StructuredMemorySearchSource {
  getStatus(): Promise<MemoryBackendStatus>
  search(input: {
    query: string
    projectId?: string | null
    wing?: string | null
    room?: string | null
    limit?: number
  }): Promise<MemorySearchResult>
}

function formatPreview(items: MemorySearchHit[], limit: number): string | null {
  const lines = items
    .slice(0, limit)
    .map((entry) => entry.textPreview.trim())
    .filter(Boolean)
    .map((entry) => `- ${entry}`)

  return lines.length > 0 ? lines.join('\n') : null
}

function hasHits(result: MemorySearchResult | null | undefined): boolean {
  return (result?.hits.length ?? 0) > 0
}

export class BootstrapComposer {
  private readonly legacySource: LegacyBootstrapSource
  private readonly memorySearch: StructuredMemorySearchSource

  constructor(
    legacySource: LegacyBootstrapSource,
    memorySearch: StructuredMemorySearchSource,
  ) {
    this.legacySource = legacySource
    this.memorySearch = memorySearch
  }

  async composeContext(input: {
    project: ProjectConfig
    location: ProjectLocation | null
    query?: string
  }): Promise<AssembledProjectContext> {
    const fallback = await this.legacySource.assembleContext(input)

    const status = await this.getBackendStatus()
    if (!status || status.installState !== 'installed') {
      return fallback
    }

    const wing = deriveMempalaceWing(input.project, input.location)
    const query = input.query?.trim() ?? ''
    const [summaryResult, decisions, preferences, workflows, troubleshooting, criticalFiles] =
      await Promise.all([
        this.memorySearch.search({
          query: query || 'latest summary',
          projectId: input.project.id,
          wing,
          room: 'session-summary',
          limit: 1,
        }),
        this.memorySearch.search({
          query: query || 'key decisions',
          projectId: input.project.id,
          wing,
          room: 'decision',
          limit: 4,
        }),
        this.memorySearch.search({
          query: query || 'project preferences',
          projectId: input.project.id,
          wing,
          room: 'preference',
          limit: 4,
        }),
        this.memorySearch.search({
          query: query || 'workflows',
          projectId: input.project.id,
          wing,
          room: 'workflow',
          limit: 4,
        }),
        this.memorySearch.search({
          query: query || 'troubleshooting',
          projectId: input.project.id,
          wing,
          room: 'troubleshooting',
          limit: 4,
        }),
        this.memorySearch.search({
          query: query || 'critical files',
          projectId: input.project.id,
          wing,
          room: 'critical-file',
          limit: 5,
        }),
      ])

    const hasStructuredMaterial =
      hasHits(summaryResult) ||
      hasHits(decisions) ||
      hasHits(preferences) ||
      hasHits(workflows) ||
      hasHits(troubleshooting) ||
      hasHits(criticalFiles)

    if (!hasStructuredMaterial) {
      return fallback
    }

    const summaryLine =
      summaryResult.hits[0]?.textPreview ??
      fallback.summaryExcerpt ??
      null
    const decisionPreview = formatPreview(decisions.hits, 4)
    const preferencePreview = formatPreview(preferences.hits, 4)
    const workflowPreview = formatPreview(workflows.hits, 4)
    const troubleshootingPreview = formatPreview(troubleshooting.hits, 4)
    const criticalFilesPreview = formatPreview(criticalFiles.hits, 5)

    const bootstrapParts = [
      'Use the project memory for this logical project before proceeding.',
      fallback.fileReferences.length > 0 ? 'Read:' : null,
      ...fallback.fileReferences.map((filePath) => `- ${filePath}`),
      input.location ? `Current local checkout: ${input.location.label}` : null,
      summaryLine ? `Latest summary: ${summaryLine}` : null,
      fallback.architectureExcerpt
        ? `Architecture overview: ${fallback.architectureExcerpt}`
        : null,
      decisionPreview ? `Active decisions:\n${decisionPreview}` : null,
      preferencePreview ? `Project preferences:\n${preferencePreview}` : null,
      workflowPreview ? `Component workflows:\n${workflowPreview}` : null,
      troubleshootingPreview
        ? `Troubleshooting patterns:\n${troubleshootingPreview}`
        : null,
      criticalFilesPreview ? `Critical files:\n${criticalFilesPreview}` : null,
    ].filter((value): value is string => Boolean(value))

    return {
      ...fallback,
      generatedAt: new Date().toISOString(),
      bootstrapMessage: bootstrapParts.join('\n'),
      summaryExcerpt: summaryLine,
    }
  }

  private async getBackendStatus(): Promise<MemoryBackendStatus | null> {
    try {
      return await this.memorySearch.getStatus()
    } catch {
      return null
    }
  }
}
