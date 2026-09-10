import { NavLink } from 'react-router-dom'
import '../styles/sygtasks-launcher.css'

const tooltipId = 'sygtasks-launcher-tooltip'

export function SygTasksLauncher() {
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
        <span className="sygtasks-launcher__tooltip" id={tooltipId} role="tooltip">
          SygTasks · Work Management
        </span>
      </NavLink>
    </div>
  )
}
