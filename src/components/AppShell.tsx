import { useEffect, useState } from 'react'
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { LogOut, Menu, ShieldCheck, UserCircle, X } from 'lucide-react'
import { navigationGroups } from '../app/navigation'
import {
  getSessionContext,
  SESSION_CONTEXT_REFRESH_EVENT,
  signOut,
  type SessionContext,
} from '../data/auth'
import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDate, formatOperationalTime } from '../lib/time'

export function AppShell() {
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [sessionContext, setSessionContext] = useState<SessionContext | null>(null)
  const [authLoading, setAuthLoading] = useState(isSupabaseConfigured)
  const [authMessage, setAuthMessage] = useState<string | null>(null)
  const location = useLocation()
  const navigate = useNavigate()

  const visibleNavigationGroups = navigationGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        if (!item.roles || !isSupabaseConfigured) return true
        return Boolean(sessionContext && item.roles.includes(sessionContext.role))
      }),
    }))
    .filter((group) => group.items.length > 0)

  const needsSecurityCheckpoint = Boolean(
    sessionContext?.mustChangePassword || (sessionContext?.mfaRequired && !sessionContext.hasMfa),
  )
  const isAccountSecurityRoute = location.pathname === '/account-security'
  const requestedNavigationItem = navigationGroups
    .flatMap((group) => group.items)
    .find((item) => item.path === location.pathname)
  const lacksRouteAccess = Boolean(
    sessionContext
      && requestedNavigationItem?.roles
      && !requestedNavigationItem.roles.includes(sessionContext.role),
  )

  useEffect(() => {
    setNavigationOpen(false)
  }, [location.pathname])

  useEffect(() => {
    let active = true

    if (!isSupabaseConfigured) {
      setAuthLoading(false)
      setSessionContext(null)
      return () => {
        active = false
      }
    }

    async function loadSessionContext(showLoading = true) {
      if (showLoading) setAuthLoading(true)
      setAuthMessage(null)

      const { data } = await getSupabaseClient().auth.getSession()
      if (!active) return

      if (!data.session) {
        setSessionContext(null)
        setAuthLoading(false)
        return
      }

      try {
        const context = await getSessionContext()
        if (active) setSessionContext(context)
      } catch {
        await getSupabaseClient().auth.signOut()
        if (active) {
          setSessionContext(null)
          setAuthMessage('Your account is not linked to an active SygShift employee record.')
        }
      } finally {
        if (active) setAuthLoading(false)
      }
    }

    void loadSessionContext()

    const {
      data: { subscription },
    } = getSupabaseClient().auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setSessionContext(null)
        setAuthLoading(false)
        return
      }

      void loadSessionContext()
    })

    const refreshSecurityContext = () => {
      void loadSessionContext(false)
    }
    window.addEventListener(SESSION_CONTEXT_REFRESH_EVENT, refreshSecurityContext)

    return () => {
      active = false
      subscription.unsubscribe()
      window.removeEventListener(SESSION_CONTEXT_REFRESH_EVENT, refreshSecurityContext)
    }
  }, [])

  async function handleSignOut() {
    setAuthMessage(null)

    try {
      await signOut()
      setSessionContext(null)
      navigate('/login', { replace: true })
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : 'Sign out failed.')
    }
  }

  if (authLoading) {
    return (
      <main className="security-page">
        <section className="security-card security-card--compact" role="status">
          <ShieldCheck aria-hidden="true" size={36} />
          <h1>Checking secure access…</h1>
          <p>SygShift is verifying your session before opening the workspace.</p>
        </section>
      </main>
    )
  }

  if (isSupabaseConfigured && !sessionContext) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  if (isSupabaseConfigured && needsSecurityCheckpoint && !isAccountSecurityRoute) {
    return <Navigate to="/account-security" replace state={{ from: location }} />
  }

  if (isSupabaseConfigured && lacksRouteAccess) {
    return <Navigate to="/" replace />
  }

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
          {visibleNavigationGroups.map((group) => (
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
            <strong>{isSupabaseConfigured ? 'Secure workspace' : 'Setup mode'}</strong>
            <span>
              {isSupabaseConfigured
                ? sessionContext
                  ? `${sessionContext.role} access verified`
                  : 'Sign in required'
                : 'Operational data is protected'}
            </span>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-date">
            <span>{formatOperationalDate()}</span>
            <strong>{formatOperationalTime()}</strong>
          </div>

          {sessionContext ? (
            <div className="user-menu">
              <UserCircle aria-hidden="true" size={22} />
              <div>
                <strong>{sessionContext.displayName}</strong>
                <span>@{sessionContext.username}</span>
              </div>
              <Link className="secondary-button secondary-button--small" to="/account-security">
                Security
              </Link>
              <button className="secondary-button secondary-button--small" onClick={handleSignOut} type="button">
                <LogOut aria-hidden="true" size={17} />
                Sign out
              </button>
            </div>
          ) : (
            <div className="topbar-label">
              <span aria-hidden="true" />
              Mountain Time
            </div>
          )}
        </header>

        {authMessage ? (
          <div className="shell-alert" role="alert">
            {authMessage}
          </div>
        ) : null}

        <main id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
