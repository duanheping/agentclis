import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionSnapshot } from '../shared/session'
import { SessionReviewPanel } from './SessionReviewPanel'

function buildSession(): SessionSnapshot {
  return {
    config: {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Review restore behavior',
      startupCommand: 'codex',
      pendingFirstPromptTitle: false,
      cwd: 'C:\\repo\\agentclis',
      shell: 'powershell.exe',
      createdAt: '2026-04-16T12:00:00.000Z',
      updatedAt: '2026-04-16T12:00:00.000Z',
    },
    runtime: {
      sessionId: 'session-1',
      status: 'exited',
      exitCode: 0,
      lastActiveAt: '2026-04-16T12:04:00.000Z',
    },
    restore: {
      statusSummary: 'Session finished.',
      lastMeaningfulReply: 'The restore flow now falls back without blocking xterm.',
      resultSummary: 'Session exited successfully.',
      blockedReason: null,
      lastError: null,
      updatedAt: '2026-04-16T12:04:00.000Z',
      hasTranscript: true,
      hasTerminalReplay: true,
    },
  }
}

describe('SessionReviewPanel', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'agentCli', {
      configurable: true,
      value: {
        getSessionTranscriptPage: vi.fn(async (input: {
          cursor?: string | null
          search?: string | null
        }) => {
          if (input.search?.trim()) {
            return {
              events: [
                {
                  id: 'event-search',
                  sessionId: 'session-1',
                  projectId: 'project-1',
                  locationId: null,
                  timestamp: '2026-04-16T12:03:00.000Z',
                  kind: 'output',
                  source: 'pty',
                  chunk: 'restore review result line',
                },
              ],
              nextCursor: null,
            }
          }

          if (input.cursor === '1') {
            return {
              events: [
                {
                  id: 'event-1',
                  sessionId: 'session-1',
                  projectId: 'project-1',
                  locationId: null,
                  timestamp: '2026-04-16T12:01:00.000Z',
                  kind: 'system',
                  source: 'system',
                  chunk: 'Session created for Workspace.',
                },
              ],
              nextCursor: null,
            }
          }

          return {
            events: [
              {
                id: 'event-2',
                sessionId: 'session-1',
                projectId: 'project-1',
                locationId: null,
                timestamp: '2026-04-16T12:02:00.000Z',
                kind: 'output',
                source: 'pty',
                chunk: 'Latest transcript reply',
              },
            ],
            nextCursor: '1',
          }
        }),
      } as unknown as typeof window.agentCli,
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the summary tab from the restore snapshot', () => {
    render(
      <SessionReviewPanel
        open
        session={buildSession()}
      />,
    )

    expect(screen.getByText('Review full content')).toBeInTheDocument()
    expect(screen.getAllByText('Session finished.')).toHaveLength(2)
    expect(screen.getByText('Session exited successfully.')).toBeInTheDocument()
    expect(
      screen.getByText('The restore flow now falls back without blocking xterm.'),
    ).toBeInTheDocument()
  })

  it('loads transcript pages and older entries', async () => {
    const user = userEvent.setup()

    render(
      <SessionReviewPanel
        open
        session={buildSession()}
      />,
    )

    await user.click(screen.getByRole('tab', { name: 'Transcript' }))

    await waitFor(() => {
      expect(screen.getByText('Latest transcript reply')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Load older entries' }))

    await waitFor(() => {
      expect(screen.getByText('Session created for Workspace.')).toBeInTheDocument()
    })
  })

  it('searches transcript text in the search tab', async () => {
    const user = userEvent.setup()

    render(
      <SessionReviewPanel
        open
        session={buildSession()}
      />,
    )

    await user.click(screen.getByRole('tab', { name: 'Search' }))
    await user.type(screen.getByRole('searchbox'), 'result')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => {
      expect(screen.getByText('restore review result line')).toBeInTheDocument()
    })
  })

  it('shows raw transcript JSON in the raw tab', async () => {
    const user = userEvent.setup()

    render(
      <SessionReviewPanel
        open
        session={buildSession()}
      />,
    )

    await user.click(screen.getByRole('tab', { name: 'Raw' }))

    await waitFor(() => {
      expect(screen.getByText(/"chunk": "Latest transcript reply"/)).toBeInTheDocument()
    })
  })
})
