import { NavLink } from 'react-router-dom'
import '../styles/sygtasks-launcher.css'

const tooltipId = 'sygtasks-launcher-tooltip'

export function SygTasksLauncher() {
  return (
    <div className="sygtasks-launcher-shell">
      <NavLink
        aria-describedby={tooltipId}
        aria-label="Open SygTasks work management"
        className={({ isActive }) => isActive
          ? 'sygtasks-launcher sygtasks-launcher--active'
          : 'sygtasks-launcher'}
        to="/tasks"
      >
        <span aria-hidden="true" className="sygtasks-launcher__emblem">
          <img alt="" src="/branding/sygtasks-emblem.png" />
        </span>
        <span aria-hidden="true" className="sygtasks-launcher__brand">
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
