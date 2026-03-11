import { type MouseEvent, useEffect, useRef, useState } from 'react'

import { type ProjectSnapshot, type SessionSnapshot } from '../shared/session'

interface SessionSidebarProps {
  projects: ProjectSnapshot[]
  activeSessionId: string | null
  showProjectPaths: boolean
  onCreate: () => void
  onCreateForProject: (projectId: string) => void
  onSelect: (id: string) => Promise<void>
  onRename: (id: string, title: string) => Promise<void>
  onClose: (id: string) => Promise<void>
  onToggleProjectPaths: () => void
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

export function SessionSidebar({
  projects,
  activeSessionId,
  showProjectPaths,
  onCreate,
  onCreateForProject,
  onSelect,
  onRename,
  onClose,
  onToggleProjectPaths,
}: SessionSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>([])
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef<HTMLDivElement | null>(null)
  const visibleCollapsedProjectIds = collapsedProjectIds.filter(
    (projectId) => projects.some((project) => project.config.id === projectId),
  )

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

  const toggleProject = (projectId: string) => {
    setCollapsedProjectIds((current) =>
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId],
    )
  }

  const getContextMenuPosition = (
    event: MouseEvent<HTMLElement>,
    menuHeight: number,
  ): ContextMenuPosition => {
    const menuWidth = 180

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
      ...getContextMenuPosition(event, 104),
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

  return (
    <aside className="sidebar">
      <div className="sidebar__header">
        <div>
          <p className="eyebrow">Project List</p>
          <h1>Projects</h1>
          <p className="sidebar__subtitle">
            Projects first, with each session nested underneath.
          </p>
        </div>
        <button
          type="button"
          className="primary-button sidebar__new-button"
          onClick={onCreate}
        >
          + New
        </button>
      </div>

      <div className="session-list">
        {projects.length === 0 ? (
          <div className="sidebar__empty">
            <p>No projects yet.</p>
            <span>Create a session and it will appear under its project.</span>
          </div>
        ) : null}

        {projects.map((project) => {
          const projectActive = project.sessions.some(
            (session) => session.config.id === activeSessionId,
          )
          const projectCollapsed = visibleCollapsedProjectIds.includes(project.config.id)
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
          ) : null}
        </div>
      </div>

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
    </aside>
  )
}
