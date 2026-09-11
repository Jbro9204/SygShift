import { useEffect, useMemo, useRef, useState } from 'react'
import { useIsMutating, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, BellRing, ChevronDown, ChevronsLeft, ChevronsRight, FileClock, Home, LogOut, Megaphone, Menu, Moon, ShieldAlert, ShieldCheck, Sun, X } from 'lucide-react'
import { homeNavigationItem, navigationGroups } from '../app/navigation'
import {
  INTERNAL_NAVIGATION_STORAGE_KEY,
  internalHref,
  parseInternalHistory,
  previousInternalLocation,
  recordInternalLocation,
  type InternalNavigationEntry,
} from '../app/internalNavigation'
import { canAccessRoute, canLaunchSygilantPlatform, hasAnyEffectivePermission, resolveAuthorizedLandingRoute } from '../app/accessPolicy'
import { getActiveAnnouncementBanners, type AnnouncementBanner } from '../data/announcements'
import { getTimekeepingOperationsWorkspace } from '../data/timeOperations'
import { getRequiredActionCheckpoint } from '../data/actionCenter'
import {
  authSessionIdFromAccessToken,
  getSessionContext,
  recordCompletedSignInWithRetry,
  SESSION_CONTEXT_REFRESH_EVENT,
  signOut,
  type SessionContext,
} from '../data/auth'
import { shouldShowPayrollExportReminder } from '../lib/payrollReminder'
import {
  activateSharedIdentitySupabaseSession,
  deactivateSharedIdentitySupabaseSession,
  getSupabaseClient,
  isSupabaseConfigured,
} from '../lib/supabase'
import { lastCompletedPayrollWeek } from '../lib/time'
import { MaintenanceNotice, MaintenanceUnavailablePanel } from './MaintenanceNotice'
import { getMaintenanceStatus, maintenanceFeatureForPath } from '../data/maintenance'
import { deriveSystemServiceStatus, getSystemReadiness } from '../data/systemStatus'
import { getMyAccount, getMyAccountPhoto, type MyAccount } from '../data/myAccount'
import { applyTheme, getCurrentTheme, type SygShiftTheme } from '../lib/theme'
import { SystemStatusIndicator } from './SystemStatusIndicator'
import { SupportHelpButton } from './SupportHelpButton'
import { SygSphereLauncher } from './SygSphereLauncher'
import { SygilantLauncher } from './SygilantLauncher'
import { SygTasksLauncher } from './SygTasksLauncher'
import { SygTasksAlarmHost } from './SygTasksAlarmHost'
import { OperationalTimeHeader } from './OperationalTimeHeader'
import { HeaderNotificationButton } from './HeaderNotificationButton'
import { LiveNotifications } from './LiveNotifications'
import { RequiredActionsCheckpointNotice } from './RequiredActionsCheckpointNotice'
import { clearPushSession } from '../data/pushNotifications'
import { completedSignInRecordKind, isSygSpherePath, requiresSecurityCheckpoint, sharedIdentityScopeAllowsPath } from '../lib/securityCheckpoint'
import {
  publishSharedIdentityBrowserEvent,
  subscribeToSharedIdentityBrowserEvents,
} from '../lib/sharedIdentityBrowserSync'
import {
  clearSharedIdentitySession,
  clearSharedIdentityServerSession,
  getSharedIdentitySessionScope,
  hydrateSharedIdentitySession,
  sharedIdentityRefreshDelayMs,
} from '../lib/sharedIdentitySession'

const INACTIVITY_WARNING_MS = 55 * 60 * 1000
const INACTIVITY_LOGOUT_MS = 60 * 60 * 1000
const SESSION_ACTIVITY_STORAGE_PREFIX = 'sygshift.session.activity.v1'
const SESSION_ACTIVITY_THROTTLE_MS = 5_000
const WORKSPACE_ALERT_ROTATE_MS = 9_000
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'sygshift.sidebar.collapsed'
const SIDEBAR_GROUP_STORAGE_KEY = 'sygshift.sidebar.open-group'
const COMPACT_NAVIGATION_QUERY = '(max-width: 1280px), (max-width: 1366px) and (max-height: 800px)'

function compactNavigationMatches(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(COMPACT_NAVIGATION_QUERY).matches
}

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
  return canAccessRoute(routePathFromHref(item.path), sessionContext)
}

function routePathFromHref(href: string): string {
  return href.split(/[?#]/, 1)[0] || '/'
}

function checkpointAllowsLocation(pathname: string, search: string): boolean {
  if (pathname === '/' || pathname === '/actions' || pathname === '/my-documents' || pathname === '/account-security') return true
  return pathname === '/time/my-time' && new URLSearchParams(search).get('report') === 'call-off'
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
  const queryClient = useQueryClient()
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true')
  const [compactNavigation, setCompactNavigation] = useState(compactNavigationMatches)
  const [openNavigationGroup, setOpenNavigationGroup] = useState(() => window.localStorage.getItem(SIDEBAR_GROUP_STORAGE_KEY) ?? 'Operations')
  const [sessionContext, setSessionContext] = useState<SessionContext | null>(null)
  const [authSessionId, setAuthSessionId] = useState<string | null>(null)
  const [authLoading, setAuthLoading] = useState(isSupabaseConfigured)
  const [authMessage, setAuthMessage] = useState<string | null>(null)
  const [logoutWarningRemaining, setLogoutWarningRemaining] = useState<number | null>(null)
  const [accountPhotoUrl, setAccountPhotoUrl] = useState<string | null>(null)
  const [accountSummary, setAccountSummary] = useState<MyAccount | null>(null)
  const [accountRefreshVersion, setAccountRefreshVersion] = useState(0)
  const [theme, setTheme] = useState<SygShiftTheme>(getCurrentTheme)
  const activeMutationCount = useIsMutating()
  const location = useLocation()
  const internalHistoryRef = useRef<InternalNavigationEntry[]>(parseInternalHistory(window.sessionStorage.getItem(INTERNAL_NAVIGATION_STORAGE_KEY)))
  const previousScrollRef = useRef(0)
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
  const requiredActionQuery = useQuery({
    enabled: isSupabaseConfigured && Boolean(sessionContext),
    queryFn: getRequiredActionCheckpoint,
    queryKey: ['required-action-checkpoint', sessionContext?.employeeId],
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  })
  const requiredActionCheckpoint = requiredActionQuery.data ?? null
  const requiredActionCheckpointActive = Boolean(requiredActionCheckpoint?.blocking || requiredActionQuery.isError)
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
        if (!canOpenNavigationItem(item, sessionContext)) return false
        if (!requiredActionCheckpointActive) return true
        return ['/actions', '/my-documents'].includes(routePathFromHref(item.path))
      }),
    }))
    .filter((group) => group.items.length > 0)
  const homeVisible = canOpenNavigationItem(homeNavigationItem, sessionContext)
  const activeNavigationGroup = visibleNavigationGroups.find((group) => group.items.some((item) => (
    routePathFromHref(item.path) === '/'
      ? location.pathname === '/'
      : location.pathname === routePathFromHref(item.path) || location.pathname.startsWith(`${routePathFromHref(item.path)}/`)
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
  const canOpenSygilant = canLaunchSygilantPlatform(sessionContext)
  const routeMaintenanceFeature = maintenanceFeatureForPath(location.pathname)
  const unavailableRouteWindow = (maintenanceStatusQuery.data?.active ?? []).find((window) => {
    if (window.accessMode !== 'unavailable') return false
    if (location.pathname === '/time') return window.featureCodes.includes('time_clock')
    return routeMaintenanceFeature ? window.featureCodes.includes(routeMaintenanceFeature) : false
  }) ?? null

  const sharedIdentityScope = getSharedIdentitySessionScope()
  const sharedIdentityScopePermitsRoute = sharedIdentityScopeAllowsPath(location.pathname, sharedIdentityScope)
  const needsSecurityCheckpoint = requiresSecurityCheckpoint(
    sessionContext,
    location.pathname,
    sharedIdentityScope,
  )
  const isAccountSecurityRoute = location.pathname === '/account-security'
  const lacksRouteAccess = Boolean(
    sessionContext
      && !canAccessRoute(location.pathname, sessionContext),
  )
  const passwordRecoverySession = location.pathname === '/account-security'
    && new URLSearchParams(location.search).get('mode') === 'password-recovery'
  const completedSignInKind = passwordRecoverySession
    ? null
    : completedSignInRecordKind(sessionContext, location.pathname, sharedIdentityScope)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mediaQuery = window.matchMedia(COMPACT_NAVIGATION_QUERY)
    const handleChange = (event: MediaQueryListEvent) => {
      setCompactNavigation(event.matches)
      if (!event.matches) setNavigationOpen(false)
    }
    setCompactNavigation(mediaQuery.matches)
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    if (!isSupabaseConfigured || !completedSignInKind || !authSessionId) return
    const abortController = new AbortController()
    void recordCompletedSignInWithRetry(completedSignInKind, {
      signal: abortController.signal,
    }).catch((error: unknown) => {
      if (!abortController.signal.aborted) {
        console.error('Completed sign-in activity could not be recorded after retry.', error)
      }
    })
    return () => abortController.abort()
  }, [authSessionId, completedSignInKind, sessionContext?.employeeId])

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
    if (sessionContext) document.documentElement.setAttribute('data-sygshift-cursors', 'active')
    else document.documentElement.removeAttribute('data-sygshift-cursors')

    return () => {
      document.documentElement.removeAttribute('data-sygshift-cursors')
    }
  }, [sessionContext])

  useEffect(() => {
    let active = true
    let authSubscription: { unsubscribe: () => void } | null = null
    let sharedIdentityRefreshTimer: number | undefined
    let unsubscribeSharedBrowserEvents: () => void = () => undefined

    if (!isSupabaseConfigured) {
      setAuthLoading(false)
      setSessionContext(null)
      return () => {
        active = false
      }
    }

    function clearSharedIdentityRefreshTimer() {
      if (sharedIdentityRefreshTimer) window.clearTimeout(sharedIdentityRefreshTimer)
      sharedIdentityRefreshTimer = undefined
    }

    function tearDownSharedIdentitySession(message: string | null, notifyOtherTabs: boolean) {
      clearSharedIdentityRefreshTimer()
      deactivateSharedIdentitySupabaseSession()
      clearSharedIdentitySession()
      setAuthSessionId(null)
      setSessionContext(null)
      setAuthMessage(message)
      setAuthLoading(false)
      if (notifyOtherTabs) publishSharedIdentityBrowserEvent('cleared')
    }

    function scheduleSharedIdentityRestore(accessToken: string) {
      clearSharedIdentityRefreshTimer()
      sharedIdentityRefreshTimer = window.setTimeout(() => {
        void loadSessionContext(false, true, true)
      }, sharedIdentityRefreshDelayMs(accessToken))
    }

    async function restoreSharedIdentitySession(notifyOtherTabs: boolean): Promise<boolean> {
      const previouslyShared = getSharedIdentitySessionScope() !== null
      let restored
      try {
        restored = await hydrateSharedIdentitySession()
      } catch {
        if (previouslyShared) {
          tearDownSharedIdentitySession(
            'Your secure shared session could not be renewed. Open SygShift from Sygilant again or sign in directly.',
            notifyOtherTabs,
          )
        }
        return false
      }
      if (!active) return false
      if (!restored) {
        if (previouslyShared) tearDownSharedIdentitySession(null, notifyOtherTabs)
        return false
      }
      if (restored.scope === 'sygsphere' && !isSygSpherePath(window.location.pathname)) {
        await clearSharedIdentityServerSession(restored.accessToken)
        tearDownSharedIdentitySession(null, notifyOtherTabs)
        return false
      }
      try {
        await activateSharedIdentitySupabaseSession(restored.accessToken, restored.refreshToken)
      } catch {
        await clearSharedIdentityServerSession(restored.accessToken)
        tearDownSharedIdentitySession(
          'The shared SygShift session could not be established. Sign in directly or retry from Sygilant.',
          notifyOtherTabs,
        )
        return false
      }
      scheduleSharedIdentityRestore(restored.accessToken)
      if (notifyOtherTabs) publishSharedIdentityBrowserEvent('updated')
      return true
    }

    async function loadSessionContext(
      showLoading = true,
      restoreSharedSession = false,
      notifyOtherTabs = false,
    ) {
      if (showLoading) setAuthLoading(true)
      setAuthMessage(null)

      if (restoreSharedSession) {
        await restoreSharedIdentitySession(notifyOtherTabs)
      }
      const { data } = await getSupabaseClient().auth.getSession()
      if (!active) return
      setAuthSessionId(data.session ? authSessionIdFromAccessToken(data.session.access_token) : null)

      if (!data.session) {
        deactivateSharedIdentitySupabaseSession()
        clearSharedIdentitySession()
        setSessionContext(null)
        setAuthLoading(false)
        return
      }

      try {
        const context = await getSessionContext()
        if (active) setSessionContext(context)
      } catch {
        const wasShared = getSharedIdentitySessionScope() !== null
        if (wasShared) {
          await clearSharedIdentityServerSession(data.session.access_token)
          tearDownSharedIdentitySession(null, true)
        } else {
          await signOut()
        }
        if (active) {
          setSessionContext(null)
          setAuthMessage('Your account is not linked to an active SygShift employee record.')
        }
      } finally {
        if (active) setAuthLoading(false)
      }
    }

    void (async () => {
      await loadSessionContext(true, true)
      if (!active) return
      const { data: { subscription } } = getSupabaseClient().auth.onAuthStateChange((_event, session) => {
        if (getSharedIdentitySessionScope()) return
        setAuthSessionId(session ? authSessionIdFromAccessToken(session.access_token) : null)
        if (!session) {
          for (const key of ['support', 'my-notifications', 'notification-device-session', 'notification-device-push', 'sygsphere']) {
            queryClient.removeQueries({ queryKey: [key] })
          }
          void clearPushSession()
          clearSharedIdentitySession()
          deactivateSharedIdentitySupabaseSession()
          setSessionContext(null)
          setAuthLoading(false)
          return
        }

        // Token refreshes commonly occur when a user returns to a background tab.
        // Refresh permissions without replacing and unmounting the active workspace.
        void loadSessionContext(false)
      })
      authSubscription = subscription
    })()

    unsubscribeSharedBrowserEvents = subscribeToSharedIdentityBrowserEvents((action) => {
      if (action === 'cleared') {
        if (getSharedIdentitySessionScope()) tearDownSharedIdentitySession(null, false)
        return
      }
      void loadSessionContext(false, true)
    })

    const restoreVisibleSharedSession = () => {
      if (document.visibilityState === 'visible' && getSharedIdentitySessionScope()) {
        void loadSessionContext(false, true, true)
      }
    }
    document.addEventListener('visibilitychange', restoreVisibleSharedSession)

    const refreshSecurityContext = () => {
      setAccountRefreshVersion((current) => current + 1)
      void loadSessionContext(false)
    }
    window.addEventListener(SESSION_CONTEXT_REFRESH_EVENT, refreshSecurityContext)

    return () => {
      active = false
      clearSharedIdentityRefreshTimer()
      authSubscription?.unsubscribe()
      unsubscribeSharedBrowserEvents()
      document.removeEventListener('visibilitychange', restoreVisibleSharedSession)
      window.removeEventListener(SESSION_CONTEXT_REFRESH_EVENT, refreshSecurityContext)
    }
  }, [queryClient])

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
    let lastLocalActivityAt = 0
    let lastSharedActivityWriteAt = 0
    const sharedActivityKey = `${SESSION_ACTIVITY_STORAGE_PREFIX}:${sessionContext.employeeId}`

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

    const startTimers = (activityAt: number) => {
      clearTimers()
      setLogoutWarningRemaining(null)
      const now = Date.now()
      logoutAt = activityAt + INACTIVITY_LOGOUT_MS
      const warningDelay = Math.max(0, activityAt + INACTIVITY_WARNING_MS - now)
      const logoutDelay = Math.max(0, logoutAt - now)
      const showWarning = () => {
        setLogoutWarningRemaining(Math.max(0, Math.ceil((logoutAt - Date.now()) / 1000)))
        countdownTimer = window.setInterval(() => {
          setLogoutWarningRemaining(Math.max(0, Math.ceil((logoutAt - Date.now()) / 1000)))
        }, 1000)
      }
      if (warningDelay === 0) showWarning()
      else warningTimer = window.setTimeout(showWarning, warningDelay)
      logoutTimer = window.setTimeout(() => {
        void autoSignOut()
      }, logoutDelay)
    }

    const handleActivity = () => {
      if (document.visibilityState === 'hidden') return
      const now = Date.now()
      if (now - lastLocalActivityAt < 1_000) return
      lastLocalActivityAt = now
      startTimers(now)
      if (now - lastSharedActivityWriteAt < SESSION_ACTIVITY_THROTTLE_MS) return
      lastSharedActivityWriteAt = now
      try { window.localStorage.setItem(sharedActivityKey, String(now)) } catch { /* This tab still retains its own timer. */ }
    }

    const handleSharedActivity = (event: StorageEvent) => {
      if (event.key !== sharedActivityKey || !event.newValue) return
      const activityAt = Number(event.newValue)
      const now = Date.now()
      if (!Number.isFinite(activityAt) || activityAt <= 0 || activityAt > now + 5_000) return
      startTimers(Math.min(activityAt, now))
    }

    const events: Array<keyof WindowEventMap> = ['keydown', 'mousedown', 'mousemove', 'scroll', 'touchstart', 'wheel']
    for (const event of events) window.addEventListener(event, handleActivity, { passive: true })
    document.addEventListener('visibilitychange', handleActivity)
    window.addEventListener('storage', handleSharedActivity)
    handleActivity()

    return () => {
      clearTimers()
      for (const event of events) window.removeEventListener(event, handleActivity)
      document.removeEventListener('visibilitychange', handleActivity)
      window.removeEventListener('storage', handleSharedActivity)
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

  if (isSupabaseConfigured && !sharedIdentityScopePermitsRoute) {
    return <Navigate to="/sygsphere" replace />
  }

  if (isSupabaseConfigured && needsSecurityCheckpoint && !isAccountSecurityRoute) {
    return <Navigate to="/account-security" replace state={{ from: location }} />
  }

  if (isSupabaseConfigured && sessionContext && !needsSecurityCheckpoint && requiredActionQuery.isPending) {
    return (
      <main className="security-page">
        <section className="security-card security-card--compact" role="status">
          <ShieldCheck aria-hidden="true" size={36} />
          <h1>Checking required actions…</h1>
          <p>SygShift is checking your current schedules, notices, training, and documents before opening the workspace.</p>
        </section>
      </main>
    )
  }

  if (isSupabaseConfigured && sessionContext && !needsSecurityCheckpoint && requiredActionQuery.isError && !checkpointAllowsLocation(location.pathname, location.search)) {
    return (
      <main className="security-page">
        <section className="security-card" role="alert">
          <ShieldAlert aria-hidden="true" size={36} />
          <h1>Required actions could not be verified</h1>
          <p>The ordinary workspace is paused until SygShift can safely check your queue. Urgent time and call-off access remains available.</p>
          <div className="security-card__actions">
            <Link className="secondary-button" to="/">Clock in or out</Link>
            <Link className="secondary-button" to="/time/my-time?report=call-off">Report sick / call-off</Link>
            <button className="primary-action" onClick={() => void requiredActionQuery.refetch()} type="button">Try again</button>
          </div>
        </section>
      </main>
    )
  }

  if (isSupabaseConfigured && requiredActionCheckpointActive && !checkpointAllowsLocation(location.pathname, location.search)) {
    return <Navigate to="/actions?checkpoint=required" replace state={{ from: location }} />
  }

  if (isSupabaseConfigured && lacksRouteAccess) {
    return <Navigate to={resolveAuthorizedLandingRoute(sessionContext)} replace />
  }

  return (
    <div className={`app-shell${sidebarCollapsed && !compactNavigation ? ' app-shell--sidebar-collapsed' : ''}${compactNavigation ? ' app-shell--compact-navigation' : ''}${isSygSpherePath(location.pathname) ? ' app-shell--sygsphere' : ''}${requiredActionCheckpointActive ? ' app-shell--required-actions' : ''}`}>
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
        className={`${navigationOpen ? 'sidebar sidebar--open' : 'sidebar'}${sidebarCollapsed && !compactNavigation ? ' sidebar--collapsed' : ''}`}
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
                    className={({ isActive }) => {
                      const queryMatches = item.path.includes('?')
                        ? location.pathname === routePathFromHref(item.path) && location.search === `?${item.path.split('?')[1]}`
                        : isActive
                      return queryMatches ? 'navigation-link navigation-link--active' : 'navigation-link'
                    }}
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

        <div className="sidebar-utilities">
          {sessionContext && !needsSecurityCheckpoint && !requiredActionCheckpointActive && sharedIdentityScopeAllowsPath('/tasks', sharedIdentityScope) ? <SygTasksLauncher /> : null}
          {sessionContext && !needsSecurityCheckpoint && !requiredActionCheckpointActive && canOpenSygilant ? <SygilantLauncher /> : null}
          {sessionContext && !needsSecurityCheckpoint && !requiredActionCheckpointActive ? <SygSphereLauncher employeeId={sessionContext.employeeId} /> : null}
          <SupportHelpButton />
          <SystemStatusIndicator canOpenOperations={canOpenSystemOperations} status={systemServiceStatus} />
        </div>
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
              <HeaderNotificationButton enabled={Boolean(sessionContext)} />
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

        {requiredActionQuery.isError ? (
          <div className="shell-alert shell-alert--warning" role="alert">
            Required actions could not be verified. Only the Action Center, My Documents, time clock, and call-off workflow remain available until the check succeeds.
            <button className="secondary-button secondary-button--small" onClick={() => void requiredActionQuery.refetch()} type="button">Retry check</button>
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
        {sessionContext && !needsSecurityCheckpoint && !requiredActionCheckpointActive ? <LiveNotifications key={sessionContext.employeeId} employeeId={sessionContext.employeeId} username={sessionContext.username} /> : null}
        {sessionContext && !needsSecurityCheckpoint && !requiredActionCheckpointActive && sharedIdentityScopeAllowsPath('/tasks', sharedIdentityScope) ? <SygTasksAlarmHost employeeId={sessionContext.employeeId} /> : null}

        <main id="main-content" tabIndex={-1}>
          {requiredActionCheckpoint ? <RequiredActionsCheckpointNotice checkpoint={requiredActionCheckpoint} /> : null}
          {unavailableRouteWindow ? <MaintenanceUnavailablePanel window={unavailableRouteWindow} /> : <Outlet />}
        </main>
      </div>
    </div>
  )
}
