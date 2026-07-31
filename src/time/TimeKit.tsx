import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

interface TimeButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: LucideIcon
  loading?: boolean
  variant?: ButtonVariant
}

export function TimeButton({ children, className, icon: Icon, loading = false, variant = 'secondary', ...props }: TimeButtonProps) {
  return (
    <button
      {...props}
      aria-busy={loading || undefined}
      className={['time-button', `time-button--${variant}`, className].filter(Boolean).join(' ')}
      disabled={props.disabled || loading}
      type={props.type ?? 'button'}
    >
      {loading ? <span aria-hidden="true" className="time-button__spinner" /> : Icon ? <Icon aria-hidden="true" size={18} /> : null}
      <span>{children}</span>
    </button>
  )
}

export function TimePageHeader({
  actions,
  eyebrow,
  summary,
  title,
}: {
  actions?: ReactNode
  eyebrow: string
  summary: string
  title: string
}) {
  return (
    <section className="time-page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{summary}</p>
      </div>
      {actions ? <div className="time-page-header__actions">{actions}</div> : null}
    </section>
  )
}

export function TimeSectionHeader({
  action,
  eyebrow,
  summary,
  title,
}: {
  action?: ReactNode
  eyebrow?: string
  summary?: string
  title: string
}) {
  return (
    <header className="time-section-header">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2>{title}</h2>
        {summary ? <p>{summary}</p> : null}
      </div>
      {action ? <div className="time-section-header__action">{action}</div> : null}
    </header>
  )
}

export function TimeMetricCard({
  ariaLabel,
  detail,
  icon: Icon,
  label,
  tone = 'neutral',
  to,
  value,
}: {
  ariaLabel?: string
  detail: string
  icon?: LucideIcon
  label: string
  tone?: 'neutral' | 'good' | 'warning' | 'danger'
  to?: string
  value: ReactNode
}) {
  const className = `time-card time-metric time-metric--${tone}${to ? ' time-metric--actionable' : ''}`
  const content = (
    <>
      <div className="time-metric__top">
        <span>{label}</span>
        {Icon ? <Icon aria-hidden="true" size={20} /> : null}
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </>
  )

  if (to) {
    return (
      <Link aria-label={ariaLabel ?? `${label}: open details`} className={className} to={to}>
        {content}
      </Link>
    )
  }

  return (
    <article className={className}>
      {content}
    </article>
  )
}

export function TimeStatusBadge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'good' | 'warning' | 'danger'
}) {
  return <span className={`time-status-badge time-status-badge--${tone}`}>{children}</span>
}

export function TimeAlertCard({
  children,
  icon: Icon,
  title,
  tone = 'neutral',
}: {
  children: ReactNode
  icon: LucideIcon
  title: string
  tone?: 'neutral' | 'good' | 'warning' | 'danger'
}) {
  return (
    <section className={`time-alert time-alert--${tone}`}>
      <Icon aria-hidden="true" size={22} />
      <div>
        <strong>{title}</strong>
        <div>{children}</div>
      </div>
    </section>
  )
}

export function TimeEmptyState({ children, icon: Icon, title }: { children: ReactNode; icon: LucideIcon; title: string }) {
  return (
    <section className="time-empty-state">
      <Icon aria-hidden="true" size={28} />
      <h2>{title}</h2>
      <div>{children}</div>
    </section>
  )
}
