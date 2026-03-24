import {
  type MouseEvent,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import {
  type SkillAiMergeAgent,
  type SkillAiMergeProposal,
  type SkillAiReviewAgent,
  SKILL_AI_MERGE_AGENTS,
  type SkillLibrarySettings,
  type SkillSyncRoot,
  type SkillSyncStatus,
} from '../shared/skills'
import {
  summarizeCommand,
  type ProjectSnapshot,
  type SessionSnapshot,
} from '../shared/session'
import { getSessionAttentionBadgeLabel } from '../shared/sessionAttention'

interface SessionSidebarProps {
  projects: ProjectSnapshot[]
  activeSessionId: string | null
  showProjectPaths: boolean
  onCreateSession: () => void
  onCreateProject: () => void
  onCreateForProject: (projectId: string) => void
  onSelect: (id: string) => Promise<void>
  onRename: (id: string, title: string) => Promise<void>
  onClose: (id: string) => Promise<void>
  windowsCommandPromptSessionIds: string[]
  onToggleWindowsCommandPrompt: (id: string) => Promise<void>
  onToggleProjectPaths: () => void
  skillLibrarySettings: SkillLibrarySettings | null
  skillSyncStatus: SkillSyncStatus | null
  skillsLoading: boolean
  skillsBusy: boolean
  skillsSyncing: boolean
  skillsResolving: string | null
  skillsGeneratingMerge: string | null
  skillsApplyingMerge: boolean
  projectMemoryImporting: boolean
  projectMemoryImportStatus: string | null
  skillAiMergeProposal: SkillAiMergeProposal | null
  skillsErrorMessage: string | null
  onPickSkillLibraryRoot: () => Promise<void>
  onClearSkillLibraryRoot: () => Promise<void>
  onOpenSkillLibraryRoot: () => Promise<void>
  onSetPrimaryMergeAgent: (agent: SkillAiMergeAgent) => Promise<void>
  onSetReviewMergeAgent: (agent: SkillAiReviewAgent) => Promise<void>
  onSyncSkills: () => Promise<void>
  onImportHistoricalProjectMemory: () => Promise<void>
  onResolveSkillConflict: (
    skillName: string,
    sourceRoot: SkillSyncRoot,
  ) => Promise<void>
  onGenerateSkillAiMerge: (skillName: string) => Promise<void>
  onApplySkillAiMerge: () => Promise<void>
  onDismissSkillAiMerge: () => void
}

type ContextMenuState =
  | {
      kind: 'project'
      project: ProjectSnapshot
      x: number
      y: number
    }
  | {
      kind: 'session'
      session: SessionSnapshot
      x: number
      y: number
    }

interface ContextMenuPosition {
  x: number
  y: number
}

interface SkillAgentOption<T extends string> {
  label: string
  value: T
}

interface SkillAgentSelectProps<T extends string> {
  label: string
  value: T
  options: SkillAgentOption<T>[]
  disabled: boolean
  onChange: (value: T) => void
}

function findActiveProjectId(
  projects: ProjectSnapshot[],
  activeSessionId: string | null,
): string | null {
  return (
    projects.find((project) =>
      project.sessions.some((session) => session.config.id === activeSessionId),
    )?.config.id ?? null
  )
}

function findSessionLocationLabel(
  project: ProjectSnapshot,
  session: SessionSnapshot,
): string | null {
  const locations = project.locations ?? []
  if (locations.length <= 1 || !session.config.locationId) {
    return null
  }

  return (
    locations.find((location) => location.id === session.config.locationId)?.label ?? null
  )
}

function formatMergeAgentLabel(agent: SkillAiMergeAgent): string {
  if (agent === 'codex') {
    return 'Codex'
  }

  if (agent === 'claude') {
    return 'Claude'
  }

  return 'Copilot'
}

function summarizeSkills(skills: string[]): string {
  if (skills.length === 0) {
    return 'No detected skills'
  }

  if (skills.length <= 3) {
    return skills.join(', ')
  }

  return `${skills.slice(0, 3).join(', ')} +${skills.length - 3} more`
}

function summarizeDifferingFiles(files: string[]): string {
  if (files.length === 0) {
    return 'Content differs between roots.'
  }

  if (files.length <= 3) {
    return files.join(', ')
  }

  return `${files.slice(0, 3).join(', ')} +${files.length - 3} more`
}

function formatReviewStatus(status: NonNullable<SkillAiMergeProposal['review']>['status']): string {
  if (status === 'approved') {
    return 'Approved'
  }

  if (status === 'approved-with-warnings') {
    return 'Approved with warnings'
  }

  return 'Changes requested'
}

function findConflictRootLabel(
  status: SkillSyncStatus | null,
  root: SkillSyncRoot,
): string {
  return status?.roots.find((entry) => entry.root === root)?.label ??
    (root === 'library' ? 'Library' : 'Discovered folders')
}

function SkillAgentSelect<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: SkillAgentSelectProps<T>) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [menuPosition, setMenuPosition] = useState<{
    top: number
    left: number
    width: number
  } | null>(null)
  const selectId = label.toLowerCase().replace(/\s+/g, '-')
  const selectedOption =
    options.find((option) => option.value === value) ?? options[0] ?? null

  const updateMenuPosition = () => {
    const trigger = triggerRef.current
    if (!trigger) {
      return
    }

    const triggerRect = trigger.getBoundingClientRect()
    const viewportPadding = 8
    const gap = 10
    const estimatedOptionHeight = 52
    const estimatedMenuHeight = options.length * estimatedOptionHeight + 22
    const availableBelow = window.innerHeight - triggerRect.bottom - viewportPadding
    const availableAbove = triggerRect.top - viewportPadding
    const openAbove =
      availableBelow < estimatedMenuHeight + gap && availableAbove > availableBelow
    const top = openAbove
      ? Math.max(viewportPadding, triggerRect.top - estimatedMenuHeight - gap)
      : triggerRect.bottom + gap
    const left = Math.min(
      Math.max(viewportPadding, triggerRect.left),
      Math.max(viewportPadding, window.innerWidth - triggerRect.width - viewportPadding),
    )

    setMenuPosition({
      top,
      left,
      width: triggerRect.width,
    })
  }

  useEffect(() => {
    if (!open) {
      return
    }

    const closeMenu = () => setOpen(false)
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('blur', closeMenu)
    window.addEventListener('resize', closeMenu)
    window.addEventListener('keydown', onWindowKeyDown)
    window.addEventListener('scroll', closeMenu, true)

    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('blur', closeMenu)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('keydown', onWindowKeyDown)
      window.removeEventListener('scroll', closeMenu, true)
    }
  }, [open])

  const menu = open
    ? createPortal(
        <div
          ref={menuRef}
          className="sidebar-settings__select-menu sidebar-settings__select-menu--floating"
          role="listbox"
          aria-label={label}
          style={
            menuPosition
              ? {
                  top: `${menuPosition.top}px`,
                  left: `${menuPosition.left}px`,
                  width: `${menuPosition.width}px`,
                }
              : {
                  top: '0px',
                  left: '0px',
                  width: '0px',
                  visibility: 'hidden',
                }
          }
        >
          {options.map((option) => {
            const selected = option.value === value

            return (
              <button
                key={`${selectId}-${option.value}`}
                type="button"
                role="option"
                aria-selected={selected}
                className={`sidebar-settings__select-option${selected ? ' is-selected' : ''}`}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                {option.label}
              </button>
            )
          })}
        </div>,
        document.body,
      )
    : null

  return (
    <div className="sidebar-settings__select-group">
      <span id={`${selectId}-label`} className="sidebar-settings__field-label">
        {label}
      </span>
      <div ref={rootRef} className="sidebar-settings__select-wrapper">
        <button
          ref={triggerRef}
          type="button"
          className={`sidebar-settings__select-trigger${open ? ' is-open' : ''}`}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-labelledby={`${selectId}-label`}
          aria-label={label}
          disabled={disabled}
          onClick={() => {
            if (open) {
              setOpen(false)
              return
            }

            updateMenuPosition()
            setOpen(true)
          }}
        >
          <span className="sidebar-settings__select-value">
            {selectedOption?.label ?? value}
          </span>
          <span className="sidebar-settings__select-chevron" aria-hidden="true">
            {open ? '^' : 'v'}
          </span>
        </button>
      </div>
      {menu}
    </div>
  )
}

export function SessionSidebar({
  projects,
  activeSessionId,
  showProjectPaths,
  onCreateSession,
  onCreateProject,
  onCreateForProject,
  onSelect,
  onRename,
  onClose,
  windowsCommandPromptSessionIds,
  onToggleWindowsCommandPrompt,
  onToggleProjectPaths,
  skillLibrarySettings,
  skillSyncStatus,
  skillsLoading,
  skillsBusy,
  skillsSyncing,
  skillsResolving,
  skillsGeneratingMerge,
  skillsApplyingMerge,
  projectMemoryImporting,
  projectMemoryImportStatus,
  skillAiMergeProposal,
  skillsErrorMessage,
  onPickSkillLibraryRoot,
  onClearSkillLibraryRoot,
  onOpenSkillLibraryRoot,
  onSetPrimaryMergeAgent,
  onSetReviewMergeAgent,
  onSyncSkills,
  onImportHistoricalProjectMemory,
  onResolveSkillConflict,
  onGenerateSkillAiMerge,
  onApplySkillAiMerge,
  onDismissSkillAiMerge,
}: SessionSidebarProps) {
  const activeProjectId = findActiveProjectId(projects, activeSessionId)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [projectVisibility, setProjectVisibility] = useState<
    Record<string, boolean>
  >({})
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!contextMenu) {
      return
    }

    const closeContextMenu = () => setContextMenu(null)
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null)
      }
    }

    window.addEventListener('click', closeContextMenu)
    window.addEventListener('blur', closeContextMenu)
    window.addEventListener('resize', closeContextMenu)
    window.addEventListener('keydown', onWindowKeyDown)

    return () => {
      window.removeEventListener('click', closeContextMenu)
      window.removeEventListener('blur', closeContextMenu)
      window.removeEventListener('resize', closeContextMenu)
      window.removeEventListener('keydown', onWindowKeyDown)
    }
  }, [contextMenu])

  useEffect(() => {
    if (!settingsOpen) {
      return
    }

    const closeSettings = () => setSettingsOpen(false)
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (
        !settingsRef.current?.contains(event.target as Node) &&
        !target?.closest('.sidebar-settings__select-menu')
      ) {
        setSettingsOpen(false)
      }
    }
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false)
      }
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('blur', closeSettings)
    window.addEventListener('resize', closeSettings)
    window.addEventListener('keydown', onWindowKeyDown)

    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('blur', closeSettings)
      window.removeEventListener('resize', closeSettings)
      window.removeEventListener('keydown', onWindowKeyDown)
    }
  }, [settingsOpen])

  const beginEditing = (session: SessionSnapshot) => {
    setEditingId(session.config.id)
    setDraftTitle(session.config.title)
  }

  const commitRename = async (id: string) => {
    await onRename(id, draftTitle)
    setEditingId(null)
    setDraftTitle('')
  }

  const isProjectExpanded = (projectId: string) =>
    projectVisibility[projectId] ?? projectId === activeProjectId

  const toggleProject = (projectId: string) => {
    setProjectVisibility((current) => {
      const currentlyExpanded = current[projectId] ?? projectId === activeProjectId
      const nextExpanded = !currentlyExpanded
      const defaultExpanded = projectId === activeProjectId
      const nextState = { ...current }

      if (nextExpanded === defaultExpanded) {
        delete nextState[projectId]
      } else {
        nextState[projectId] = nextExpanded
      }

      return nextState
    })
  }

  const getContextMenuPosition = (
    event: MouseEvent<HTMLElement>,
    menuHeight: number,
  ): ContextMenuPosition => {
    const menuWidth = 256

    return {
      x: Math.min(event.clientX, window.innerWidth - menuWidth),
      y: Math.min(event.clientY, window.innerHeight - menuHeight),
    }
  }

  const openSessionContextMenu = (
    event: MouseEvent<HTMLElement>,
    session: SessionSnapshot,
  ) => {
    event.preventDefault()

    setContextMenu({
      kind: 'session',
      session,
      ...getContextMenuPosition(event, 156),
    })
  }

  const openProjectContextMenu = (
    event: MouseEvent<HTMLElement>,
    project: ProjectSnapshot,
  ) => {
    event.preventDefault()

    setContextMenu({
      kind: 'project',
      project,
      ...getContextMenuPosition(event, 60),
    })
  }

  const libraryStatus = skillSyncStatus?.roots.find((entry) => entry.root === 'library')
  const librarySetupIssues =
    skillSyncStatus?.issues.filter(
      (issue) =>
        issue.root === 'library' &&
        ['missing-library-root', 'root-not-directory', 'root-read-failed'].includes(
          issue.code,
        ),
    ) ?? []

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar__header">
          <div className="sidebar__actions">
            <button
              type="button"
              className="sidebar__quick-action is-primary"
              onClick={onCreateSession}
            >
              <span
                className="sidebar__quick-action-icon sidebar__quick-action-icon--session"
                aria-hidden="true"
              />
              <span className="sidebar__quick-action-copy">
                <span className="sidebar__quick-action-title">New session</span>
              </span>
            </button>
            <button
              type="button"
              className="sidebar__quick-action"
              onClick={onCreateProject}
            >
              <span
                className="sidebar__quick-action-icon sidebar__quick-action-icon--project"
                aria-hidden="true"
              />
              <span className="sidebar__quick-action-copy">
                <span className="sidebar__quick-action-title">New project</span>
              </span>
            </button>
          </div>
        </div>

        <div className="session-list">
          {projects.length === 0 ? (
            <div className="sidebar__empty">
              <p>No projects yet.</p>
              <span>Create a project or session to get started.</span>
            </div>
          ) : null}

          {projects.map((project) => {
            const projectActive = project.config.id === activeProjectId
            const projectCollapsed = !isProjectExpanded(project.config.id)
            const projectSessionsId = `project-sessions-${project.config.id}`

            return (
              <section
                key={project.config.id}
                className={`project-group${projectActive ? ' is-active' : ''}${projectCollapsed ? ' is-collapsed' : ''}`}
              >
                <button
                  type="button"
                  className="project-group__header"
                  aria-expanded={!projectCollapsed}
                  aria-controls={projectSessionsId}
                  onClick={() => toggleProject(project.config.id)}
                  onContextMenu={(event) => openProjectContextMenu(event, project)}
                >
                  <div className="project-group__content">
                    <div className="project-group__title">{project.config.title}</div>
                  </div>
                  <div className="project-group__summary">
                    <span
                      className="project-group__count"
                      aria-label={`${project.sessions.length} sessions`}
                    >
                      {project.sessions.length}
                    </span>
                    <span className="project-group__toggle" aria-hidden="true">
                      {projectCollapsed ? '>' : 'v'}
                    </span>
                  </div>
                </button>

                {!projectCollapsed ? (
                  <div className="project-group__sessions" id={projectSessionsId}>
                    {project.sessions.length === 0 ? (
                      <div className="project-group__empty">No sessions yet.</div>
                    ) : null}

                    {project.sessions.map((session) => {
                      const active = session.config.id === activeSessionId
                      const editing = session.config.id === editingId
                      const attention = session.runtime.attention ?? null
                      const sessionLocationLabel = findSessionLocationLabel(project, session)

                      return (
                        <div
                          key={session.config.id}
                          role="button"
                          tabIndex={0}
                          className={`session-item is-nested${active ? ' is-active' : ''}${editing ? ' is-editing' : ''}`}
                          onClick={() => {
                            void onSelect(session.config.id)
                          }}
                          onContextMenu={(event) => openSessionContextMenu(event, session)}
                          onKeyDown={(event) => {
                            if (event.target !== event.currentTarget) {
                              return
                            }

                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              void onSelect(session.config.id)
                            }
                          }}
                        >
                          {editing ? (
                            <form
                              className="rename-form session-item__rename"
                              onSubmit={(event) => {
                                event.preventDefault()
                                void commitRename(session.config.id)
                              }}
                            >
                              <input
                                type="text"
                                value={draftTitle}
                                autoFocus
                                onClick={(event) => event.stopPropagation()}
                                onChange={(event) => setDraftTitle(event.target.value)}
                              />
                              <div className="rename-form__actions">
                                <button
                                  type="submit"
                                  className="ghost-button"
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  className="ghost-button"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    setEditingId(null)
                                    setDraftTitle('')
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                            </form>
                          ) : (
                            <div className="session-item__body">
                              <div className="session-item__title-group">
                                <div className="session-item__title">
                                  {attention ? (
                                    <span
                                      className={`session-item__attention is-${attention}`}
                                    >
                                      {getSessionAttentionBadgeLabel(attention)}
                                    </span>
                                  ) : null}
                                  <span className="session-item__title-label">
                                    {session.config.title}
                                  </span>
                                </div>
                                {sessionLocationLabel || showProjectPaths ? (
                                  <div className="session-item__command">
                                    {sessionLocationLabel
                                      ? `${sessionLocationLabel} · ${summarizeCommand(session.config.startupCommand, 28)}`
                                      : summarizeCommand(session.config.startupCommand, 36)}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </section>
            )
          })}
        </div>

        <div className="sidebar__footer">
          <div className="sidebar-settings" ref={settingsRef}>
            <button
              type="button"
              className="sidebar-settings__button"
              aria-expanded={settingsOpen}
              aria-haspopup="dialog"
              onClick={() => setSettingsOpen((current) => !current)}
            >
              <span className="sidebar-settings__icon" aria-hidden="true">
                ⚙
              </span>
              <span className="sidebar-settings__label">Settings</span>
            </button>

            {settingsOpen ? (
              <div className="sidebar-settings__panel" role="dialog" aria-label="Settings">
                <div className="sidebar-settings__section">
                  <p className="sidebar-settings__eyebrow">Interface</p>
                  <label className="sidebar-settings__toggle">
                    <input
                      type="checkbox"
                      checked={showProjectPaths}
                      onChange={onToggleProjectPaths}
                    />
                    <span>Show project paths in the sidebar</span>
                  </label>
                </div>

                <div className="sidebar-settings__section">
                  <div className="sidebar-settings__section-header">
                    <p className="sidebar-settings__eyebrow">Skills</p>
                    <button
                      type="button"
                      className="ghost-button sidebar-settings__sync-button"
                      disabled={skillsLoading || skillsBusy}
                      onClick={() => {
                        void onSyncSkills()
                      }}
                    >
                      {skillsSyncing ? 'Monitor sync' : 'Sync now'}
                    </button>
                  </div>

                  {skillsLoading ? (
                    <p className="sidebar-settings__caption">
                      Loading skill library settings…
                    </p>
                  ) : null}

                  {skillsErrorMessage ? (
                    <p className="sidebar-settings__error">{skillsErrorMessage}</p>
                  ) : null}

                  {skillLibrarySettings ? (
                    <>
                      <div className="sidebar-settings__group">
                        <div className="sidebar-settings__group-header">
                          <span className="sidebar-settings__field-label">
                            Library root
                          </span>
                          <span className="sidebar-settings__pill">
                            {libraryStatus
                              ? `${libraryStatus.skillNames.length} skills`
                              : 'Not scanned'}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="sidebar-settings__path-card"
                          disabled={skillsBusy}
                          onClick={() => {
                            void onPickSkillLibraryRoot()
                          }}
                        >
                          <span
                            className={`sidebar-settings__path-text${skillLibrarySettings.libraryRoot ? '' : ' is-placeholder'}`}
                          >
                            {skillLibrarySettings.libraryRoot ||
                              'Choose a canonical skill library root'}
                          </span>
                        </button>
                        <div className="sidebar-settings__actions">
                          <button
                            type="button"
                            className="ghost-button sidebar-settings__action"
                            disabled={skillsBusy}
                            onClick={() => {
                              void onPickSkillLibraryRoot()
                            }}
                          >
                            Choose
                          </button>
                          <button
                            type="button"
                            className="ghost-button sidebar-settings__action"
                            disabled={!skillLibrarySettings.libraryRoot}
                            onClick={() => {
                              void onOpenSkillLibraryRoot()
                            }}
                          >
                            Open
                          </button>
                          <button
                            type="button"
                            className="ghost-button sidebar-settings__action"
                            disabled={!skillLibrarySettings.libraryRoot || skillsBusy}
                            onClick={() => {
                              void onClearSkillLibraryRoot()
                            }}
                          >
                            Clear
                          </button>
                        </div>
                        <p className="sidebar-settings__caption">
                          {libraryStatus
                            ? summarizeSkills(libraryStatus.skillNames)
                            : 'Library status unavailable.'}
                        </p>
                        {librarySetupIssues.map((issue, index) => (
                          <p
                            key={`library-setup-issue-${issue.code}-${index}`}
                            className={
                              issue.severity === 'error'
                                ? 'sidebar-settings__error'
                                : 'sidebar-settings__caption'
                            }
                          >
                            {issue.message}
                          </p>
                        ))}
                      </div>

                      <div className="sidebar-settings__agent-grid">
                        <SkillAgentSelect
                          label="Primary agent"
                          value={skillLibrarySettings.primaryMergeAgent}
                          options={SKILL_AI_MERGE_AGENTS.map((agent) => ({
                            value: agent,
                            label: formatMergeAgentLabel(agent),
                          }))}
                          disabled={
                            skillsBusy ||
                            skillsGeneratingMerge !== null ||
                            skillsApplyingMerge
                          }
                          onChange={(agent) => {
                            void onSetPrimaryMergeAgent(agent)
                          }}
                        />

                        <SkillAgentSelect
                          label="Secondary agent"
                          value={skillLibrarySettings.reviewMergeAgent}
                          options={[
                            {
                              value: 'none',
                              label: 'None',
                            },
                            ...SKILL_AI_MERGE_AGENTS.filter(
                              (agent) =>
                                agent !== skillLibrarySettings.primaryMergeAgent,
                            ).map((agent) => ({
                              value: agent,
                              label: formatMergeAgentLabel(agent),
                            })),
                          ]}
                          disabled={
                            skillsBusy ||
                            skillsGeneratingMerge !== null ||
                            skillsApplyingMerge
                          }
                          onChange={(agent) => {
                            void onSetReviewMergeAgent(agent as SkillAiReviewAgent)
                          }}
                        />
                      </div>

                      <div className="sidebar-settings__group">
                        <div className="sidebar-settings__group-header">
                          <span className="sidebar-settings__field-label">
                            Project memory
                          </span>
                          <button
                            type="button"
                            className="ghost-button sidebar-settings__sync-button"
                            disabled={
                              skillsLoading ||
                              skillsBusy ||
                              projectMemoryImporting ||
                              !skillLibrarySettings.libraryRoot.trim()
                            }
                            onClick={() => {
                              void onImportHistoricalProjectMemory()
                            }}
                          >
                            {projectMemoryImporting ? 'Refreshing…' : 'Import history'}
                          </button>
                        </div>
                        <p className="sidebar-settings__caption">
                          Refresh stored project memory, rebuild architecture snapshots, and queue stored Agent CLIs sessions for low-priority import.
                        </p>
                        {projectMemoryImportStatus ? (
                          <p className="sidebar-settings__caption">
                            {projectMemoryImportStatus}
                          </p>
                        ) : null}
                        {!skillLibrarySettings.libraryRoot.trim() ? (
                          <p className="sidebar-settings__caption">
                            Choose a library root before importing history.
                          </p>
                        ) : null}
                      </div>

                      {skillSyncStatus?.conflicts.length ? (
                        <div className="sidebar-settings__issues">
                          <div className="sidebar-settings__subheading">
                            Conflicts
                          </div>
                          <div className="sidebar-settings__conflict-list">
                            {skillSyncStatus.conflicts.map((conflict) => {
                              const mergePreview =
                                skillAiMergeProposal?.skillName === conflict.skillName
                                  ? skillAiMergeProposal
                                  : null

                              return (
                                <div
                                  key={conflict.skillName}
                                  className="sidebar-settings__conflict"
                                >
                                  <div className="sidebar-settings__conflict-header">
                                    <span className="sidebar-settings__field-label">
                                      {conflict.skillName}
                                    </span>
                                    <span className="sidebar-settings__pill">
                                      {conflict.recommendedRootLabel
                                        ? `Prefer ${conflict.recommendedRootLabel}`
                                        : 'Choose a source'}
                                    </span>
                                  </div>

                                  <p className="sidebar-settings__caption">
                                    {summarizeDifferingFiles(conflict.differingFiles)}
                                  </p>

                                  <div className="sidebar-settings__actions">
                                    <button
                                      type="button"
                                      className="ghost-button sidebar-settings__action"
                                      disabled={
                                        skillsSyncing ||
                                        skillsBusy ||
                                        skillsResolving !== null ||
                                        skillsGeneratingMerge !== null ||
                                        skillsApplyingMerge
                                      }
                                      onClick={() => {
                                        void onGenerateSkillAiMerge(conflict.skillName)
                                      }}
                                    >
                                      {skillsGeneratingMerge === conflict.skillName
                                        ? 'Merging…'
                                        : 'AI Merge'}
                                    </button>

                                    {conflict.roots.map((rootVersion) => (
                                      <button
                                        key={`${conflict.skillName}-${rootVersion.root}`}
                                        type="button"
                                        className="ghost-button sidebar-settings__action"
                                        disabled={
                                          skillsSyncing ||
                                          skillsBusy ||
                                          skillsResolving !== null ||
                                          skillsGeneratingMerge !== null ||
                                          skillsApplyingMerge
                                        }
                                        onClick={() => {
                                          void onResolveSkillConflict(
                                            conflict.skillName,
                                            rootVersion.root,
                                          )
                                        }}
                                      >
                                        {skillsResolving === conflict.skillName
                                          ? 'Applying…'
                                          : `Use ${rootVersion.label || findConflictRootLabel(skillSyncStatus, rootVersion.root)}`}
                                      </button>
                                    ))}
                                  </div>

                                  {mergePreview ? (
                                    <div className="sidebar-settings__merge-preview">
                                      <div className="sidebar-settings__conflict-header">
                                        <span className="sidebar-settings__field-label">
                                          AI Merge Preview
                                        </span>
                                        <span className="sidebar-settings__pill">
                                          Via {formatMergeAgentLabel(mergePreview.mergeAgent)}
                                        </span>
                                      </div>

                                      <p className="sidebar-settings__caption">
                                        {mergePreview.summary}
                                      </p>

                                      <p className="sidebar-settings__caption">
                                        {mergePreview.rationale}
                                      </p>

                                      {mergePreview.review ? (
                                        <p className="sidebar-settings__caption">
                                          {formatReviewStatus(mergePreview.review.status)} by{' '}
                                          {formatMergeAgentLabel(mergePreview.review.reviewer)}
                                        </p>
                                      ) : null}

                                      <div className="sidebar-settings__merge-files">
                                        {mergePreview.files.map((file) => (
                                          <details
                                            key={`${mergePreview.skillName}-${file.path}`}
                                            className="sidebar-settings__merge-file"
                                            open={file.path === 'SKILL.md'}
                                          >
                                            <summary className="sidebar-settings__merge-file-title">
                                              {file.path}
                                            </summary>
                                            <pre className="sidebar-settings__merge-file-preview">
                                              {file.content}
                                            </pre>
                                          </details>
                                        ))}
                                      </div>

                                      <div className="sidebar-settings__actions">
                                        <button
                                          type="button"
                                          className="ghost-button sidebar-settings__action"
                                          disabled={
                                            skillsApplyingMerge ||
                                            skillsSyncing ||
                                            skillsBusy
                                          }
                                          onClick={() => {
                                            void onApplySkillAiMerge()
                                          }}
                                        >
                                          {skillsApplyingMerge ? 'Applying merge…' : 'Apply Merge'}
                                        </button>
                                        <button
                                          type="button"
                                          className="ghost-button sidebar-settings__action"
                                          disabled={skillsApplyingMerge}
                                          onClick={onDismissSkillAiMerge}
                                        >
                                          Dismiss
                                        </button>
                                      </div>
                                    </div>
                                  ) : null}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </aside>

      {contextMenu ? (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenu.kind === 'project' ? (
            <button
              type="button"
              className="context-menu__item"
              onClick={() => {
                onCreateForProject(contextMenu.project.config.id)
                setContextMenu(null)
              }}
            >
              New session
            </button>
          ) : (
            <>
              <button
                type="button"
                className="context-menu__item"
                onClick={() => {
                  void onToggleWindowsCommandPrompt(contextMenu.session.config.id)
                  setContextMenu(null)
                }}
              >
                {windowsCommandPromptSessionIds.includes(contextMenu.session.config.id)
                  ? 'Hide CMD'
                  : 'Show CMD'}
              </button>
              <button
                type="button"
                className="context-menu__item"
                onClick={() => {
                  beginEditing(contextMenu.session)
                  setContextMenu(null)
                }}
              >
                Rename session
              </button>
              <button
                type="button"
                className="context-menu__item is-danger"
                onClick={() => {
                  void onClose(contextMenu.session.config.id)
                  setContextMenu(null)
                }}
              >
                Close session
              </button>
            </>
          )}
        </div>
      ) : null}
    </>
  )
}
