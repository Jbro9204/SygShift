import { NavLink } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getMySygTasksBadge } from '../data/sygtasks'
import '../styles/sygtasks-launcher.css'

const tooltipId = 'sygtasks-launcher-tooltip'

export function SygTasksLauncher() {
  const badge = useQuery({
    queryKey: ['sygtasks-badge'],
    queryFn: getMySygTasksBadge,
    refetchInterval: () => document.visibilityState === 'visible' ? 30_000 : false,
    refetchOnWindowFocus: true,
    retry: false,
  })
  const badgeCount = badge.data?.count ?? 0
  return (
    <div className="syg-launcher-shell sygtasks-launcher-shell">
      <NavLink
        aria-describedby={tooltipId}
        aria-label="Open SygTasks work management"
        className={({ isActive }) => isActive
          ? 'syg-launcher syg-launcher--tasks sygtasks-launcher sygtasks-launcher--active'
          : 'syg-launcher syg-launcher--tasks sygtasks-launcher'}
        to="/tasks"
      >
        <span aria-hidden="true" className="syg-launcher__emblem sygtasks-launcher__emblem">
          <img alt="" src="/branding/sygtasks-emblem.png" />
        </span>
        <span aria-hidden="true" className="syg-launcher__brand sygtasks-launcher__brand">
          <img alt="" src="/branding/sygtasks-logo.png" />
          <small>WORK MANAGEMENT</small>
        </span>
        {badgeCount > 0 ? <span aria-label={`${badgeCount} SygTasks update${badgeCount === 1 ? '' : 's'} need attention`} className="sygtasks-launcher__badge">{badgeCount > 99 ? '99+' : badgeCount}</span> : null}
        <span className="sygtasks-launcher__tooltip" id={tooltipId} role="tooltip">
          SygTasks · Work Management
        </span>
      </NavLink>
    </div>
  )
}
