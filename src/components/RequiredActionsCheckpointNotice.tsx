import { AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, FileSignature, GraduationCap, Megaphone, ShieldAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { RequiredActionCheckpoint, RequiredActionCheckpointItem } from '../data/actionCenter'

const actionIcons = {
  announcement: Megaphone,
  training: GraduationCap,
  schedule: CalendarClock,
  hr_task: CheckCircle2,
  document: FileSignature,
  signature: FileSignature,
} as const

function dueLabel(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

function actionTypeLabel(item: RequiredActionCheckpointItem): string {
  if (item.actionType === 'hr_task') return 'HR action'
  if (item.actionType === 'signature') return 'Signature request'
  if (item.actionType === 'document') return 'Assigned document'
  return item.actionType.charAt(0).toUpperCase() + item.actionType.slice(1)
}

export function RequiredActionsCheckpointNotice({ checkpoint }: { checkpoint: RequiredActionCheckpoint }) {
  if (!checkpoint.blocking || !checkpoint.items.length) return null
  const current = checkpoint.items[0]
  const Icon = actionIcons[current.actionType]

  return (
    <section aria-labelledby="required-actions-title" className="required-actions-checkpoint">
      <header className="required-actions-checkpoint__header">
        <div className="required-actions-checkpoint__icon"><ShieldAlert aria-hidden="true" size={26} /></div>
        <div>
          <p className="eyebrow">Required before entering the workspace</p>
          <h1 id="required-actions-title">Let’s finish your required actions</h1>
          <p>SygShift keeps everything in one ordered list and saves each response against the exact assigned version.</p>
        </div>
        <span className="required-actions-checkpoint__count">{checkpoint.total} remaining</span>
      </header>

      <div className="required-actions-checkpoint__progress" aria-label={`Action 1 of ${checkpoint.total}`}>
        <div><strong>Action 1 of {checkpoint.total}</strong><span>{current.priority === 'critical' ? 'Critical item first' : 'Next required item'}</span></div>
        <div aria-hidden="true"><span style={{ width: `${Math.max(8, 100 / checkpoint.total)}%` }} /></div>
      </div>

      <article className={`required-actions-checkpoint__current required-actions-checkpoint__current--${current.priority}`}>
        <div className="required-actions-checkpoint__current-icon"><Icon aria-hidden="true" size={22} /></div>
        <div className="required-actions-checkpoint__current-copy">
          <span>{actionTypeLabel(current)} · {current.authoritativeVersion}</span>
          <h2>{current.title}</h2>
          <p>{current.description}</p>
          <small>{String(current.metadata.wording ?? 'Your response is saved to the permanent Action Center history.')}{dueLabel(current.dueAt) ? ` · Due ${dueLabel(current.dueAt)}` : ''}</small>
        </div>
        <Link className="primary-action" to={current.route}>{current.actionLabel}<ArrowRight aria-hidden="true" size={17} /></Link>
      </article>

      {checkpoint.total > 1 ? (
        <details className="required-actions-checkpoint__queue">
          <summary>View all {checkpoint.total} required actions</summary>
          <ol>{checkpoint.items.map((item) => {
            const ItemIcon = actionIcons[item.actionType]
            return <li key={`${item.actionType}-${item.id}`}><ItemIcon aria-hidden="true" size={17} /><div><strong>{item.title}</strong><span>{actionTypeLabel(item)} · {item.authoritativeVersion}</span></div><Link to={item.route}>Open</Link></li>
          })}</ol>
        </details>
      ) : null}

      <div className="required-actions-checkpoint__urgent">
        <div><AlertTriangle aria-hidden="true" size={19} /><span><strong>Urgent access always remains available.</strong> Required actions never stop you from clocking in/out or reporting a call-off.</span></div>
        <nav aria-label="Urgent access">
          <Link to="/">Clock in or out</Link>
          <Link to="/time/my-time?report=call-off">Report sick / call-off</Link>
        </nav>
        <details><summary>Emergency information</summary><p>For an immediate threat or medical emergency, call 911 and follow your established Dispatch emergency procedure. Do not wait for a SygShift action or support ticket.</p></details>
      </div>
    </section>
  )
}
