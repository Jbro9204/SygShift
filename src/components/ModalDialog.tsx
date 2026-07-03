import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

interface ModalDialogProps {
  children: ReactNode
  description?: string
  onClose: () => void
  title: string
}

export function ModalDialog({ children, description, onClose, title }: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  return (
    <dialog
      aria-describedby={description ? 'modal-description' : undefined}
      aria-labelledby="modal-title"
      className="modal-dialog"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      ref={dialogRef}
    >
      <div className="modal-dialog__heading">
        <div>
          <h2 id="modal-title">{title}</h2>
          {description ? <p id="modal-description">{description}</p> : null}
        </div>
        <button aria-label="Close dialog" className="modal-close" onClick={onClose} type="button">
          <X aria-hidden="true" size={22} />
        </button>
      </div>
      {children}
    </dialog>
  )
}
