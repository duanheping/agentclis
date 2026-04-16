import { useCallback, useEffect, useRef, useState } from 'react'

import type { TranscriptEvent } from '../shared/projectMemory'
import type { SessionSnapshot } from '../shared/session'

type SessionReviewTab = 'summary' | 'transcript' | 'search' | 'raw'

interface SessionReviewPanelProps {
  session: SessionSnapshot | null
  open: boolean
  onClose?: () => void
}

interface TranscriptSectionState {
  events: TranscriptEvent[]
  nextCursor: string | null
  loading: boolean
  errorMessage: string | null
}

const DEFAULT_TRANSCRIPT_PAGE_LIMIT = 40
const DEFAULT_SEARCH_PAGE_LIMIT = 25
const REVIEW_TABS: Array<{ id: SessionReviewTab; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'transcript', label: 'Transcript' },
  { id: 'search', label: 'Search' },
  { id: 'raw', label: 'Raw' },
]

function buildEmptySectionState(): TranscriptSectionState {
  return {
    events: [],
    nextCursor: null,
    loading: false,
    errorMessage: null,
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown error.'
}

function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return 'Unavailable'
  }

  return value.replace('T', ' ').replace('.000Z', 'Z')
}

function formatEventLabel(event: TranscriptEvent): string {
  if (event.kind === 'output') {
    return 'Output'
  }

  if (event.kind === 'input') {
    return event.source === 'user' ? 'User input' : 'System input'
  }

  if (event.kind === 'runtime') {
    return 'Runtime'
  }

  return 'System'
}

function summarizeEvent(event: TranscriptEvent): string {
  const chunk = event.chunk?.trim()
  if (chunk) {
    return chunk
  }

  if (event.metadata && Object.keys(event.metadata).length > 0) {
    return JSON.stringify(event.metadata)
  }

  return `${formatEventLabel(event)} event`
}

function SessionTranscriptList({
  emptyLabel,
  events,
}: {
  emptyLabel: string
  events: TranscriptEvent[]
}) {
  if (events.length === 0) {
    return (
      <div className="session-review-panel__state">
        <p>{emptyLabel}</p>
      </div>
    )
  }

  return (
    <div className="session-review-panel__events">
      {events.map((event) => (
        <article
          key={event.id}
          className={`session-review-panel__event is-${event.kind}`}
        >
          <div className="session-review-panel__event-meta">
            <span className="session-review-panel__event-kind">
              {formatEventLabel(event)}
            </span>
            <span className="session-review-panel__event-time">
              {formatTimestamp(event.timestamp)}
            </span>
          </div>
          <p className="session-review-panel__event-text">{summarizeEvent(event)}</p>
        </article>
      ))}
    </div>
  )
}

export function SessionReviewPanel({
  session,
  open,
  onClose,
}: SessionReviewPanelProps) {
  const sessionId = session?.config.id ?? null
  const [activeTab, setActiveTab] = useState<SessionReviewTab>('summary')
  const [transcript, setTranscript] = useState<TranscriptSectionState>(() =>
    buildEmptySectionState(),
  )
  const [searchState, setSearchState] = useState<TranscriptSectionState>(() =>
    buildEmptySectionState(),
  )
  const [searchQuery, setSearchQuery] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const sessionIdRef = useRef<string | null>(session?.config.id ?? null)
  const transcriptRequestTokenRef = useRef(0)
  const searchRequestTokenRef = useRef(0)

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  useEffect(() => {
    if (!open) {
      return
    }

    setActiveTab('summary')
    setTranscript(buildEmptySectionState())
    setSearchState(buildEmptySectionState())
    setSearchQuery('')
    setSubmittedSearch('')
    transcriptRequestTokenRef.current += 1
    searchRequestTokenRef.current += 1
  }, [open, sessionId])

  const loadTranscriptPage = useCallback(async (
    options: {
      append?: boolean
      cursor?: string | null
      limit?: number
      search?: string | null
    } = {},
  ): Promise<void> => {
    if (!sessionId) {
      return
    }

    const append = options.append ?? false
    const token = ++transcriptRequestTokenRef.current
    setTranscript((current) => ({
      ...current,
      loading: true,
      errorMessage: null,
    }))

    try {
      const page = await window.agentCli.getSessionTranscriptPage({
        sessionId,
        cursor: options.cursor,
        limit: options.limit ?? DEFAULT_TRANSCRIPT_PAGE_LIMIT,
        search: options.search,
      })
      if (
        transcriptRequestTokenRef.current !== token ||
        sessionIdRef.current !== sessionId
      ) {
        return
      }

      setTranscript((current) => ({
        events: append ? [...current.events, ...page.events] : page.events,
        nextCursor: page.nextCursor,
        loading: false,
        errorMessage: null,
      }))
    } catch (error) {
      if (
        transcriptRequestTokenRef.current !== token ||
        sessionIdRef.current !== sessionId
      ) {
        return
      }

      setTranscript((current) => ({
        ...current,
        loading: false,
        errorMessage: getErrorMessage(error),
      }))
    }
  }, [sessionId])

  const loadSearchPage = useCallback(async (
    query: string,
    options: {
      append?: boolean
      cursor?: string | null
    } = {},
  ): Promise<void> => {
    const normalizedQuery = query.trim()
    if (!sessionId || !normalizedQuery) {
      return
    }

    const append = options.append ?? false
    const token = ++searchRequestTokenRef.current
    setSearchState((current) => ({
      ...current,
      loading: true,
      errorMessage: null,
    }))

    try {
      const page = await window.agentCli.getSessionTranscriptPage({
        sessionId,
        cursor: options.cursor,
        limit: DEFAULT_SEARCH_PAGE_LIMIT,
        search: normalizedQuery,
      })
      if (
        searchRequestTokenRef.current !== token ||
        sessionIdRef.current !== sessionId
      ) {
        return
      }

      setSubmittedSearch(normalizedQuery)
      setSearchState((current) => ({
        events: append ? [...current.events, ...page.events] : page.events,
        nextCursor: page.nextCursor,
        loading: false,
        errorMessage: null,
      }))
    } catch (error) {
      if (
        searchRequestTokenRef.current !== token ||
        sessionIdRef.current !== sessionId
      ) {
        return
      }

      setSearchState((current) => ({
        ...current,
        loading: false,
        errorMessage: getErrorMessage(error),
      }))
    }
  }, [sessionId])

  useEffect(() => {
    if (!open || !sessionId) {
      return
    }

    if (
      (activeTab === 'transcript' || activeTab === 'raw') &&
      transcript.events.length === 0 &&
      !transcript.loading &&
      !transcript.errorMessage
    ) {
      void loadTranscriptPage()
    }
  }, [
    activeTab,
    loadTranscriptPage,
    open,
    sessionId,
    transcript.errorMessage,
    transcript.events.length,
    transcript.loading,
  ])

  if (!open || !session) {
    return null
  }

  const restore = session.restore
  const transcriptReady = transcript.events.length > 0
  const rawContent = transcript.events
    .map((event) => JSON.stringify(event, null, 2))
    .join('\n\n')

  return (
    <aside className="session-review-panel">
      <header className="session-review-panel__header">
        <div>
          <p className="session-review-panel__eyebrow">Review full content</p>
          <h2>{session.config.title}</h2>
          <p className="session-review-panel__subhead">
            {restore?.statusSummary ?? 'Session history'}
          </p>
        </div>
        {onClose ? (
          <button
            type="button"
            className="ghost-button session-review-panel__close"
            onClick={onClose}
          >
            Close
          </button>
        ) : null}
      </header>

      <div className="session-review-panel__tabs" role="tablist" aria-label="Session review tabs">
        {REVIEW_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`session-review-panel__tab${activeTab === tab.id ? ' is-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="session-review-panel__body">
        {activeTab === 'summary' ? (
          <div className="session-review-panel__summary">
            <div className="session-review-panel__summary-grid">
              <div className="session-review-panel__summary-card">
                <span className="session-review-panel__summary-label">Status</span>
                <strong>{restore?.statusSummary ?? 'Unavailable'}</strong>
              </div>
              <div className="session-review-panel__summary-card">
                <span className="session-review-panel__summary-label">Updated</span>
                <strong>{formatTimestamp(restore?.updatedAt ?? session.runtime.lastActiveAt)}</strong>
              </div>
              <div className="session-review-panel__summary-card">
                <span className="session-review-panel__summary-label">Transcript</span>
                <strong>{restore?.hasTranscript ? 'Available' : 'Unavailable'}</strong>
              </div>
              <div className="session-review-panel__summary-card">
                <span className="session-review-panel__summary-label">Replay</span>
                <strong>{restore?.hasTerminalReplay ? 'Ready' : 'Unavailable'}</strong>
              </div>
            </div>

            <div className="session-review-panel__summary-list">
              {restore?.blockedReason ? (
                <div className="session-review-panel__summary-item">
                  <span>Attention</span>
                  <p>{restore.blockedReason}</p>
                </div>
              ) : null}
              {restore?.resultSummary ? (
                <div className="session-review-panel__summary-item">
                  <span>Result</span>
                  <p>{restore.resultSummary}</p>
                </div>
              ) : null}
              {restore?.lastError ? (
                <div className="session-review-panel__summary-item">
                  <span>Last error</span>
                  <p>{restore.lastError}</p>
                </div>
              ) : null}
              {restore?.lastMeaningfulReply ? (
                <div className="session-review-panel__summary-item">
                  <span>Latest reply</span>
                  <p>{restore.lastMeaningfulReply}</p>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {activeTab === 'transcript' ? (
          <div className="session-review-panel__section">
            {transcript.errorMessage ? (
              <p className="session-review-panel__error">{transcript.errorMessage}</p>
            ) : null}
            {transcript.loading && transcript.events.length === 0 ? (
              <div className="session-review-panel__state">
                <p>Loading transcript…</p>
              </div>
            ) : (
              <SessionTranscriptList
                emptyLabel="No transcript events have been stored yet."
                events={transcript.events}
              />
            )}
            {transcript.nextCursor ? (
              <button
                type="button"
                className="ghost-button session-review-panel__load-more"
                disabled={transcript.loading}
                onClick={() =>
                  void loadTranscriptPage({
                    append: true,
                    cursor: transcript.nextCursor,
                  })
                }
              >
                {transcript.loading ? 'Loading…' : 'Load older entries'}
              </button>
            ) : null}
          </div>
        ) : null}

        {activeTab === 'search' ? (
          <div className="session-review-panel__section">
            <form
              className="session-review-panel__search"
              onSubmit={(event) => {
                event.preventDefault()
                void loadSearchPage(searchQuery)
              }}
            >
              <input
                type="search"
                value={searchQuery}
                placeholder="Search transcript text"
                onChange={(event) => setSearchQuery(event.target.value)}
              />
              <button
                type="submit"
                className="ghost-button"
                disabled={!searchQuery.trim() || searchState.loading}
              >
                {searchState.loading ? 'Searching…' : 'Search'}
              </button>
            </form>

            {searchState.errorMessage ? (
              <p className="session-review-panel__error">{searchState.errorMessage}</p>
            ) : null}

            {!submittedSearch && !searchState.loading ? (
              <div className="session-review-panel__state">
                <p>Search the stored transcript for replies, errors, or tool output.</p>
              </div>
            ) : null}

            {submittedSearch ? (
              <>
                <p className="session-review-panel__search-summary">
                  Results for <strong>{submittedSearch}</strong>
                </p>
                <SessionTranscriptList
                  emptyLabel="No transcript matches were found."
                  events={searchState.events}
                />
                {searchState.nextCursor ? (
                  <button
                    type="button"
                    className="ghost-button session-review-panel__load-more"
                    disabled={searchState.loading}
                    onClick={() =>
                      void loadSearchPage(submittedSearch, {
                        append: true,
                        cursor: searchState.nextCursor,
                      })
                    }
                  >
                    {searchState.loading ? 'Loading…' : 'Load older matches'}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        {activeTab === 'raw' ? (
          <div className="session-review-panel__section">
            {transcript.errorMessage ? (
              <p className="session-review-panel__error">{transcript.errorMessage}</p>
            ) : null}
            {transcript.loading && !transcriptReady ? (
              <div className="session-review-panel__state">
                <p>Loading raw transcript…</p>
              </div>
            ) : transcriptReady ? (
              <pre className="session-review-panel__raw">{rawContent}</pre>
            ) : (
              <div className="session-review-panel__state">
                <p>No raw transcript data is available yet.</p>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </aside>
  )
}
