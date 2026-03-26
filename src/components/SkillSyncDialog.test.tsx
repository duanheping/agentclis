import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FullSyncDone, FullSyncProgress } from '../shared/skills'
import { SkillSyncDialog } from './SkillSyncDialog'

function buildProgress(): FullSyncProgress {
  return {
    steps: [
      {
        id: 'scan-codex',
        label: 'Scan Codex',
        status: 'running',
        detail: 'Scanning installed skills.',
      },
    ],
    currentStepId: 'scan-codex',
    done: false,
    logs: [],
  }
}

function buildResult(success = true): FullSyncDone {
  return {
    success,
    summary: success ? 'Synchronized 2 roots.' : 'The sync failed.',
    steps: [
      {
        id: 'scan-codex',
        label: 'Scan Codex',
        status: success ? 'done' : 'error',
      },
    ],
    logs: [],
  }
}

describe('SkillSyncDialog', () => {
  afterEach(() => {
    cleanup()
    delete window.agentCli
  })

  it('starts a full sync when opened and shows the final result', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    let progressListener: ((event: FullSyncProgress) => void) | null = null
    let doneListener: ((event: FullSyncDone) => void) | null = null

    window.agentCli = {
      startFullSync: vi.fn().mockResolvedValue({
        running: true,
        progress: null,
        result: null,
      }),
      onFullSyncProgress: vi.fn((listener) => {
        progressListener = listener
        return vi.fn()
      }),
      onFullSyncDone: vi.fn((listener) => {
        doneListener = listener
        return vi.fn()
      }),
    } as unknown as typeof window.agentCli

    render(<SkillSyncDialog open onClose={onClose} />)

    expect(await screen.findByText('Skill Sync')).toBeInTheDocument()
    expect(window.agentCli.startFullSync).toHaveBeenCalledTimes(1)

    act(() => {
      progressListener?.(buildProgress())
    })

    expect(screen.getByText('Scanning installed skills.')).toBeInTheDocument()
    expect(screen.getByText('Sync in progress…')).toBeInTheDocument()

    act(() => {
      doneListener?.(buildResult())
    })

    expect(await screen.findByText('Sync complete')).toBeInTheDocument()
    expect(screen.getByText('Synchronized 2 roots.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows the bridge error immediately when preload is unavailable', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(<SkillSyncDialog open onClose={onClose} />)

    expect(
      await screen.findByText(
        'Agent bridge is unavailable. The preload script did not load.',
      ),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
