import { deriveMempalaceWing } from '../src/shared/memoryIndex'
import type { AssembledProjectContext, ProjectLocation } from '../src/shared/projectMemory'
import type { MemoryBackendStatus, MemorySearchHit, MemorySearchResult } from '../src/shared/memorySearch'
import type { ProjectConfig } from '../src/shared/session'

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

function uniqueFileReferences(results: MemorySearchResult[]): string[] {
  const seen = new Set<string>()
  const references: string[] = []

  for (const result of results) {
    for (const hit of result.hits) {
      const sourceLabel = hit.sourceLabel?.trim()
      if (!sourceLabel || seen.has(sourceLabel)) {
        continue
      }
      seen.add(sourceLabel)
      references.push(sourceLabel)
    }
  }

  return references
}

export class BootstrapComposer {
  private readonly memorySearch: StructuredMemorySearchSource

  constructor(memorySearch: StructuredMemorySearchSource) {
    this.memorySearch = memorySearch
  }

  async composeContext(input: {
    project: ProjectConfig
    location: ProjectLocation | null
    query?: string
  }): Promise<AssembledProjectContext> {
    const status = await this.getBackendStatus()
    if (!status || status.installState !== 'installed') {
      return this.buildEmptyContext(input)
    }

    const wing = deriveMempalaceWing(input.project, input.location)
    const query = input.query?.trim()
    const [
      summaryResult,
      architectureResult,
      decisions,
      preferences,
      workflows,
      troubleshooting,
      criticalFiles,
    ] =
      await Promise.all([
        this.memorySearch.search({
          query: query || 'latest summary',
          projectId: input.project.id,
          wing,
          room: 'session-summary',
          limit: 1,
        }),
        this.memorySearch.search({
          query: query || 'architecture overview',
          projectId: input.project.id,
          wing,
          room: 'architecture',
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
      hasHits(architectureResult) ||
      hasHits(decisions) ||
      hasHits(preferences) ||
      hasHits(workflows) ||
      hasHits(troubleshooting) ||
      hasHits(criticalFiles)

    if (!hasStructuredMaterial) {
      return this.buildEmptyContext(input)
    }

    const summaryLine = summaryResult.hits[0]?.textPreview ?? null
    const architectureLine = architectureResult.hits[0]?.textPreview ?? null
    const decisionPreview = formatPreview(decisions.hits, 4)
    const preferencePreview = formatPreview(preferences.hits, 4)
    const workflowPreview = formatPreview(workflows.hits, 4)
    const troubleshootingPreview = formatPreview(troubleshooting.hits, 4)
    const criticalFilesPreview = formatPreview(criticalFiles.hits, 5)
    const fileReferences = uniqueFileReferences([
      summaryResult,
      architectureResult,
      decisions,
      preferences,
      workflows,
      troubleshooting,
      criticalFiles,
    ])

    const bootstrapParts = [
      'Use the project memory for this logical project before proceeding.',
      fileReferences.length > 0 ? 'Read:' : null,
      ...fileReferences.map((filePath) => `- ${filePath}`),
      input.location ? `Current local checkout: ${input.location.label}` : null,
      summaryLine ? `Latest summary: ${summaryLine}` : null,
      architectureLine ? `Architecture overview: ${architectureLine}` : null,
      decisionPreview ? `Active decisions:\n${decisionPreview}` : null,
      preferencePreview ? `Project preferences:\n${preferencePreview}` : null,
      workflowPreview ? `Component workflows:\n${workflowPreview}` : null,
      troubleshootingPreview
        ? `Troubleshooting patterns:\n${troubleshootingPreview}`
        : null,
      criticalFilesPreview ? `Critical files:\n${criticalFilesPreview}` : null,
    ].filter((value): value is string => Boolean(value))

    return {
      projectId: input.project.id,
      locationId: input.location?.id ?? null,
      generatedAt: new Date().toISOString(),
      bootstrapMessage: bootstrapParts.join('\n'),
      fileReferences,
      summaryExcerpt: summaryLine,
      architectureExcerpt: architectureLine,
    }
  }

  private async getBackendStatus(): Promise<MemoryBackendStatus | null> {
    try {
      return await this.memorySearch.getStatus()
    } catch {
      return null
    }
  }

  private buildEmptyContext(input: {
    project: ProjectConfig
    location: ProjectLocation | null
  }): AssembledProjectContext {
    return {
      projectId: input.project.id,
      locationId: input.location?.id ?? null,
      generatedAt: new Date().toISOString(),
      bootstrapMessage: null,
      fileReferences: [],
      summaryExcerpt: null,
      architectureExcerpt: null,
    }
  }
}
