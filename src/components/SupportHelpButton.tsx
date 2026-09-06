import { useState } from 'react'
import { LifeBuoy } from 'lucide-react'
import { SupportTicketForm } from './SupportTicketForm'

export function SupportHelpButton() {
  const [open, setOpen] = useState(false)
  return <>
    <button className="support-help-button" onClick={() => setOpen(true)} title="Need Help?" type="button"><LifeBuoy aria-hidden="true" size={20} /><span>Need Help?</span></button>
    {open ? <SupportTicketForm onClose={() => setOpen(false)} /> : null}
  </>
}
