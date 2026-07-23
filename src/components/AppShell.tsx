import { useEffect, useState } from 'react'
import { useIsMutating } from '@tanstack/react-query'
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

const INACTIVITY_WARNING_MS = 8 * 60 * 1000
const INACTIVITY_LOGOUT_MS = 10 * 60 * 1000

function displayRole(role: SessionContext['role']): string {
  if (role === 'admin') return 'Admin'
  if (role === 'dispatcher') return 'Dispatcher'
  if (role === 'scheduler') return 'Scheduler'
  if (role === 'supervisor') return 'Supervisor'
  return 'Guard'
}

export function AppShell() {
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [sessionContext, setSessionContext] = useState<SessionContext | null>(null)
  const [authLoading, setAuthLoading] = useState(isSupabaseConfigured)
  const [authMessage, setAuthMessage] = useState<string | null>(null)
  const [logoutWarningRemaining, setLogoutWarningRemaining] = useState<number | null>(null)
  const activeMutationCount = useIsMutating()
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
    document.documentElement.toggleAttribute('data-sygshift-busy', activeMutationCount > 0)

    return () => {
      document.documentElement.removeAttribute('data-sygshift-busy')
    }
  }, [activeMutationCount])

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

  useEffect(() => {
    if (!isSupabaseConfigured || !sessionContext) {
      setLogoutWarningRemaining(null)
      return
    }

    let warningTimer: number | undefined
    let logoutTimer: number | undefined
    let countdownTimer: number | undefined
    let logoutAt = Date.now() + INACTIVITY_LOGOUT_MS

    const clearTimers = () => {
      if (warningTimer) window.clearTimeout(warningTimer)
      if (logoutTimer) window.clearTimeout(logoutTimer)
      if (countdownTimer) window.clearInterval(countdownTimer)
    }

    const autoSignOut = async () => {
      clearTimers()
      setLogoutWarningRemaining(null)
      try {
        await signOut()
      } finally {
        setSessionContext(null)
        navigate('/login', { replace: true, state: { reason: 'inactive' } })
      }
    }

    const startTimers = () => {
      clearTimers()
      setLogoutWarningRemaining(null)
      logoutAt = Date.now() + INACTIVITY_LOGOUT_MS
      warningTimer = window.setTimeout(() => {
        setLogoutWarningRemaining(Math.max(0, Math.ceil((logoutAt - Date.now()) / 1000)))
        countdownTimer = window.setInterval(() => {
          setLogoutWarningRemaining(Math.max(0, Math.ceil((logoutAt - Date.now()) / 1000)))
        }, 1000)
      }, INACTIVITY_WARNING_MS)
      logoutTimer = window.setTimeout(() => {
        void autoSignOut()
      }, INACTIVITY_LOGOUT_MS)
    }

    const handleActivity = () => {
      if (document.visibilityState === 'hidden') return
      startTimers()
    }

    const events: Array<keyof WindowEventMap> = ['keydown', 'mousedown', 'mousemove', 'scroll', 'touchstart', 'wheel']
    for (const event of events) window.addEventListener(event, handleActivity, { passive: true })
    document.addEventListener('visibilitychange', handleActivity)
    startTimers()

    return () => {
      clearTimers()
      for (const event of events) window.removeEventListener(event, handleActivity)
      document.removeEventListener('visibilitychange', handleActivity)
    }
  }, [navigate, sessionContext])

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
                  ? `${displayRole(sessionContext.role)} access verified`
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

        {logoutWarningRemaining !== null ? (
          <div className="shell-alert shell-alert--warning" role="alert">
            You will be signed out for inactivity in {Math.ceil(logoutWarningRemaining / 60)} minute
            {Math.ceil(logoutWarningRemaining / 60) === 1 ? '' : 's'}. Move, tap, or type to stay signed in.
          </div>
        ) : null}

        <main id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
