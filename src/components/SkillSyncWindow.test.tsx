import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FullSyncDone, FullSyncProgress } from '../shared/skills'
import { SkillSyncWindow } from './SkillSyncWindow'

function buildProgress(): FullSyncProgress {
  return {
    steps: [
      {
        id: 'scan-codex',
        label: 'Scan Codex',
        status: 'done',
      },
      {
        id: 'compare',
        label: 'Compare results',
        status: 'running',
        detail: 'Checking differing files.',
      },
    ],
    currentStepId: 'compare',
    done: false,
    logs: [
      {
        id: 'log-1',
        timestamp: '2026-03-26T13:20:00.000Z',
        stepId: 'scan-codex',
        level: 'info',
        message: 'Scanned 3 candidate roots.',
      },
    ],
  }
}

function buildResult(): FullSyncDone {
  return {
    success: true,
    summary: 'Merged one conflict and synchronized both roots.',
    steps: [
      {
        id: 'scan-codex',
        label: 'Scan Codex',
        status: 'done',
      },
      {
        id: 'compare',
        label: 'Compare results',
        status: 'done',
      },
    ],
    logs: [
      {
        id: 'log-2',
        timestamp: '2026-03-26T13:21:00.000Z',
        stepId: 'compare',
        level: 'success',
        message: 'Sync completed cleanly.',
      },
    ],
  }
}

describe('SkillSyncWindow', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'close', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    cleanup()
    delete window.agentCli
    vi.restoreAllMocks()
  })

  it('renders the current sync state, reacts to progress events, and closes the window', async () => {
    const user = userEvent.setup()
    const unsubscribeProgress = vi.fn()
    const unsubscribeDone = vi.fn()
    let progressListener: ((event: FullSyncProgress) => void) | null = null
    let doneListener: ((event: FullSyncDone) => void) | null = null

    window.agentCli = {
      getFullSyncState: vi.fn().mockResolvedValue({
        running: true,
        progress: buildProgress(),
        result: null,
      }),
      onFullSyncProgress: vi.fn((listener) => {
        progressListener = listener
        return unsubscribeProgress
      }),
      onFullSyncDone: vi.fn((listener) => {
        doneListener = listener
        return unsubscribeDone
      }),
    } as unknown as typeof window.agentCli

    const { unmount } = render(<SkillSyncWindow />)

    expect(await screen.findByText('Sync in progress')).toBeInTheDocument()
    expect(screen.getAllByText('Checking differing files.').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Compare results').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Scanned 3 candidate roots.')).toBeInTheDocument()
    expect(screen.getByText('1/2')).toBeInTheDocument()

    act(() => {
      progressListener?.({
        ...buildProgress(),
        logs: [
          ...buildProgress().logs,
          {
            id: 'log-3',
            timestamp: '2026-03-26T13:20:30.000Z',
            stepId: 'compare',
            level: 'warning',
            message: 'Resolving a conflict with AI merge.',
          },
        ],
      })
    })

    expect(
      screen.getByText('Resolving a conflict with AI merge.'),
    ).toBeInTheDocument()

    act(() => {
      doneListener?.(buildResult())
    })

    expect(await screen.findByText('Sync complete')).toBeInTheDocument()
    expect(
      screen.getByText('Merged one conflict and synchronized both roots.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Sync completed cleanly.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close' }))

    expect(window.close).toHaveBeenCalledTimes(1)

    unmount()

    expect(unsubscribeProgress).toHaveBeenCalledTimes(1)
    expect(unsubscribeDone).toHaveBeenCalledTimes(1)
  })

  it('shows a preload error when the bridge is unavailable', async () => {
    render(<SkillSyncWindow />)

    expect(
      await screen.findByText(
        'Agent bridge is unavailable. The preload script did not load.',
      ),
    ).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('Waiting for sync')).toBeInTheDocument()
    })
  })
})
