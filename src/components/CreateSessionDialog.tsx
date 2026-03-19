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
  projectTitle: string
  projectRootPath: string
  agentCliProvider: ManagedCliProvider
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
  initialIntent: 'session' | 'project',
): CreateSessionFormState {
  if (initialIntent === 'project') {
    return {
      projectSelection: NEW_PROJECT_VALUE,
      projectTitle: '',
      projectRootPath: '',
      agentCliProvider: 'codex',
      title: '',
      startupCommand: '',
      cwd: '',
    }
  }

  const activeProject =
    projects.find((project) => project.config.id === activeProjectId) ??
    projects[0] ??
    null

  return {
    projectSelection: activeProject?.config.id ?? NEW_PROJECT_VALUE,
    projectTitle: '',
    projectRootPath: activeProject?.config.rootPath ?? '',
    agentCliProvider: 'codex',
    title: '',
    startupCommand: '',
    cwd: activeProject?.config.rootPath ?? '',
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
  const [pickingSessionCwd, setPickingSessionCwd] = useState(false)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const creatingNewProject = formState.projectSelection === NEW_PROJECT_VALUE
  const projectOnlyFlow = initialIntent === 'project'
  const selectedProject =
    projects.find((project) => project.config.id === formState.projectSelection) ?? null
  const compactProjectSessionFlow =
    mode === 'project-context' && !creatingNewProject && selectedProject !== null
  const dialogEyebrow = projectOnlyFlow || creatingNewProject ? 'New Project' : 'New Session'
  const dialogTitle = projectOnlyFlow || creatingNewProject
    ? 'Create project'
    : 'Create Agent CLI Session'
  const sessionTitleLabel = creatingNewProject
    ? 'First session title (optional)'
    : 'Session title (optional)'
  const startupCommandLabel = creatingNewProject
    ? 'First session startup command (optional)'
    : 'Startup command'
  const sessionCwdLabel = creatingNewProject
    ? 'First session working directory (optional)'
    : 'Session working directory (optional)'
  const submitLabel = projectOnlyFlow || creatingNewProject ? 'Create project' : 'Create session'

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

    if (projectOnlyFlow) {
      if (!formState.projectRootPath.trim()) {
        setErrorMessage('Project root path is required for a new project.')
        return
      }
    }

    const startupCommand = (
      compactProjectSessionFlow
        ? formState.agentCliProvider
        : formState.startupCommand
    ).trim()

    if (!projectOnlyFlow && !creatingNewProject && !startupCommand) {
      setErrorMessage('Startup command is required.')
      return
    }

    if (!projectOnlyFlow && creatingNewProject && !formState.projectRootPath.trim()) {
      setErrorMessage('Project root path is required for a new project.')
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

      if (creatingNewProject && !startupCommand) {
        await onCreateProject({
          title: formState.projectTitle,
          rootPath: formState.projectRootPath,
        })
        onClose()
        return
      }

      const payload: CreateSessionInput = {
        title: formState.title,
        startupCommand,
        cwd: formState.cwd,
      }

      if (creatingNewProject) {
        payload.projectTitle = formState.projectTitle
        payload.projectRootPath = formState.projectRootPath
      } else {
        payload.projectId = formState.projectSelection
        if (compactProjectSessionFlow) {
          payload.createWithWorktree = true
        }
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
            <p className="eyebrow">{dialogEyebrow}</p>
            <h2 id="create-session-title">{dialogTitle}</h2>
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
          )}

          {projectOnlyFlow ? (
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
          ) : creatingNewProject ? (
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

          {compactProjectSessionFlow ? (
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
                      onChange={() => updateField('agentCliProvider', provider)}
                    />
                    <span className="provider-option__body">
                      <span className="provider-option__title">
                        {provider === 'codex' ? 'Codex CLI' : 'Copilot CLI'}
                      </span>
                      <span className="provider-option__meta">
                        Startup command: {provider}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <span className="field-hint">
                A fresh git worktree and branch will be created for this session.
              </span>
            </label>
          ) : projectOnlyFlow ? null : (
            <>
              <label className="field">
                <span>{sessionTitleLabel}</span>
                <input
                  type="text"
                  value={formState.title}
                  placeholder="Example: Agent / Research / Build"
                  onChange={(event) => updateField('title', event.target.value)}
                />
              </label>

              <label className="field">
                <span>{startupCommandLabel}</span>
                <input
                  type="text"
                  autoFocus={!creatingNewProject}
                  value={formState.startupCommand}
                  placeholder="Example: agent --profile dev"
                  onChange={(event) => updateField('startupCommand', event.target.value)}
                />
                {creatingNewProject ? (
                  <span className="field-hint">
                    Leave it empty to create the project now and add a session later.
                  </span>
                ) : null}
              </label>

              <label className="field">
                <span>{sessionCwdLabel}</span>
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
            </>
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
              disabled={submitting}
            >
              {submitting ? 'Creating…' : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
