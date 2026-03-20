import { type FormEvent, useEffect, useRef, useState } from 'react'

import {
  MANAGED_CLI_PROVIDERS,
  type CreateProjectInput,
  type CreateSessionInput,
  type ManagedCliProvider,
  type ProjectSnapshot,
} from '../shared/session'

interface CreateSessionDialogProps {
  open: boolean
  initialIntent: 'session' | 'project'
  mode?: 'default' | 'project-context'
  projects: ProjectSnapshot[]
  activeProjectId: string | null
  onClose: () => void
  onCreateProject: (input: CreateProjectInput) => Promise<void>
  onCreateSession: (input: CreateSessionInput) => Promise<void>
}

interface CreateSessionFormState {
  projectSelection: string
  projectRootPath: string
  agentCliProvider: ManagedCliProvider
}

const NEW_PROJECT_VALUE = '__new_project__'

function buildInitialFormState(
  projects: ProjectSnapshot[],
  activeProjectId: string | null,
  initialIntent: 'session' | 'project',
): CreateSessionFormState {
  if (initialIntent === 'project') {
    return {
      projectSelection: NEW_PROJECT_VALUE,
      projectRootPath: '',
      agentCliProvider: 'codex',
    }
  }

  const activeProject =
    projects.find((project) => project.config.id === activeProjectId) ??
    projects[0] ??
    null

  return {
    projectSelection: activeProject?.config.id ?? '',
    projectRootPath: activeProject?.config.rootPath ?? '',
    agentCliProvider: 'codex',
  }
}

export function CreateSessionDialog({
  open,
  initialIntent,
  mode = 'default',
  projects,
  activeProjectId,
  onClose,
  onCreateProject,
  onCreateSession,
}: CreateSessionDialogProps) {
  const projectSelectRef = useRef<HTMLDivElement | null>(null)
  const [formState, setFormState] = useState<CreateSessionFormState>(() =>
    buildInitialFormState(projects, activeProjectId, initialIntent),
  )
  const [submitting, setSubmitting] = useState(false)
  const [pickingProjectRoot, setPickingProjectRoot] = useState(false)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const projectOnlyFlow = initialIntent === 'project'
  const selectedProject =
    projects.find((project) => project.config.id === formState.projectSelection) ?? null
  const compactProjectSessionFlow =
    mode === 'project-context' && selectedProject !== null
  const dialogEyebrow = projectOnlyFlow ? 'New Project' : 'New Session'
  const dialogTitle = projectOnlyFlow ? null : 'New session'
  const submitLabel = 'Create'
  const submitDisabled = !projectOnlyFlow && selectedProject === null

  useEffect(() => {
    if (!open) {
      return
    }

    setFormState(buildInitialFormState(projects, activeProjectId, initialIntent))
    setProjectMenuOpen(false)
    setErrorMessage(null)
  }, [activeProjectId, initialIntent, open, projects])

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

  const handleProjectSelection = (value: string) => {
    const nextProject = projects.find((project) => project.config.id === value)

    setFormState((current) => ({
      ...current,
      projectSelection: value,
      projectRootPath: nextProject?.config.rootPath ?? '',
    }))
    setProjectMenuOpen(false)
  }

  const handleProviderSelection = (provider: ManagedCliProvider) => {
    setFormState((current) => ({
      ...current,
      agentCliProvider: provider,
    }))
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

    if (projectOnlyFlow) {
      if (!formState.projectRootPath.trim()) {
        setErrorMessage('Project root path is required for a new project.')
        return
      }
    } else if (!selectedProject) {
      setErrorMessage(
        projects.length
          ? 'Project selection is required.'
          : 'Create a project before starting a session.',
      )
      return
    }

    setSubmitting(true)
    setErrorMessage(null)

    try {
      if (projectOnlyFlow) {
        await onCreateProject({
          rootPath: formState.projectRootPath,
        })
        onClose()
        return
      }

      const payload: CreateSessionInput = {
        projectId: selectedProject.config.id,
        startupCommand: formState.agentCliProvider,
      }

      if (compactProjectSessionFlow) {
        payload.createWithWorktree = true
      } else {
        payload.cwd = selectedProject.config.rootPath
      }

      await onCreateSession(payload)
      onClose()
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Unknown error while creating session.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog-card"
        role="dialog"
        aria-modal="true"
        aria-label={projectOnlyFlow ? dialogEyebrow : undefined}
        aria-labelledby={dialogTitle ? 'create-session-title' : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-card__header">
          <div>
            <p className="eyebrow">{dialogEyebrow}</p>
            {dialogTitle ? <h2 id="create-session-title">{dialogTitle}</h2> : null}
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
          {projectOnlyFlow ? null : compactProjectSessionFlow ? (
            <label className="field">
              <span>Project</span>
              <div className="project-summary">
                <span className="project-summary__title">
                  {selectedProject.config.title}
                </span>
                <span className="project-summary__path">
                  {selectedProject.config.rootPath}
                </span>
              </div>
            </label>
          ) : (
            <label className="field">
              <span>Project</span>
              <div className="project-select" ref={projectSelectRef}>
                <button
                  type="button"
                  className={`project-select__trigger${projectMenuOpen ? ' is-open' : ''}`}
                  aria-expanded={projectMenuOpen && projects.length > 0}
                  aria-haspopup="listbox"
                  disabled={submitting || projects.length === 0}
                  onClick={() => setProjectMenuOpen((current) => !current)}
                >
                  <span className="project-select__summary">
                    <span className="project-select__label">
                      {selectedProject?.config.title ?? 'Select project'}
                    </span>
                    <span
                      className={`project-select__meta${selectedProject ? '' : ' is-placeholder'}`}
                    >
                      {selectedProject?.config.rootPath ??
                        (projects.length
                          ? 'Select an existing project'
                          : 'Create a project before starting a session')}
                    </span>
                  </span>
                  <span className="project-select__chevron" aria-hidden="true">
                    {projectMenuOpen ? '^' : 'v'}
                  </span>
                </button>

                {projectMenuOpen && projects.length ? (
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
                  </div>
                ) : null}
              </div>
              {projects.length ? null : (
                <span className="field-hint">
                  Create a project before starting a new session.
                </span>
              )}
            </label>
          )}

          {projectOnlyFlow ? (
            <div className="field">
              <div className="path-picker">
                <button
                  type="button"
                  className="path-picker__value"
                  aria-label="Project root folder"
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
                    {formState.projectRootPath || 'Select project folder'}
                  </span>
                </button>
              </div>
            </div>
          ) : (
            <label className="field">
              <span>Agent CLI</span>
              <div className="provider-picker" role="radiogroup" aria-label="Agent CLI">
                {MANAGED_CLI_PROVIDERS.map((provider) => (
                  <label key={provider} className="provider-option">
                    <input
                      type="radio"
                      name="agent-cli-provider"
                      value={provider}
                      checked={formState.agentCliProvider === provider}
                      onChange={() => handleProviderSelection(provider)}
                    />
                    <span className="provider-option__body">
                      <span className="provider-option__title">
                        {provider === 'codex' ? 'Codex CLI' : 'Copilot CLI'}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {compactProjectSessionFlow ? (
                <span className="field-hint">
                  A fresh git worktree and branch will be created for this session.
                </span>
              ) : null}
            </label>
          )}

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
              disabled={submitting || submitDisabled}
            >
              {submitting ? 'Creating...' : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
