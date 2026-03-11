import { type FormEvent, useEffect, useRef, useState } from 'react'

import type { CreateSessionInput, ProjectSnapshot } from '../shared/session'

interface CreateSessionDialogProps {
  open: boolean
  projects: ProjectSnapshot[]
  activeProjectId: string | null
  onClose: () => void
  onSubmit: (input: CreateSessionInput) => Promise<void>
}

interface CreateSessionFormState {
  projectSelection: string
  projectTitle: string
  projectRootPath: string
  title: string
  startupCommand: string
  cwd: string
}

const NEW_PROJECT_VALUE = '__new_project__'

function normalizePath(value: string): string {
  return value.trim().replace(/[\\/]+$/, '').toLowerCase()
}

function shouldSyncCwd(cwd: string, projectRootPath: string): boolean {
  return !normalizePath(cwd) || normalizePath(cwd) === normalizePath(projectRootPath)
}

function buildInitialFormState(
  projects: ProjectSnapshot[],
  activeProjectId: string | null,
): CreateSessionFormState {
  const activeProject =
    projects.find((project) => project.config.id === activeProjectId) ??
    projects[0] ??
    null

  return {
    projectSelection: activeProject?.config.id ?? NEW_PROJECT_VALUE,
    projectTitle: '',
    projectRootPath: activeProject?.config.rootPath ?? '',
    title: '',
    startupCommand: '',
    cwd: activeProject?.config.rootPath ?? '',
  }
}

export function CreateSessionDialog({
  open,
  projects,
  activeProjectId,
  onClose,
  onSubmit,
}: CreateSessionDialogProps) {
  const projectSelectRef = useRef<HTMLDivElement | null>(null)
  const [formState, setFormState] = useState<CreateSessionFormState>(() =>
    buildInitialFormState(projects, activeProjectId),
  )
  const [submitting, setSubmitting] = useState(false)
  const [pickingProjectRoot, setPickingProjectRoot] = useState(false)
  const [pickingSessionCwd, setPickingSessionCwd] = useState(false)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const creatingNewProject = formState.projectSelection === NEW_PROJECT_VALUE
  const selectedProject =
    projects.find((project) => project.config.id === formState.projectSelection) ?? null

  useEffect(() => {
    if (!open) {
      return
    }

    setFormState(buildInitialFormState(projects, activeProjectId))
    setProjectMenuOpen(false)
    setErrorMessage(null)
  }, [activeProjectId, open, projects])

  useEffect(() => {
    if (!open) {
      return
    }

    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) {
        if (projectMenuOpen) {
          setProjectMenuOpen(false)
          return
        }

        onClose()
      }
    }

    window.addEventListener('keydown', onWindowKeyDown)
    return () => window.removeEventListener('keydown', onWindowKeyDown)
  }, [onClose, open, projectMenuOpen, submitting])

  useEffect(() => {
    if (!projectMenuOpen) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!projectSelectRef.current?.contains(event.target as Node)) {
        setProjectMenuOpen(false)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [projectMenuOpen])

  if (!open) {
    return null
  }

  const updateField = (field: keyof CreateSessionFormState, value: string) => {
    setFormState((current) => ({
      ...current,
      [field]: value,
    }))
  }

  const handleProjectSelection = (value: string) => {
    const selectedProject = projects.find((project) => project.config.id === value)

    setFormState((current) => ({
      ...current,
      projectSelection: value,
      projectRootPath: selectedProject?.config.rootPath ?? '',
      cwd: shouldSyncCwd(current.cwd, current.projectRootPath)
        ? (selectedProject?.config.rootPath ?? '')
        : current.cwd,
    }))
    setProjectMenuOpen(false)
  }

  const handlePickProjectRoot = async () => {
    if (!window.agentCli) {
      setErrorMessage('Agent bridge is unavailable.')
      return
    }

    setPickingProjectRoot(true)
    setErrorMessage(null)

    try {
      const selectedPath = await window.agentCli.pickDirectory(
        formState.projectRootPath,
      )

      if (!selectedPath) {
        return
      }

      setFormState((current) => ({
        ...current,
        projectRootPath: selectedPath,
        cwd: shouldSyncCwd(current.cwd, current.projectRootPath)
          ? selectedPath
          : current.cwd,
      }))
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to open folder picker.',
      )
    } finally {
      setPickingProjectRoot(false)
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!formState.startupCommand.trim()) {
      setErrorMessage('Startup command is required.')
      return
    }

    if (creatingNewProject && !formState.projectRootPath.trim()) {
      setErrorMessage('Project root path is required for a new project.')
      return
    }

    setSubmitting(true)
    setErrorMessage(null)

    try {
      const payload: CreateSessionInput = {
        title: formState.title,
        startupCommand: formState.startupCommand,
        cwd: formState.cwd,
      }

      if (creatingNewProject) {
        payload.projectTitle = formState.projectTitle
        payload.projectRootPath = formState.projectRootPath
      } else {
        payload.projectId = formState.projectSelection
      }

      await onSubmit(payload)
      onClose()
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Unknown error while creating session.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  const handlePickSessionCwd = async () => {
    if (!window.agentCli) {
      setErrorMessage('Agent bridge is unavailable.')
      return
    }

    setPickingSessionCwd(true)
    setErrorMessage(null)

    try {
      const selectedPath = await window.agentCli.pickDirectory(
        formState.cwd || formState.projectRootPath,
      )

      if (!selectedPath) {
        return
      }

      updateField('cwd', selectedPath)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to open folder picker.',
      )
    } finally {
      setPickingSessionCwd(false)
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-session-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-card__header">
          <div>
            <p className="eyebrow">New Session</p>
            <h2 id="create-session-title">Create Agent CLI Session</h2>
          </div>
          <button
            type="button"
            className="ghost-button dialog-card__close"
            onClick={onClose}
            disabled={submitting}
          >
            Close
          </button>
        </div>

        <form className="dialog-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>Project</span>
            <div className="project-select" ref={projectSelectRef}>
              <button
                type="button"
                className={`project-select__trigger${projectMenuOpen ? ' is-open' : ''}`}
                aria-expanded={projectMenuOpen}
                aria-haspopup="listbox"
                onClick={() => setProjectMenuOpen((current) => !current)}
              >
                <span className="project-select__summary">
                  <span className="project-select__label">
                    {creatingNewProject
                      ? 'Create new project'
                      : (selectedProject?.config.title ?? 'Select project')}
                  </span>
                  <span
                    className={`project-select__meta${creatingNewProject ? ' is-placeholder' : ''}`}
                  >
                    {creatingNewProject
                      ? 'Choose a folder and start nesting sessions beneath it'
                      : (selectedProject?.config.rootPath ?? 'Select an existing project')}
                  </span>
                </span>
                <span className="project-select__chevron" aria-hidden="true">
                  {projectMenuOpen ? '▴' : '▾'}
                </span>
              </button>

              {projectMenuOpen ? (
                <div className="project-select__menu" role="listbox">
                  {projects.map((project) => {
                    const selected = project.config.id === formState.projectSelection

                    return (
                      <button
                        key={project.config.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`project-select__option${selected ? ' is-selected' : ''}`}
                        onClick={() => handleProjectSelection(project.config.id)}
                      >
                        <span className="project-select__option-title">
                          {project.config.title}
                        </span>
                        <span className="project-select__option-meta">
                          {project.config.rootPath}
                        </span>
                      </button>
                    )
                  })}

                  <button
                    type="button"
                    role="option"
                    aria-selected={creatingNewProject}
                    className={`project-select__option is-create${creatingNewProject ? ' is-selected' : ''}`}
                    onClick={() => handleProjectSelection(NEW_PROJECT_VALUE)}
                  >
                    <span className="project-select__option-title">
                      Create new project
                    </span>
                    <span className="project-select__option-meta">
                      Choose a folder and start grouping sessions under it
                    </span>
                  </button>
                </div>
              ) : null}
            </div>
          </label>

          {creatingNewProject ? (
            <>
              <label className="field">
                <span>Project name (optional)</span>
                <input
                  type="text"
                  value={formState.projectTitle}
                  placeholder="Example: codex / platform / tools"
                  onChange={(event) => updateField('projectTitle', event.target.value)}
                />
              </label>

              <label className="field">
                <span>Project root path</span>
                <div className="path-picker">
                  <button
                    type="button"
                    className="path-picker__value"
                    onClick={() => {
                      void handlePickProjectRoot()
                    }}
                    disabled={submitting || pickingProjectRoot}
                  >
                    <span
                      className={
                        formState.projectRootPath
                          ? 'path-picker__text'
                          : 'path-picker__text is-placeholder'
                      }
                    >
                      {formState.projectRootPath ||
                        'Click to choose the project folder'}
                    </span>
                  </button>
                  <div className="path-picker__actions">
                    <button
                      type="button"
                      className="ghost-button path-picker__action"
                      onClick={() => {
                        void handlePickProjectRoot()
                      }}
                      disabled={submitting || pickingProjectRoot}
                    >
                      {pickingProjectRoot ? 'Opening…' : 'Choose folder'}
                    </button>
                  </div>
                </div>
                <span className="field-hint">
                  Use the native folder picker to choose the project root.
                </span>
              </label>
            </>
          ) : null}

          <label className="field">
            <span>Session title (optional)</span>
            <input
              type="text"
              value={formState.title}
              placeholder="Example: Agent / Research / Build"
              onChange={(event) => updateField('title', event.target.value)}
            />
          </label>

          <label className="field">
            <span>Startup command</span>
            <input
              type="text"
              autoFocus
              value={formState.startupCommand}
              placeholder="Example: agent --profile dev"
              onChange={(event) => updateField('startupCommand', event.target.value)}
            />
          </label>

          <label className="field">
            <span>Session working directory (optional)</span>
            <div className="path-picker">
              <button
                type="button"
                className="path-picker__value"
                onClick={() => {
                  void handlePickSessionCwd()
                }}
                disabled={submitting || pickingSessionCwd}
              >
                <span
                  className={
                    formState.cwd
                      ? 'path-picker__text'
                      : 'path-picker__text is-placeholder'
                  }
                >
                  {formState.cwd || 'Click to choose a session working folder'}
                </span>
              </button>
              <div className="path-picker__actions">
                <button
                  type="button"
                  className="ghost-button path-picker__action"
                  onClick={() => {
                    void handlePickSessionCwd()
                  }}
                  disabled={submitting || pickingSessionCwd}
                >
                  {pickingSessionCwd ? 'Opening…' : 'Choose folder'}
                </button>
                {formState.cwd ? (
                  <button
                    type="button"
                    className="ghost-button path-picker__action"
                    onClick={() => updateField('cwd', '')}
                    disabled={submitting || pickingSessionCwd}
                  >
                    Clear
                  </button>
                ) : null}
              </div>
            </div>
            <span className="field-hint">
              Leave it empty to use the selected project root directory.
            </span>
          </label>

          {errorMessage ? <p className="form-error">{errorMessage}</p> : null}

          <div className="dialog-actions">
            <button
              type="button"
              className="ghost-button dialog-actions__cancel"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primary-button dialog-actions__submit"
              disabled={submitting}
            >
              {submitting ? 'Creating…' : 'Create session'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
