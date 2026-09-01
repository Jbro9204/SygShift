import { useEffect, useMemo, useRef, useState } from 'react'
import { useIsMutating, useQuery } from '@tanstack/react-query'
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, BellRing, ChevronDown, ChevronsLeft, ChevronsRight, FileClock, Home, LogOut, Megaphone, Menu, Moon, ShieldCheck, Sun, X } from 'lucide-react'
import { homeNavigationItem, navigationGroups } from '../app/navigation'
import {
  INTERNAL_NAVIGATION_STORAGE_KEY,
  internalHref,
  parseInternalHistory,
  previousInternalLocation,
  recordInternalLocation,
  type InternalNavigationEntry,
} from '../app/internalNavigation'
import { canAccessRoute, hasAnyEffectivePermission } from '../app/accessPolicy'
import { getActiveAnnouncementBanners, type AnnouncementBanner } from '../data/announcements'
import { getTimekeepingOperationsWorkspace } from '../data/timeOperations'
import {
  getSessionContext,
  SESSION_CONTEXT_REFRESH_EVENT,
  signOut,
  type SessionContext,
} from '../data/auth'
import { shouldShowPayrollExportReminder } from '../lib/payrollReminder'
import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase'
import { lastCompletedPayrollWeek } from '../lib/time'
import { MaintenanceNotice, MaintenanceUnavailablePanel } from './MaintenanceNotice'
import { getMaintenanceStatus, maintenanceFeatureForPath } from '../data/maintenance'
import { deriveSystemServiceStatus, getSystemReadiness } from '../data/systemStatus'
import { getMyAccount, getMyAccountPhoto, type MyAccount } from '../data/myAccount'
import { applyTheme, getCurrentTheme, type SygShiftTheme } from '../lib/theme'
import { SystemStatusIndicator } from './SystemStatusIndicator'
import { OperationalTimeHeader } from './OperationalTimeHeader'

const INACTIVITY_WARNING_MS = 25 * 60 * 1000
const INACTIVITY_LOGOUT_MS = 30 * 60 * 1000
const WORKSPACE_ALERT_ROTATE_MS = 9_000
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'sygshift.sidebar.collapsed'
const SIDEBAR_GROUP_STORAGE_KEY = 'sygshift.sidebar.open-group'

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function accountInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || 'SY'
}

type WorkspaceAlertEntry = {
  id: string
  title: string
  message: string
  tone: AnnouncementBanner['tone']
  icon: 'announcement' | 'payroll' | 'attendance'
  ctaHref: string | null
  ctaLabel: string | null
}

function canOpenNavigationItem(
  item: (typeof navigationGroups)[number]['items'][number],
  sessionContext: SessionContext | null,
): boolean {
  if (!isSupabaseConfigured) return true
  if (!sessionContext) return false
  return canAccessRoute(item.path, sessionContext)
}

function routePathFromHref(href: string): string {
  return href.split(/[?#]/, 1)[0] || '/'
}

function WorkspaceAlertStrip({ entries }: { entries: WorkspaceAlertEntry[] }) {
  const [activeIndex, setActiveIndex] = useState(0)
  const entryKey = entries.map((entry) => entry.id).join('|')

  useEffect(() => {
    setActiveIndex(0)
  }, [entryKey])

  useEffect(() => {
    if (entries.length <= 1) return undefined
    const interval = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % entries.length)
    }, WORKSPACE_ALERT_ROTATE_MS)

    return () => window.clearInterval(interval)
  }, [entries.length, entryKey])

  if (entries.length === 0) return null

  const current = entries[activeIndex % entries.length]
  const Icon = current.icon === 'payroll' ? FileClock : current.icon === 'attendance' ? BellRing : Megaphone

  return (
    <section
      aria-label="Workspace alerts"
      aria-live="polite"
      className={`workspace-alert-strip workspace-alert-strip--${current.tone}`}
    >
      <div className="workspace-alert-strip__icon">
        <Icon aria-hidden="true" size={24} />
      </div>
      <div className="workspace-alert-strip__copy">
        <strong>{current.title}</strong>
        <div className="workspace-alert-strip__ticker" key={`${current.id}-${activeIndex}`}>
          <span>{current.message}</span>
        </div>
      </div>
      {entries.length > 1 ? (
        <div className="workspace-alert-strip__position" aria-label={`Alert ${activeIndex + 1} of ${entries.length}`}>
          {activeIndex + 1}/{entries.length}
        </div>
      ) : null}
      {current.ctaHref && current.ctaLabel ? (
        <Link className="workspace-alert-strip__action" to={current.ctaHref}>
          {current.ctaLabel}
        </Link>
      ) : null}
    </section>
  )
}

export function AppShell() {
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true')
  const [openNavigationGroup, setOpenNavigationGroup] = useState(() => window.localStorage.getItem(SIDEBAR_GROUP_STORAGE_KEY) ?? 'Operations')
  const [sessionContext, setSessionContext] = useState<SessionContext | null>(null)
  const [authLoading, setAuthLoading] = useState(isSupabaseConfigured)
  const [authMessage, setAuthMessage] = useState<string | null>(null)
  const [logoutWarningRemaining, setLogoutWarningRemaining] = useState<number | null>(null)
  const [accountPhotoUrl, setAccountPhotoUrl] = useState<string | null>(null)
  const [accountSummary, setAccountSummary] = useState<MyAccount | null>(null)
  const [accountRefreshVersion, setAccountRefreshVersion] = useState(0)
  const [theme, setTheme] = useState<SygShiftTheme>(getCurrentTheme)
  const activeMutationCount = useIsMutating()
  const internalHistoryRef = useRef<InternalNavigationEntry[]>(parseInternalHistory(window.sessionStorage.getItem(INTERNAL_NAVIGATION_STORAGE_KEY)))
  const previousScrollRef = useRef(0)
  const location = useLocation()
  const navigate = useNavigate()
  const payrollReminderWeek = lastCompletedPayrollWeek()
  const showPayrollReminder = shouldShowPayrollExportReminder(sessionContext)
  const canViewOperationalAlerts = canAccessRoute('/time/operations', sessionContext)
  const activeBannerQuery = useQuery({
    enabled: isSupabaseConfigured && Boolean(sessionContext),
    queryFn: getActiveAnnouncementBanners,
    queryKey: ['active-announcement-banners'],
    refetchInterval: 60_000,
  })
  const operationalAlertQuery = useQuery({
    enabled: isSupabaseConfigured && canViewOperationalAlerts,
    queryFn: () => {
      const today = new Date().toISOString().slice(0, 10)
      return getTimekeepingOperationsWorkspace(today, today)
    },
    queryKey: ['time-operations-shell-alerts'],
    refetchInterval: 30_000,
  })
  const maintenanceStatusQuery = useQuery({
    enabled: isSupabaseConfigured && Boolean(sessionContext),
    queryFn: getMaintenanceStatus,
    queryKey: ['maintenance-status'],
    refetchInterval: 30_000,
  })
  const readinessQuery = useQuery({
    enabled: isSupabaseConfigured && Boolean(sessionContext),
    queryFn: getSystemReadiness,
    queryKey: ['system-readiness'],
    refetchInterval: 30_000,
  })
  const workspaceAlerts = useMemo<WorkspaceAlertEntry[]>(() => {
    const announcementAlerts = (activeBannerQuery.data ?? [])
      .filter((banner) => banner.tone === 'urgent')
      .map((banner) => {
        const ctaAllowed = Boolean(
          banner.ctaHref
          && sessionContext
          && canAccessRoute(routePathFromHref(banner.ctaHref), sessionContext),
        )
        return {
          id: banner.id,
          title: banner.title,
          message: banner.message,
          tone: banner.tone,
          icon: 'announcement' as const,
          ctaHref: ctaAllowed ? banner.ctaHref : null,
          ctaLabel: ctaAllowed ? banner.ctaLabel : null,
        }
      })

    const attendanceAlerts = (operationalAlertQuery.data?.alerts ?? [])
      .filter((alert) => !alert.acknowledgedAt && (alert.priority === 'urgent' || alert.priority === 'high'))
      .flatMap((alert) => {
        const directPath = alert.directPath ?? '/time/operations'
        if (!sessionContext || !canAccessRoute(routePathFromHref(directPath), sessionContext)) return []
        return [{
          id: `attendance-${alert.id}`,
          title: alert.title,
          message: alert.summary,
          tone: 'urgent' as const,
          icon: 'attendance' as const,
          ctaHref: directPath,
          ctaLabel: 'Review alert',
        }]
      })
    const liveAlerts = [...attendanceAlerts, ...announcementAlerts]

    if (!showPayrollReminder) return liveAlerts

    return [
      ...liveAlerts,
      {
        id: `payroll-export-reminder-${payrollReminderWeek.fromLabel}-${payrollReminderWeek.throughLabel}`,
        title: 'Payroll export reminder',
        message: `Review, lock, and export time for ${payrollReminderWeek.fromLabel} through ${payrollReminderWeek.throughLabel} so it can be sent to HR/Finance.`,
        tone: 'warning',
        icon: 'payroll',
        ctaHref: '/time',
        ctaLabel: 'Open Time & Attendance',
      },
    ]
  }, [activeBannerQuery.data, operationalAlertQuery.data?.alerts, payrollReminderWeek.fromLabel, payrollReminderWeek.throughLabel, sessionContext, showPayrollReminder])

  const visibleNavigationGroups = navigationGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        return canOpenNavigationItem(item, sessionContext)
      }),
    }))
    .filter((group) => group.items.length > 0)
  const homeVisible = canOpenNavigationItem(homeNavigationItem, sessionContext)
  const activeNavigationGroup = visibleNavigationGroups.find((group) => group.items.some((item) => (
    item.path === '/' ? location.pathname === '/' : location.pathname === item.path || location.pathname.startsWith(`${item.path}/`)
  )))?.label ?? null

  const activeMaintenance = maintenanceStatusQuery.data?.active[0] ?? null
  const upcomingMaintenance = maintenanceStatusQuery.data?.upcoming[0] ?? null
  const completedMaintenance = maintenanceStatusQuery.data?.recentlyCompleted[0] ?? null
  const systemServiceStatus = deriveSystemServiceStatus({
    configured: isSupabaseConfigured,
    maintenanceAccessModes: (maintenanceStatusQuery.data?.active ?? []).map((window) => window.accessMode),
    maintenanceError: maintenanceStatusQuery.isError,
    maintenancePending: maintenanceStatusQuery.isPending,
    readiness: readinessQuery.data,
    readinessError: readinessQuery.isError,
    readinessPending: readinessQuery.isPending,
  })
  const canOpenSystemOperations = Boolean(
    sessionContext && hasAnyEffectivePermission(sessionContext, ['admin.maintenance.manage']),
  )
  const routeMaintenanceFeature = maintenanceFeatureForPath(location.pathname)
  const unavailableRouteWindow = (maintenanceStatusQuery.data?.active ?? []).find((window) => {
    if (window.accessMode !== 'unavailable') return false
    if (location.pathname === '/time') return window.featureCodes.includes('time_clock')
    return routeMaintenanceFeature ? window.featureCodes.includes(routeMaintenanceFeature) : false
  }) ?? null

  const needsSecurityCheckpoint = Boolean(
    sessionContext?.mustChangePassword || (sessionContext?.mfaRequired && !sessionContext.hasMfa),
  )
  const isAccountSecurityRoute = location.pathname === '/account-security'
  const lacksRouteAccess = Boolean(
    sessionContext
      && !canAccessRoute(location.pathname, sessionContext),
  )

  useEffect(() => {
    setNavigationOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!activeNavigationGroup) return
    setOpenNavigationGroup(activeNavigationGroup)
    window.localStorage.setItem(SIDEBAR_GROUP_STORAGE_KEY, activeNavigationGroup)
  }, [activeNavigationGroup])

  useEffect(() => {
    const href = internalHref(location.pathname, location.search, location.hash)
    internalHistoryRef.current = recordInternalLocation(internalHistoryRef.current, href, previousScrollRef.current)
    window.sessionStorage.setItem(INTERNAL_NAVIGATION_STORAGE_KEY, JSON.stringify(internalHistoryRef.current))
    previousScrollRef.current = window.scrollY
  }, [location.hash, location.pathname, location.search])

  useEffect(() => {
    const captureScroll = () => { previousScrollRef.current = window.scrollY }
    window.addEventListener('scroll', captureScroll, { passive: true })
    return () => window.removeEventListener('scroll', captureScroll)
  }, [])

  useEffect(() => {
    applyTheme(theme, false)
  }, [theme])

  function handleInternalBack() {
    const currentHref = internalHref(location.pathname, location.search, location.hash)
    const result = previousInternalLocation(internalHistoryRef.current, currentHref)
    internalHistoryRef.current = result.entries
    window.sessionStorage.setItem(INTERNAL_NAVIGATION_STORAGE_KEY, JSON.stringify(result.entries))
    if (!result.target) {
      navigate('/')
      return
    }

    navigate(result.target.href)
    window.setTimeout(() => window.scrollTo({ top: result.target?.scrollY ?? 0 }), 0)
  }

  function toggleSidebarCollapsed() {
    setSidebarCollapsed((current) => {
      const next = !current
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next))
      return next
    })
  }

  function toggleNavigationGroup(label: string) {
    setOpenNavigationGroup((current) => {
      const next = current === label ? '' : label
      window.localStorage.setItem(SIDEBAR_GROUP_STORAGE_KEY, next)
      return next
    })
  }

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
        await signOut()
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

      // Token refreshes commonly occur when a user returns to a background tab.
      // Refresh permissions without replacing and unmounting the active workspace.
      void loadSessionContext(false)
    })

    const refreshSecurityContext = () => {
      setAccountRefreshVersion((current) => current + 1)
      void loadSessionContext(false)
    }
    window.addEventListener(SESSION_CONTEXT_REFRESH_EVENT, refreshSecurityContext)

    return () => {
      active = false
      subscription.unsubscribe()
      window.removeEventListener(SESSION_CONTEXT_REFRESH_EVENT, refreshSecurityContext)
    }
  }, [])

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null

    setAccountPhotoUrl(null)
    setAccountSummary(null)
    if (!sessionContext?.employeeId) return () => { active = false }

    void (async () => {
      try {
        const account = await getMyAccount()
        if (active) setAccountSummary(account)
        if (!account.profile.hasPhoto) return
        objectUrl = URL.createObjectURL(await getMyAccountPhoto())
        if (active) setAccountPhotoUrl(objectUrl)
      } catch {
        if (active) setAccountPhotoUrl(null)
      }
    })()

    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [accountRefreshVersion, sessionContext?.employeeId])

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
    <div className={sidebarCollapsed ? 'app-shell app-shell--sidebar-collapsed' : 'app-shell'}>
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
        className={`${navigationOpen ? 'sidebar sidebar--open' : 'sidebar'}${sidebarCollapsed ? ' sidebar--collapsed' : ''}`}
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
          <button
            aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            className="sidebar-collapse"
            onClick={toggleSidebarCollapsed}
            title={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            type="button"
          >
            {sidebarCollapsed ? <ChevronsRight aria-hidden="true" size={18} /> : <ChevronsLeft aria-hidden="true" size={18} />}
          </button>
        </div>

        <nav aria-label="Primary navigation" className="sidebar-navigation">
          <div className="sidebar-primary-actions">
            <button className="navigation-link navigation-link--button" onClick={handleInternalBack} title="Back" type="button">
              <ArrowLeft aria-hidden="true" size={20} strokeWidth={1.8} />
              <span>Back</span>
            </button>
            {homeVisible ? (
              <NavLink
                className={({ isActive }) => isActive ? 'navigation-link navigation-link--active' : 'navigation-link'}
                end
                title="Home"
                to="/"
              >
                <Home aria-hidden="true" size={20} strokeWidth={1.8} />
                <span>Home</span>
              </NavLink>
            ) : null}
          </div>
          {visibleNavigationGroups.map((group) => (
            <div className="navigation-group" key={group.label}>
              <button
                aria-expanded={openNavigationGroup === group.label}
                className="navigation-group__toggle"
                onClick={() => toggleNavigationGroup(group.label)}
                title={group.label}
                type="button"
              >
                <span>{group.label}</span>
                <ChevronDown aria-hidden="true" size={17} />
              </button>
              <div className={openNavigationGroup === group.label ? 'navigation-group__items navigation-group__items--open' : 'navigation-group__items'}>
              {group.items.map((item) => {
                const Icon = item.icon
                return (
                  <NavLink
                    className={({ isActive }) =>
                      isActive ? 'navigation-link navigation-link--active' : 'navigation-link'
                    }
                    end={item.path === '/'}
                    key={item.path}
                    title={item.label}
                    to={item.path}
                  >
                    <Icon aria-hidden="true" size={20} strokeWidth={1.8} />
                    <span>{item.label}</span>
                  </NavLink>
                )
              })}
              </div>
            </div>
          ))}
        </nav>

        <SystemStatusIndicator canOpenOperations={canOpenSystemOperations} status={systemServiceStatus} />
      </aside>

      <div className="workspace">
        <OperationalTimeHeader
          accountControls={sessionContext ? (
            <div className="user-menu">
              <div aria-label="Appearance" className="theme-switcher" role="group">
                <button
                  aria-label="Use light mode"
                  aria-pressed={theme === 'light'}
                  className="theme-switcher__button"
                  onClick={() => {
                    applyTheme('light')
                    setTheme('light')
                  }}
                  title="Light mode"
                  type="button"
                >
                  <span><Sun aria-hidden="true" size={17} /></span>
                </button>
                <button
                  aria-label="Use dark mode"
                  aria-pressed={theme === 'dark'}
                  className="theme-switcher__button"
                  onClick={() => {
                    applyTheme('dark')
                    setTheme('dark')
                  }}
                  title="Dark mode"
                  type="button"
                >
                  <span><Moon aria-hidden="true" size={17} /></span>
                </button>
              </div>
              <span aria-hidden="true" className="user-menu__divider" />
              <Link
                aria-label={`Open My Account for ${accountSummary?.employment.legalName ?? sessionContext.displayName}`}
                className="user-profile-control"
                to="/account"
              >
                <span className="user-menu__avatar">
                  {accountPhotoUrl ? (
                    <img
                      alt={`Profile photo for ${accountSummary?.employment.legalName ?? sessionContext.displayName}`}
                      src={accountPhotoUrl}
                    />
                  ) : (
                    <span aria-hidden="true">{accountInitials(accountSummary?.employment.legalName ?? sessionContext.displayName)}</span>
                  )}
                </span>
                <span className="user-profile-control__copy">
                  <strong>{accountSummary?.employment.legalName ?? sessionContext.displayName}</strong>
                  <span>{titleCase(accountSummary?.employment.primaryRole ?? '') || 'Employee'} · @{sessionContext.username}</span>
                </span>
              </Link>
              <button
                aria-label="Sign Out"
                className="user-menu__icon-button"
                onClick={handleSignOut}
                title="Sign Out"
                type="button"
              >
                <span><LogOut aria-hidden="true" size={17} /></span>
              </button>
            </div>
          ) : (
            <div className="topbar-label">
              <span aria-hidden="true" />
              Mountain Time
            </div>
          )}
          serverTimestamp={maintenanceStatusQuery.data?.serverTime}
        />

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

        <MaintenanceNotice active={activeMaintenance} completed={completedMaintenance} upcoming={upcomingMaintenance} />

        <WorkspaceAlertStrip entries={workspaceAlerts} />

        <main id="main-content" tabIndex={-1}>
          {unavailableRouteWindow ? <MaintenanceUnavailablePanel window={unavailableRouteWindow} /> : <Outlet />}
        </main>
      </div>
    </div>
  )
}
