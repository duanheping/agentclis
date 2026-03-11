import { type FormEvent, useEffect, useState } from 'react'

import type { CreateSessionInput } from '../shared/session'

interface CreateSessionDialogProps {
  open: boolean
  onClose: () => void
  onSubmit: (input: CreateSessionInput) => Promise<void>
}

interface CreateSessionFormState {
  title: string
  startupCommand: string
  cwd: string
}

const emptyFormState: CreateSessionFormState = {
  title: '',
  startupCommand: '',
  cwd: '',
}

export function CreateSessionDialog({
  open,
  onClose,
  onSubmit,
}: CreateSessionDialogProps) {
  const [formState, setFormState] = useState<CreateSessionFormState>(emptyFormState)
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    setFormState(emptyFormState)
    setErrorMessage(null)
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }

    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) {
        onClose()
      }
    }

    window.addEventListener('keydown', onWindowKeyDown)
    return () => window.removeEventListener('keydown', onWindowKeyDown)
  }, [onClose, open, submitting])

  if (!open) {
    return null
  }

  const updateField = (field: keyof CreateSessionFormState, value: string) => {
    setFormState((current) => ({
      ...current,
      [field]: value,
    }))
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!formState.startupCommand.trim()) {
      setErrorMessage('启动命令不能为空。')
      return
    }

    setSubmitting(true)
    setErrorMessage(null)

    try {
      await onSubmit({
        title: formState.title,
        startupCommand: formState.startupCommand,
        cwd: formState.cwd,
      })
      onClose()
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : '创建会话时发生未知错误。',
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
        aria-labelledby="create-session-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-card__header">
          <div>
            <p className="eyebrow">New Session</p>
            <h2 id="create-session-title">新建 Agent CLI</h2>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={onClose}
            disabled={submitting}
          >
            关闭
          </button>
        </div>

        <form className="dialog-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>标题（可选）</span>
            <input
              type="text"
              value={formState.title}
              placeholder="例如：Agent / Research / Build"
              onChange={(event) => updateField('title', event.target.value)}
            />
          </label>

          <label className="field">
            <span>启动命令</span>
            <input
              type="text"
              autoFocus
              value={formState.startupCommand}
              placeholder="例如：agent --profile dev"
              onChange={(event) =>
                updateField('startupCommand', event.target.value)
              }
            />
          </label>

          <label className="field">
            <span>工作目录 CWD（可选）</span>
            <input
              type="text"
              value={formState.cwd}
              placeholder="留空时默认使用用户目录"
              onChange={(event) => updateField('cwd', event.target.value)}
            />
            <span className="field-hint">例如：E:\repo\project</span>
          </label>

          {errorMessage ? <p className="form-error">{errorMessage}</p> : null}

          <div className="dialog-actions">
            <button
              type="button"
              className="ghost-button"
              onClick={onClose}
              disabled={submitting}
            >
              取消
            </button>
            <button type="submit" className="primary-button" disabled={submitting}>
              {submitting ? '创建中…' : '创建会话'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
