import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  FullSyncDone,
  FullSyncProgress,
  FullSyncStep,
} from '../shared/skills'

interface SkillSyncDialogProps {
  open: boolean
  onClose: () => void
}

function stepIcon(status: FullSyncStep['status']): string {
  switch (status) {
    case 'done':
      return '✓'
    case 'running':
      return '⟳'
    case 'error':
      return '✗'
    case 'skipped':
      return '–'
    default:
      return '○'
  }
}

function stepStatusClass(status: FullSyncStep['status']): string {
  return `sync-step is-${status}`
}

export function SkillSyncDialog({ open, onClose }: SkillSyncDialogProps) {
  const [progress, setProgress] = useState<FullSyncProgress | null>(null)
  const [result, setResult] = useState<FullSyncDone | null>(null)
  const [started, setStarted] = useState(false)
  const cleanupProgressRef = useRef<(() => void) | null>(null)
  const cleanupDoneRef = useRef<(() => void) | null>(null)

  const cleanup = useCallback(() => {
    cleanupProgressRef.current?.()
    cleanupProgressRef.current = null
    cleanupDoneRef.current?.()
    cleanupDoneRef.current = null
  }, [])

  useEffect(() => {
    if (!open) {
      setProgress(null)
      setResult(null)
      setStarted(false)
      cleanup()
      return
    }

    if (started || !window.agentCli) return

    setStarted(true)

    cleanupProgressRef.current = window.agentCli.onFullSyncProgress((event: FullSyncProgress) => {
      setProgress(event)
    })

    cleanupDoneRef.current = window.agentCli.onFullSyncDone((event: FullSyncDone) => {
      setResult(event)
    })

    void window.agentCli.startFullSync()

    return cleanup
  }, [open, started, cleanup])

  if (!open) return null

  const steps = result?.steps ?? progress?.steps ?? []
  const done = result !== null
  const error = result?.success === false ? result.summary : progress?.error

  return (
    <div className="dialog-backdrop" role="presentation" onClick={done ? onClose : undefined}>
      <div
        className="dialog-card sync-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-card__header">
          <div>
            <p className="eyebrow">Skills</p>
            <h2 id="sync-dialog-title">Skill Sync</h2>
          </div>
          {done ? (
            <button
              type="button"
              className="ghost-button dialog-card__close"
              onClick={onClose}
            >
              Close
            </button>
          ) : null}
        </div>

        <div className="sync-dialog__body">
          {steps.length === 0 && !done ? (
            <p className="sync-dialog__caption">Starting sync…</p>
          ) : null}

          <ul className="sync-dialog__steps">
            {steps.map((step) => (
              <li key={step.id} className={stepStatusClass(step.status)}>
                <span className="sync-step__icon">{stepIcon(step.status)}</span>
                <span className="sync-step__label">{step.label}</span>
                {step.detail ? (
                  <span className="sync-step__detail">{step.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>

          {error ? (
            <p className="sync-dialog__error">{error}</p>
          ) : null}

          {result?.success ? (
            <div className="sync-dialog__summary">
              <p className="sync-dialog__success">Sync complete</p>
              <p className="sync-dialog__caption">{result.summary}</p>
            </div>
          ) : null}
        </div>

        <div className="dialog-actions">
          {done ? (
            <button
              type="button"
              className="primary-button dialog-actions__submit"
              onClick={onClose}
            >
              Done
            </button>
          ) : (
            <p className="sync-dialog__caption">Sync in progress…</p>
          )}
        </div>
      </div>
    </div>
  )
}
