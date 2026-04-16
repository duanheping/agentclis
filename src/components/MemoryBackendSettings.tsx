import type { MemoryBackendStatus } from '../shared/memorySearch'

import type { MemoryReindexResult } from '../shared/memorySearch'

interface MemoryBackendSettingsProps {
  status: MemoryBackendStatus | null
  loading: boolean
  installing: boolean
  reindexing: boolean
  errorMessage: string | null
  reindexResult: MemoryReindexResult | null
  onInstall: () => void
  onRefresh: () => void
  onReindex: () => void
  onOpenInstallRoot: () => void
  onOpenPalacePath: () => void
}

function formatInstallState(value: MemoryBackendStatus['installState']): string {
  switch (value) {
    case 'installed':
      return 'Installed'
    case 'installing':
      return 'Installing'
    case 'failed':
      return 'Failed'
    default:
      return 'Not installed'
  }
}

function formatRuntimeState(value: MemoryBackendStatus['runtimeState']): string {
  switch (value) {
    case 'running':
      return 'Running'
    case 'starting':
      return 'Starting'
    case 'failed':
      return 'Failed'
    default:
      return 'Stopped'
  }
}

function formatCommit(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12)
}

export function MemoryBackendSettings({
  status,
  loading,
  installing,
  reindexing,
  errorMessage,
  reindexResult,
  onInstall,
  onRefresh,
  onReindex,
  onOpenInstallRoot,
  onOpenPalacePath,
}: MemoryBackendSettingsProps) {
  const installDisabled = loading || installing

  return (
    <div className="sidebar-settings__section">
      <div className="sidebar-settings__section-header">
        <p className="sidebar-settings__eyebrow">Memory backend</p>
        <span className="sidebar-settings__pill">
          {status ? formatInstallState(status.installState) : 'Unavailable'}
        </span>
      </div>

      {loading ? (
        <p className="sidebar-settings__caption">Loading memory backend status…</p>
      ) : null}

      {errorMessage ? (
        <p className="sidebar-settings__error">{errorMessage}</p>
      ) : null}

      {status ? (
        <>
          <div className="sidebar-settings__group">
            <div className="sidebar-settings__group-header">
              <span className="sidebar-settings__field-label">MemPalace</span>
              <span className="sidebar-settings__pill">
                {formatRuntimeState(status.runtimeState)}
              </span>
            </div>
            <p className="sidebar-settings__caption">
              {`Pinned commit ${formatCommit(status.commit)} | Module ${status.module}`}
            </p>
            {status.message ? (
              <p className="sidebar-settings__caption">{status.message}</p>
            ) : null}
            {status.lastError ? (
              <p className="sidebar-settings__error">{status.lastError}</p>
            ) : null}
            <div className="sidebar-settings__actions">
              <button
                type="button"
                className="ghost-button sidebar-settings__action"
                disabled={installDisabled || status.installState === 'installed'}
                onClick={onInstall}
              >
                {installing ? 'Installing…' : 'Install runtime'}
              </button>
              <button
                type="button"
                className="ghost-button sidebar-settings__action"
                disabled={loading}
                onClick={onRefresh}
              >
                Refresh
              </button>
              <button
                type="button"
                className="ghost-button sidebar-settings__action"
                disabled={loading || reindexing}
                onClick={onReindex}
              >
                {reindexing ? 'Reindexing…' : 'Reindex transcripts'}
              </button>
            </div>
            {reindexResult ? (
              <p className="sidebar-settings__caption">
                {`${reindexResult.sessionsIndexed} indexed, ${reindexResult.sessionsSkipped} skipped, ${reindexResult.sessionsDeferred} deferred, ${reindexResult.errorCount} errors`}
              </p>
            ) : null}
          </div>

          <div className="sidebar-settings__group">
            <div className="sidebar-settings__group-header">
              <span className="sidebar-settings__field-label">Runtime root</span>
            </div>
            <p className="sidebar-settings__caption">{status.installRoot}</p>
            <div className="sidebar-settings__actions">
              <button
                type="button"
                className="ghost-button sidebar-settings__action"
                disabled={loading}
                onClick={onOpenInstallRoot}
              >
                Open runtime
              </button>
            </div>
          </div>

          <div className="sidebar-settings__group">
            <div className="sidebar-settings__group-header">
              <span className="sidebar-settings__field-label">Palace path</span>
            </div>
            <p className="sidebar-settings__caption">{status.palacePath}</p>
            <div className="sidebar-settings__actions">
              <button
                type="button"
                className="ghost-button sidebar-settings__action"
                disabled={loading}
                onClick={onOpenPalacePath}
              >
                Open palace
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
