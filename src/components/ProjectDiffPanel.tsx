import type {
  ProjectGitFileChange,
  ProjectGitOverview,
} from '../shared/projectTools'

interface ProjectDiffSelection {
  path: string
  staged: boolean
}

interface ProjectDiffPanelProps {
  overview: ProjectGitOverview | null
  loading: boolean
  errorMessage: string | null
  selectedFile: ProjectDiffSelection | null
  diffContent: string | null
  diffLoading: boolean
  diffErrorMessage: string | null
  onRefresh: () => void
  onSelectFile: (file: ProjectGitFileChange) => void
}

function getProjectLabel(projectPath: string | null): string {
  if (!projectPath) {
    return 'Project'
  }

  const normalizedPath = projectPath.trim().replace(/[\\/]+$/u, '')
  const pathParts = normalizedPath.split(/[\\/]/u).filter(Boolean)
  return pathParts.at(-1) ?? normalizedPath
}

function formatChangeStatus(status: ProjectGitFileChange['status']): string {
  switch (status) {
    case 'added':
      return 'Added'
    case 'modified':
      return 'Modified'
    case 'deleted':
      return 'Deleted'
    case 'renamed':
      return 'Renamed'
    case 'copied':
      return 'Copied'
    case 'untracked':
      return 'Untracked'
    case 'typechange':
      return 'Type'
    case 'conflicted':
      return 'Conflict'
  }
}

function renderFileGroup(
  title: string,
  files: ProjectGitFileChange[],
  selectedFile: ProjectDiffSelection | null,
  onSelectFile: (file: ProjectGitFileChange) => void,
) {
  return (
    <section className="project-diff-panel__group">
      <header className="project-diff-panel__group-header">
        <h3>{title}</h3>
        <span>{files.length}</span>
      </header>

      {files.length > 0 ? (
        <div className="project-diff-panel__file-list">
          {files.map((file) => {
            const isActive =
              selectedFile?.path === file.path && selectedFile.staged === file.staged

            return (
              <button
                key={`${file.staged ? 'staged' : 'unstaged'}:${file.path}`}
                type="button"
                className={`project-diff-panel__file${isActive ? ' is-active' : ''}`}
                onClick={() => onSelectFile(file)}
              >
                <span className="project-diff-panel__file-main">
                  <span className="project-diff-panel__file-path">{file.path}</span>
                  <span
                    className={`project-diff-panel__status-badge is-${file.status}`}
                  >
                    {formatChangeStatus(file.status)}
                  </span>
                </span>
                <span className="project-diff-panel__file-meta">
                  <span className="project-diff-panel__file-lines is-added">
                    +{file.additions}
                  </span>
                  <span className="project-diff-panel__file-lines is-removed">
                    -{file.deletions}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <p className="project-diff-panel__empty-copy">No {title.toLowerCase()} changes.</p>
      )}
    </section>
  )
}

export function ProjectDiffPanel({
  overview,
  loading,
  errorMessage,
  selectedFile,
  diffContent,
  diffLoading,
  diffErrorMessage,
  onRefresh,
  onSelectFile,
}: ProjectDiffPanelProps) {
  const repoLabel = getProjectLabel(overview?.repoRoot ?? overview?.projectPath ?? null)
  const totalFiles =
    (overview?.unstagedFiles.length ?? 0) + (overview?.stagedFiles.length ?? 0)

  return (
    <aside className="project-diff-panel">
      <header className="project-diff-panel__header">
        <div>
          <p className="project-diff-panel__eyebrow">Changes</p>
          <h2>{repoLabel}</h2>
          <p className="project-diff-panel__branch">
            {overview?.branch ? `Branch ${overview.branch}` : 'Git working tree'}
          </p>
        </div>

        <button
          type="button"
          className="ghost-button project-diff-panel__refresh"
          onClick={onRefresh}
        >
          Refresh
        </button>
      </header>

      {errorMessage ? (
        <p className="project-diff-panel__error">{errorMessage}</p>
      ) : null}

      {loading && !overview ? (
        <div className="project-diff-panel__state">
          <p>Loading project changes…</p>
        </div>
      ) : null}

      {!loading && overview && !overview.isGitRepository ? (
        <div className="project-diff-panel__state">
          <p>This project is not inside a Git repository.</p>
        </div>
      ) : null}

      {!loading &&
      overview &&
      overview.isGitRepository &&
      totalFiles === 0 &&
      !errorMessage ? (
        <div className="project-diff-panel__state">
          <p>No local changes.</p>
        </div>
      ) : null}

      {overview?.isGitRepository && totalFiles > 0 ? (
        <>
          <div className="project-diff-panel__summary">
            <div className="project-diff-panel__summary-card">
              <span>Unstaged</span>
              <strong>{overview.unstagedFiles.length}</strong>
              <small>
                +{overview.unstagedTotals.additions} -{overview.unstagedTotals.deletions}
              </small>
            </div>
            <div className="project-diff-panel__summary-card">
              <span>Staged</span>
              <strong>{overview.stagedFiles.length}</strong>
              <small>
                +{overview.stagedTotals.additions} -{overview.stagedTotals.deletions}
              </small>
            </div>
          </div>

          <div className="project-diff-panel__changes">
            {renderFileGroup(
              'Unstaged',
              overview.unstagedFiles,
              selectedFile,
              onSelectFile,
            )}
            {renderFileGroup('Staged', overview.stagedFiles, selectedFile, onSelectFile)}
          </div>

          <section className="project-diff-panel__preview">
            <header className="project-diff-panel__preview-header">
              <div>
                <h3>{selectedFile ? selectedFile.path : 'Select a file'}</h3>
                <p>
                  {selectedFile
                    ? selectedFile.staged
                      ? 'Staged diff'
                      : 'Unstaged diff'
                    : 'Choose a file to inspect the patch.'}
                </p>
              </div>
            </header>

            {diffErrorMessage ? (
              <p className="project-diff-panel__error">{diffErrorMessage}</p>
            ) : null}

            {selectedFile ? (
              diffLoading ? (
                <div className="project-diff-panel__preview-state">
                  <p>Loading diff…</p>
                </div>
              ) : (
                <pre className="project-diff-panel__code">
                  {diffContent?.trim()
                    ? diffContent
                    : 'No diff output is available for this file yet.'}
                </pre>
              )
            ) : (
              <div className="project-diff-panel__preview-state">
                <p>Select a changed file to load its patch.</p>
              </div>
            )}
          </section>
        </>
      ) : null}
    </aside>
  )
}
