import { type MouseEvent, useEffect, useRef, useState } from 'react'

import {
  SKILL_SYNC_ROOTS,
  SKILL_TARGET_PROVIDERS,
  type SkillConflict,
  type SkillLibrarySettings,
  type SkillSyncIssue,
  type SkillSyncRoot,
  type SkillSyncStatus,
  type SkillTargetProvider,
} from '../shared/skills'
import { type ProjectSnapshot, type SessionSnapshot } from '../shared/session'

interface SessionSidebarProps {
  projects: ProjectSnapshot[]
  activeSessionId: string | null
  showProjectPaths: boolean
  onToggleSidebar: () => void
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
  skillsErrorMessage: string | null
  onPickSkillLibraryRoot: () => Promise<void>
  onClearSkillLibraryRoot: () => Promise<void>
  onOpenSkillLibraryRoot: () => Promise<void>
  onToggleSkillAutoSync: () => Promise<void>
  onPickSkillTargetRoot: (provider: SkillTargetProvider) => Promise<void>
  onClearSkillTargetRoot: (provider: SkillTargetProvider) => Promise<void>
  onOpenSkillTargetRoot: (provider: SkillTargetProvider) => Promise<void>
  onSyncSkills: () => Promise<void>
  onResolveSkillConflict: (
    skillName: string,
    sourceRoot: SkillSyncRoot,
  ) => Promise<void>
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

function formatProviderLabel(provider: SkillTargetProvider): string {
  return provider === 'codex' ? 'Codex' : 'Claude'
}

function formatRootLabel(root: SkillSyncRoot): string {
  if (root === 'library') {
    return 'Library'
  }

  return root === 'codex' ? 'Codex' : 'Claude'
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return parsed.toLocaleString()
}

function formatIssueLabel(issue: SkillSyncIssue): string {
  const prefixParts = [
    issue.root ? formatRootLabel(issue.root) : null,
    issue.skillName ?? null,
  ].filter(Boolean)

  if (prefixParts.length === 0) {
    return issue.message
  }

  return `${prefixParts.join(' / ')}: ${issue.message}`
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

function summarizeDifferingFiles(conflict: SkillConflict): string {
  if (conflict.differingFiles.length === 0) {
    return 'Content differs between roots.'
  }

  if (conflict.differingFiles.length <= 3) {
    return conflict.differingFiles.join(', ')
  }

  return `${conflict.differingFiles.slice(0, 3).join(', ')} +${conflict.differingFiles.length - 3} more`
}

export function SessionSidebar({
  projects,
  activeSessionId,
  showProjectPaths,
  onToggleSidebar,
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
  skillsErrorMessage,
  onPickSkillLibraryRoot,
  onClearSkillLibraryRoot,
  onOpenSkillLibraryRoot,
  onToggleSkillAutoSync,
  onPickSkillTargetRoot,
  onClearSkillTargetRoot,
  onOpenSkillTargetRoot,
  onSyncSkills,
  onResolveSkillConflict,
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
      if (!settingsRef.current?.contains(event.target as Node)) {
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
  const providerStatuses = Object.fromEntries(
    SKILL_TARGET_PROVIDERS.map((provider) => [
      provider,
      skillSyncStatus?.roots.find((entry) => entry.root === provider) ?? null,
    ]),
  ) as Record<SkillTargetProvider, SkillSyncStatus['roots'][number] | null>
  const lastSyncRootResults =
    skillSyncStatus?.lastSyncResult && Array.isArray(skillSyncStatus.lastSyncResult.roots)
      ? skillSyncStatus.lastSyncResult.roots
      : []

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar__header">
          <div className="sidebar__topbar">
            <button
              type="button"
              className="sidebar__toggle-button"
              aria-label="Collapse sidebar"
              onClick={onToggleSidebar}
            >
              <span className="sidebar__toggle-icon" aria-hidden="true" />
              <span className="sidebar__toggle-label">Hide sidebar</span>
            </button>
          </div>

          <div className="sidebar__actions">
            <button
              type="button"
              className="sidebar__quick-action"
              onClick={onCreateSession}
            >
              <span
                className="sidebar__quick-action-icon sidebar__quick-action-icon--session"
                aria-hidden="true"
              />
              New session
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
              New project
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
                    {showProjectPaths ? (
                      <div className="project-group__path">{project.config.rootPath}</div>
                    ) : null}
                  </div>
                  <div className="project-group__summary">
                    <span
                      className="project-group__count"
                      aria-label={`${project.sessions.length} sessions`}
                    >
                      {project.sessions.length}
                    </span>
                    <span className="project-group__toggle" aria-hidden="true">
                      {projectCollapsed ? '▸' : '▾'}
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
                            <div className="session-item__title">
                              {session.config.title}
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
                      disabled={skillsLoading || skillsBusy || skillsSyncing}
                      onClick={() => {
                        void onSyncSkills()
                      }}
                    >
                      {skillsSyncing ? 'Syncing…' : 'Sync now'}
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
                      </div>

                      <label className="sidebar-settings__toggle">
                        <input
                          type="checkbox"
                          checked={skillLibrarySettings.autoSyncOnAppStart}
                          disabled={skillsBusy}
                          onChange={() => {
                            void onToggleSkillAutoSync()
                          }}
                        />
                        <span>Auto-sync on app start</span>
                      </label>

                      <div className="sidebar-settings__provider-list">
                        {SKILL_TARGET_PROVIDERS.map((provider) => {
                          const providerStatus = providerStatuses[provider]
                          const targetRoot =
                            skillLibrarySettings.providers[provider].targetRoot

                          return (
                            <div key={provider} className="sidebar-settings__group">
                              <div className="sidebar-settings__group-header">
                                <span className="sidebar-settings__field-label">
                                  {formatProviderLabel(provider)} target root
                                </span>
                                <span className="sidebar-settings__pill">
                                  {providerStatus?.skillNames.length ?? 0} skills
                                </span>
                              </div>
                              <button
                                type="button"
                                className="sidebar-settings__path-card"
                                disabled={skillsBusy}
                                onClick={() => {
                                  void onPickSkillTargetRoot(provider)
                                }}
                              >
                                <span
                                  className={`sidebar-settings__path-text${targetRoot ? '' : ' is-placeholder'}`}
                                >
                                  {targetRoot || `Choose the ${formatProviderLabel(provider)} skills folder`}
                                </span>
                              </button>
                              <div className="sidebar-settings__actions">
                                <button
                                  type="button"
                                  className="ghost-button sidebar-settings__action"
                                  disabled={skillsBusy}
                                  onClick={() => {
                                    void onPickSkillTargetRoot(provider)
                                  }}
                                >
                                  Choose
                                </button>
                                <button
                                  type="button"
                                  className="ghost-button sidebar-settings__action"
                                  disabled={!targetRoot}
                                  onClick={() => {
                                    void onOpenSkillTargetRoot(provider)
                                  }}
                                >
                                  Open
                                </button>
                                <button
                                  type="button"
                                  className="ghost-button sidebar-settings__action"
                                  disabled={!targetRoot || skillsBusy}
                                  onClick={() => {
                                    void onClearSkillTargetRoot(provider)
                                  }}
                                >
                                  Clear
                                </button>
                              </div>
                              <p className="sidebar-settings__caption">
                                {providerStatus
                                  ? summarizeSkills(providerStatus.skillNames)
                                  : 'Provider status unavailable.'}
                              </p>
                            </div>
                          )
                        })}
                      </div>

                      {skillSyncStatus ? (
                        <>
                          {skillSyncStatus.issues.length > 0 ? (
                            <div className="sidebar-settings__issues">
                              <div className="sidebar-settings__subheading">
                                Validation
                              </div>
                              <ul className="sidebar-settings__issue-list">
                                {skillSyncStatus.issues.map((issue, index) => (
                                  <li
                                    key={`${issue.code}-${issue.root ?? 'global'}-${issue.skillName ?? 'none'}-${index}`}
                                    className={`sidebar-settings__issue sidebar-settings__issue--${issue.severity}`}
                                  >
                                    {formatIssueLabel(issue)}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : (
                            <p className="sidebar-settings__caption">
                              No validation issues detected.
                            </p>
                          )}

                          {skillSyncStatus.conflicts.length > 0 ? (
                            <div className="sidebar-settings__issues">
                              <div className="sidebar-settings__subheading">
                                Conflicts
                              </div>
                              <div className="sidebar-settings__conflict-list">
                                {skillSyncStatus.conflicts.map((conflict) => {
                                  const availableRoots = new Set(
                                    conflict.roots.map((entry) => entry.root),
                                  )

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
                                          {conflict.recommendedRoot
                                            ? `Prefer ${formatRootLabel(conflict.recommendedRoot)}`
                                            : 'Choose a source'}
                                        </span>
                                      </div>
                                      <p className="sidebar-settings__caption">
                                        {summarizeDifferingFiles(conflict)}
                                      </p>
                                      <div className="sidebar-settings__actions">
                                        {SKILL_SYNC_ROOTS.map((root) => (
                                          <button
                                            key={`${conflict.skillName}-${root}`}
                                            type="button"
                                            className="ghost-button sidebar-settings__action"
                                            disabled={
                                              !availableRoots.has(root) ||
                                              skillsSyncing ||
                                              skillsBusy ||
                                              skillsResolving !== null
                                            }
                                            onClick={() => {
                                              void onResolveSkillConflict(
                                                conflict.skillName,
                                                root,
                                              )
                                            }}
                                          >
                                            {skillsResolving === conflict.skillName
                                              ? 'Applying…'
                                              : `Use ${formatRootLabel(root)}`}
                                          </button>
                                        ))}
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          ) : null}

                          {skillSyncStatus.lastSyncResult ? (
                            <div className="sidebar-settings__last-sync">
                              <div className="sidebar-settings__subheading">
                                Last sync
                              </div>
                              <div className="sidebar-settings__status-row">
                                <span>
                                  {skillSyncStatus.lastSyncResult.success
                                    ? 'Succeeded'
                                    : 'Failed'}
                                </span>
                                <strong>
                                  {formatTimestamp(
                                    skillSyncStatus.lastSyncResult.completedAt,
                                  )}
                                </strong>
                              </div>
                              {lastSyncRootResults.map((rootResult) => (
                                <div
                                  key={`last-sync-${rootResult.root}`}
                                  className="sidebar-settings__status-row"
                                >
                                  <span>{formatRootLabel(rootResult.root)}</span>
                                  <strong>
                                    {rootResult.skipped
                                      ? 'Skipped'
                                      : rootResult.changed
                                        ? 'Updated'
                                        : 'No changes'}
                                  </strong>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </>
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
