import { Link } from 'react-router-dom'
import type { SystemServiceStatus } from '../data/systemStatus'

export function SystemStatusIndicator({
  canOpenOperations,
  status,
}: {
  canOpenOperations: boolean
  status: SystemServiceStatus
}) {
  const content = (
    <>
      <span aria-hidden="true" className="system-status-indicator__dot" />
      <span>{status.label}</span>
    </>
  )
  const className = `system-status-indicator system-status-indicator--${status.state}`

  if (canOpenOperations) {
    return (
      <Link aria-label={`${status.label}. Open System Operations.`} className={className} title={status.detail} to="/system-operations">
        {content}
      </Link>
    )
  }

  return (
    <div aria-label={`${status.label}. ${status.detail}`} className={className} role="status" title={status.detail}>
      {content}
    </div>
  )
}
