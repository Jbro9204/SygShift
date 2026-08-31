import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

interface ModalDialogProps {
  busy?: boolean
  busyLabel?: string
  children: ReactNode
  className?: string
  description?: string
  onClose: () => void
  title: string
}

export function ModalDialog({ busy = false, busyLabel = 'Saving changes...', children, className, description, onClose, title }: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog) return
    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [])

  return (
    <dialog
      aria-describedby={description ? descriptionId : undefined}
      aria-labelledby={titleId}
      aria-busy={busy}
      className={['modal-dialog', className].filter(Boolean).join(' ')}
      onCancel={(event) => {
        event.preventDefault()
        if (busy) return
        onClose()
      }}
      ref={dialogRef}
    >
      <div className="modal-dialog__heading">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description ? <p id={descriptionId}>{description}</p> : null}
        </div>
        <button aria-label="Close dialog" className="modal-close" disabled={busy} onClick={onClose} type="button">
          <X aria-hidden="true" size={22} />
        </button>
      </div>
      {busy ? (
        <div className="modal-dialog__busy" role="status">
          <span aria-hidden="true" className="modal-dialog__spinner" />
          <span>{busyLabel}</span>
        </div>
      ) : null}
      {children}
    </dialog>
  )
}
