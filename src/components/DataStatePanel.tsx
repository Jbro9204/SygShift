import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

interface DataStatePanelProps {
  icon: LucideIcon
  title: string
  children: ReactNode
  tone?: 'setup' | 'error' | 'empty'
}

export function DataStatePanel({ icon: Icon, title, children, tone = 'empty' }: DataStatePanelProps) {
  return (
    <section className={`data-state data-state--${tone}`} aria-live="polite">
      <div className="data-state__icon">
        <Icon aria-hidden="true" size={28} />
      </div>
      <div>
        <h2>{title}</h2>
        <div className="data-state__copy">{children}</div>
      </div>
    </section>
  )
}
