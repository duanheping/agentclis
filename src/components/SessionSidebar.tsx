import { type MouseEvent, useEffect, useState } from 'react'

import {
  summarizeCommand,
  type ProjectSnapshot,
  type SessionSnapshot,
  type SessionStatus,
} from '../shared/session'

interface SessionSidebarProps {
  projects: ProjectSnapshot[]
  activeSessionId: string | null
  onCreate: () => void
  onSelect: (id: string) => Promise<void>
  onRename: (id: string, title: string) => Promise<void>
  onClose: (id: string) => Promise<void>
}

interface ContextMenuState {
  session: SessionSnapshot
  x: number
  y: number
}

const statusLabels: Record<SessionStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  exited: 'Exited',
  error: 'Error',
}

export function SessionSidebar({
  projects,
  activeSessionId,
  onCreate,
  onSelect,
  onRename,
  onClose,
}: SessionSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>([])
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const activeProjectId =
    projects.find((project) =>
      project.sessions.some((session) => session.config.id === activeSessionId),
    )?.config.id ?? null
  const visibleCollapsedProjectIds = collapsedProjectIds.filter(
    (projectId) =>
      projectId !== activeProjectId &&
      projects.some((project) => project.config.id === projectId),
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

  const openContextMenu = (
    event: MouseEvent<HTMLElement>,
    session: SessionSnapshot,
  ) => {
    event.preventDefault()

    const menuWidth = 180
    const menuHeight = 104

    setContextMenu({
      session,
      x: Math.min(event.clientX, window.innerWidth - menuWidth),
      y: Math.min(event.clientY, window.innerHeight - menuHeight),
    })
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__header">
        <div>
          <p className="eyebrow">Project List</p>
          <h1>Agent CLIs</h1>
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
              >
                <div className="project-group__content">
                  <div className="project-group__title">{project.config.title}</div>
                  <div className="project-group__path">{project.config.rootPath}</div>
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
                        onContextMenu={(event) => openContextMenu(event, session)}
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
                          <>
                            <span
                              className={`status-dot is-${session.runtime.status}`}
                              aria-hidden="true"
                            />
                            <div className="session-item__content">
                              <div className="session-item__title">
                                {session.config.title}
                              </div>
                              <div className="session-item__meta">
                                <div className="session-item__command">
                                  {summarizeCommand(session.config.startupCommand)}
                                </div>
                                <span className={`session-item__status is-${session.runtime.status}`}>
                                  {statusLabels[session.runtime.status]}
                                </span>
                              </div>
                            </div>
                          </>
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

      {contextMenu ? (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
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
        </div>
      ) : null}
    </aside>
  )
}
