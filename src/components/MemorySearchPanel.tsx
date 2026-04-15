import { useState, type FormEvent } from 'react'

import type {
  MemoryBackendStatus,
  MemorySearchHit,
  MemorySearchResult,
} from '../shared/memorySearch'
import type { ProjectSnapshot } from '../shared/session'

interface MemorySearchPanelProps {
  projects: ProjectSnapshot[]
  activeProjectId: string | null
  status: MemoryBackendStatus | null
  loading: boolean
  errorMessage: string | null
  result: MemorySearchResult | null
  onSearch: (query: string) => void
  onOpenSession: (sessionId: string) => void
}

function findProjectById(
  projects: ProjectSnapshot[],
  projectId: string | null | undefined,
): ProjectSnapshot | null {
  if (!projectId) {
    return null
  }

  return projects.find((project) => project.config.id === projectId) ?? null
}

function findSessionById(
  projects: ProjectSnapshot[],
  sessionId: string | null | undefined,
) {
  if (!sessionId) {
    return null
  }

  for (const project of projects) {
    const session =
      project.sessions.find((entry) => entry.config.id === sessionId) ?? null
    if (session) {
      return {
        project,
        session,
      }
    }
  }

  return null
}

function formatRoomLabel(room: string | null | undefined): string | null {
  if (!room) {
    return null
  }

  return room
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatTimestamp(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatTimeRange(hit: MemorySearchHit): string | null {
  const startLabel = formatTimestamp(hit.timestampStart)
  const endLabel = formatTimestamp(hit.timestampEnd)

  if (startLabel && endLabel && startLabel !== endLabel) {
    return `${startLabel} -> ${endLabel}`
  }

  return startLabel ?? endLabel ?? null
}

function formatScore(hit: MemorySearchHit): string | null {
  if (typeof hit.similarity === 'number') {
    return `Similarity ${hit.similarity.toFixed(2)}`
  }

  if (typeof hit.distance === 'number') {
    return `Distance ${hit.distance.toFixed(2)}`
  }

  return null
}

export function MemorySearchPanel({
  projects,
  activeProjectId,
  status,
  loading,
  errorMessage,
  result,
  onSearch,
  onOpenSession,
}: MemorySearchPanelProps) {
  const [query, setQuery] = useState('')
  const activeProject = findProjectById(projects, activeProjectId)
  const searchAvailable = status?.installState === 'installed'
  const trimmedQuery = query.trim()

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!trimmedQuery || loading || !searchAvailable) {
      return
    }

    onSearch(trimmedQuery)
  }

  return (
    <div className="sidebar-settings__section">
      <div className="sidebar-settings__section-header">
        <p className="sidebar-settings__eyebrow">Memory search</p>
        <span className="sidebar-settings__pill">
          {activeProject ? activeProject.config.title : 'All projects'}
        </span>
      </div>

      <p className="sidebar-settings__caption">
        {activeProject
          ? `Searches transcript memory for ${activeProject.config.title}.`
          : 'Searches transcript memory across all indexed projects.'}
      </p>

      <form className="sidebar-settings__search-form" onSubmit={handleSubmit}>
        <label className="sidebar-settings__field-label" htmlFor="memory-search-input">
          Search transcript memory
        </label>
        <div className="sidebar-settings__search-controls">
          <input
            id="memory-search-input"
            type="text"
            className="sidebar-settings__search-input"
            placeholder="Find decisions, logs, or prior commands"
            value={query}
            disabled={!searchAvailable || loading}
            onChange={(event) => {
              setQuery(event.target.value)
            }}
          />
          <button
            type="submit"
            className="ghost-button sidebar-settings__action"
            disabled={!searchAvailable || loading || trimmedQuery.length === 0}
          >
            {loading ? 'Searching...' : 'Search memory'}
          </button>
        </div>
      </form>

      {!searchAvailable ? (
        <p className="sidebar-settings__caption">
          Install MemPalace first to search transcript memory.
        </p>
      ) : null}

      {errorMessage ? (
        <p className="sidebar-settings__error">{errorMessage}</p>
      ) : null}

      {result?.warning ? (
        <p className="sidebar-settings__issue sidebar-settings__issue--warning">
          {result.warning}
        </p>
      ) : null}

      {result ? (
        <div className="sidebar-settings__search-results">
          <div className="sidebar-settings__status-row">
            <strong>
              {result.hitCount === 1 ? '1 hit' : `${result.hitCount} hits`}
            </strong>
            <span>{`Query: ${result.query}`}</span>
          </div>

          {result.hits.length === 0 ? (
            <p className="sidebar-settings__caption">
              No transcript memory matches that query yet.
            </p>
          ) : (
            result.hits.map((hit) => {
              const sourceSession = findSessionById(projects, hit.sessionId)
              const sourceProject =
                sourceSession?.project ??
                findProjectById(projects, hit.projectId) ??
                activeProject
              const sessionTitle = sourceSession?.session.config.title ?? null
              const projectTitle = sourceProject?.config.title ?? null
              const roomLabel = formatRoomLabel(hit.room)
              const timeRange = formatTimeRange(hit)
              const scoreLabel = formatScore(hit)

              return (
                <article key={hit.id} className="sidebar-settings__search-hit">
                  <div className="sidebar-settings__group-header">
                    <span className="sidebar-settings__field-label">
                      {sessionTitle ?? roomLabel ?? 'Transcript memory'}
                    </span>
                    {scoreLabel ? (
                      <span className="sidebar-settings__pill">{scoreLabel}</span>
                    ) : null}
                  </div>

                  {(projectTitle || roomLabel || timeRange) ? (
                    <p className="sidebar-settings__caption">
                      {[projectTitle, roomLabel, timeRange]
                        .filter(Boolean)
                        .join(' | ')}
                    </p>
                  ) : null}

                  <p className="sidebar-settings__search-preview">
                    {hit.textPreview}
                  </p>

                  {hit.sourceLabel ? (
                    <p className="sidebar-settings__search-source">
                      {hit.sourceLabel}
                    </p>
                  ) : null}

                  <div className="sidebar-settings__actions">
                    <button
                      type="button"
                      className="ghost-button sidebar-settings__action"
                      disabled={!hit.sessionId}
                      onClick={() => {
                        if (hit.sessionId) {
                          onOpenSession(hit.sessionId)
                        }
                      }}
                    >
                      {hit.sessionId ? 'Open session' : 'No session mapping'}
                    </button>
                  </div>
                </article>
              )
            })
          )}
        </div>
      ) : null}
    </div>
  )
}
