import { useEffect, useState } from 'react'
import { Menu, ShieldCheck, X } from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { navigationGroups } from '../app/navigation'
import { formatOperationalDate, formatOperationalTime } from '../lib/time'

export function AppShell() {
  const [navigationOpen, setNavigationOpen] = useState(false)
  const location = useLocation()

  useEffect(() => {
    setNavigationOpen(false)
  }, [location.pathname])

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <button
        aria-controls="primary-navigation"
        aria-expanded={navigationOpen}
        aria-label="Open navigation"
        className="mobile-menu-button"
        onClick={() => setNavigationOpen(true)}
        type="button"
      >
        <Menu aria-hidden="true" size={24} />
      </button>

      <div
        aria-hidden="true"
        className={navigationOpen ? 'navigation-scrim navigation-scrim--visible' : 'navigation-scrim'}
        onClick={() => setNavigationOpen(false)}
      />

      <aside
        className={navigationOpen ? 'sidebar sidebar--open' : 'sidebar'}
        id="primary-navigation"
      >
        <div className="sidebar-brand">
          <img src="/brand/sygshift-logo.png" alt="SygShift" />
          <button
            aria-label="Close navigation"
            className="sidebar-close"
            onClick={() => setNavigationOpen(false)}
            type="button"
          >
            <X aria-hidden="true" size={24} />
          </button>
        </div>

        <nav aria-label="Primary navigation" className="sidebar-navigation">
          {navigationGroups.map((group) => (
            <div className="navigation-group" key={group.label}>
              <p>{group.label}</p>
              {group.items.map((item) => {
                const Icon = item.icon
                return (
                  <NavLink
                    className={({ isActive }) =>
                      isActive ? 'navigation-link navigation-link--active' : 'navigation-link'
                    }
                    end={item.path === '/'}
                    key={item.path}
                    to={item.path}
                  >
                    <Icon aria-hidden="true" size={20} strokeWidth={1.8} />
                    <span>{item.label}</span>
                  </NavLink>
                )
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-status" role="status">
          <ShieldCheck aria-hidden="true" size={22} />
          <div>
            <strong>Setup mode</strong>
            <span>Operational data is protected</span>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-date">
            <span>{formatOperationalDate()}</span>
            <strong>{formatOperationalTime()}</strong>
          </div>
          <div className="topbar-label">
            <span aria-hidden="true" />
            Mountain Time
          </div>
        </header>

        <main id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
