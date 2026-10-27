import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { type QueryClient, useIsMutating, useQuery, useQueryClient } from '@tanstack/react-query'
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
import { getTimekeepingOperationsWorkspace, isOperationalAlertLive } from '../data/timeOperations'
import { getRequiredActionCheckpoint } from '../data/actionCenter'
import {
  authSessionIdFromAccessToken,
  getSessionContextWithSignal,
  isTransientSessionContextError,
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
  isActiveSupabaseClient,
  isConfirmedInvalidSharedIdentitySupabaseSessionError,
  isSupabaseConfigured,
  isTransientSharedIdentitySupabaseSessionError,
} from '../lib/supabase'
import { lastCompletedPayrollWeek } from '../lib/time'
import { bindViewDateSelectionOwner, clearViewDateSelections } from '../lib/sessionViewDateSelection'
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
import { PlatformPresenceReporter } from './PlatformPresenceReporter'
import { RequiredActionsCheckpointNotice } from './RequiredActionsCheckpointNotice'
import { SygSphereCommunicationsRuntimeProvider } from './communications/SygSphereCommunicationsRuntime'
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
  isTransientSharedIdentitySessionRestoreError,
  sharedIdentityRecoveryDelayMs,
  sharedIdentityRefreshDelayMs,
  sharedIdentitySessionRestoreRetryAfterMs,
  shouldPreserveSharedIdentitySessionOnRestoreError,
} from '../lib/sharedIdentitySession'
import { workforceRoleLabel } from '../lib/workforceRoleAssignment'

const INACTIVITY_WARNING_MS = 55 * 60 * 1000
const INACTIVITY_LOGOUT_MS = 60 * 60 * 1000
const SESSION_ACTIVITY_STORAGE_PREFIX = 'sygshift.session.activity.v1'
const SESSION_ACTIVITY_THROTTLE_MS = 5_000
const SECURE_ACCESS_REQUEST_TIMEOUT_MS = 12_000
const REQUIRED_ACTION_CHECKPOINT_TIMEOUT_MS = 8_000
const WORKSPACE_ALERT_ROTATE_MS = 9_000
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'sygshift.sidebar.collapsed'
const SIDEBAR_GROUP_STORAGE_KEY = 'sygshift.sidebar.open-group'

class SecureAccessRequestTimeoutError extends Error {
  constructor() {
    super('The secure-access request timed out.')
    this.name = 'SecureAccessRequestTimeoutError'
  }
}

class SecureAccessRequestCancelledError extends Error {
  constructor() {
    super('The secure-access request was cancelled.')
    this.name = 'SecureAccessRequestCancelledError'
  }
}

class RequiredActionCheckpointTimeoutError extends Error {
  constructor() {
    super('The required-action check timed out.')
    this.name = 'RequiredActionCheckpointTimeoutError'
  }
}
const COMPACT_NAVIGATION_QUERY = '(max-width: 1280px), (max-width: 1366px) and (max-height: 800px)'
const SESSION_SCOPED_QUERY_ROOTS = [
  'support',
  'my-notifications',
  'notification-device-session',
  'notification-device-push',
  'required-action-checkpoint',
  'sygsphere',
  'client-communications',
  'session-context',
] as const

function clearSessionScopedQueryCaches(queryClient: QueryClient) {
  for (const key of SESSION_SCOPED_QUERY_ROOTS) queryClient.removeQueries({ queryKey: [key] })
}

function compactNavigationMatches(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(COMPACT_NAVIGATION_QUERY).matches
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

async function getRequiredActionCheckpointWithinDeadline(signal: AbortSignal) {
  const controller = new AbortController()
  const interrupted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new RequiredActionCheckpointTimeoutError())
    }, { once: true })
  })
  const forwardCancellation = () => controller.abort(signal.reason)
  if (signal.aborted) forwardCancellation()
  else signal.addEventListener('abort', forwardCancellation, { once: true })

  const timeout = window.setTimeout(() => {
    controller.abort(new RequiredActionCheckpointTimeoutError())
  }, REQUIRED_ACTION_CHECKPOINT_TIMEOUT_MS)

  try {
    return await Promise.race([
      getRequiredActionCheckpoint(controller.signal),
      interrupted,
    ])
  } finally {
    window.clearTimeout(timeout)
    signal.removeEventListener('abort', forwardCancellation)
  }
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
  const [authRecoveryRequired, setAuthRecoveryRequired] = useState(false)
  const [authRecoveryRetrying, setAuthRecoveryRetrying] = useState(false)
  const [logoutWarningRemaining, setLogoutWarningRemaining] = useState<number | null>(null)
  const [accountPhotoUrl, setAccountPhotoUrl] = useState<string | null>(null)
  const [accountSummary, setAccountSummary] = useState<MyAccount | null>(null)
  const [accountRefreshVersion, setAccountRefreshVersion] = useState(0)
  const [theme, setTheme] = useState<SygShiftTheme>(getCurrentTheme)
  const activeMutationCount = useIsMutating()
  const location = useLocation()
  const internalHistoryRef = useRef<InternalNavigationEntry[]>(parseInternalHistory(window.sessionStorage.getItem(INTERNAL_NAVIGATION_STORAGE_KEY)))
  const authRecoveryRetryRef = useRef<(() => Promise<void>) | null>(null)
  const authSessionInvalidationRef = useRef<(() => void) | null>(null)
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
    queryFn: ({ signal }) => getRequiredActionCheckpointWithinDeadline(signal),
    queryKey: ['required-action-checkpoint', sessionContext?.employeeId],
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    retry: false,
  })
  const requiredActionCheckpoint = requiredActionQuery.data ?? null
  const requiredActionCheckpointActive = Boolean(requiredActionCheckpoint?.blocking)
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

    const announcementLoadAlerts: WorkspaceAlertEntry[] = activeBannerQuery.isError
      && activeBannerQuery.data === undefined
      ? [{
          id: 'announcement-banner-load-failed',
          title: 'Banner alerts unavailable',
          message: 'Current banner alerts could not be verified. Refresh the page or try again shortly.',
          tone: 'urgent',
          icon: 'announcement',
          ctaHref: null,
          ctaLabel: null,
        }]
      : []

    const attendanceAlerts = (operationalAlertQuery.data?.alerts ?? [])
      .filter((alert) => (
        isOperationalAlertLive(alert, operationalAlertQuery.data?.serverTimestamp)
        && !alert.acknowledgedAt
        && (alert.priority === 'urgent' || alert.priority === 'high')
      ))
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
    const liveAlerts = [...attendanceAlerts, ...announcementAlerts, ...announcementLoadAlerts]

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
  }, [activeBannerQuery.data, activeBannerQuery.isError, operationalAlertQuery.data?.alerts, operationalAlertQuery.data?.serverTimestamp, payrollReminderWeek.fromLabel, payrollReminderWeek.throughLabel, sessionContext, showPayrollReminder])

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
  // Required actions deliberately keep the application UI and every outbound
  // communications control unavailable. The global runtime remains connected,
  // however, so an already-authorized employee can still receive a direct call
  // or listen to an authorized PTT channel while completing that checkpoint.
  const communicationsRuntimeEnabled = Boolean(
    sessionContext?.permissions.includes('sygsphere.comms.use')
    && !needsSecurityCheckpoint,
  )
  const withCommunicationsRuntime = (content: ReactNode) => (
    <SygSphereCommunicationsRuntimeProvider
      employeeId={sessionContext?.employeeId ?? null}
      enabled={communicationsRuntimeEnabled}
      permissions={sessionContext?.permissions ?? []}
    >
      {content}
    </SygSphereCommunicationsRuntimeProvider>
  )

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

  function retrySecureAccess() {
    if (authRecoveryRetrying) return
    void authRecoveryRetryRef.current?.()
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
    type SessionLoadIntent = {
      notifyOtherTabs: boolean
      restoreSharedSession: boolean
      showLoading: boolean
    }
    type SessionLoadFlightState = {
      currentIntent: SessionLoadIntent
      pendingIntent: SessionLoadIntent | null
    }

    let active = true
    let authSubscription: { unsubscribe: () => void } | null = null
    let activeSecureRequestController: AbortController | null = null
    let sharedIdentityRefreshTimer: number | undefined
    let sessionGeneration = 0
    let sessionLoadInFlight: {
      generation: number
      promise: Promise<void>
      state: SessionLoadFlightState
    } | null = null
    let sessionRecoveryAttempt = 0
    let sessionRecoveryTimer: number | undefined
    let unsubscribeSharedBrowserEvents: () => void = () => undefined

    if (!isSupabaseConfigured) {
      setAuthLoading(false)
      setAuthRecoveryRequired(false)
      setSessionContext(null)
      return () => {
        active = false
      }
    }

    function clearSharedIdentityRefreshTimer() {
      if (sharedIdentityRefreshTimer) window.clearTimeout(sharedIdentityRefreshTimer)
      sharedIdentityRefreshTimer = undefined
    }

    function clearSessionRecoveryTimer(resetAttempt = false) {
      if (sessionRecoveryTimer) window.clearTimeout(sessionRecoveryTimer)
      sessionRecoveryTimer = undefined
      if (resetAttempt) sessionRecoveryAttempt = 0
    }

    function isCurrentSessionGeneration(generation: number): boolean {
      return active && generation === sessionGeneration
    }

    function invalidateSessionLoads() {
      sessionGeneration += 1
      activeSecureRequestController?.abort(new SecureAccessRequestCancelledError())
      activeSecureRequestController = null
      sessionLoadInFlight = null
      clearSharedIdentityRefreshTimer()
      clearSessionRecoveryTimer(true)
      setAuthRecoveryRetrying(false)
    }

    authSessionInvalidationRef.current = invalidateSessionLoads

    async function runSecureAccessRequest<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const controller = new AbortController()
      activeSecureRequestController = controller
      const timeout = window.setTimeout(() => {
        controller.abort(new SecureAccessRequestTimeoutError())
      }, SECURE_ACCESS_REQUEST_TIMEOUT_MS)
      const interrupted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new SecureAccessRequestCancelledError())
        }, { once: true })
      })
      try {
        return await Promise.race([request(controller.signal), interrupted])
      } finally {
        window.clearTimeout(timeout)
        if (activeSecureRequestController === controller) activeSecureRequestController = null
      }
    }

    function tearDownSharedIdentitySession(message: string | null, notifyOtherTabs: boolean) {
      invalidateSessionLoads()
      clearSharedIdentityRefreshTimer()
      clearSessionRecoveryTimer(true)
      clearSessionScopedQueryCaches(queryClient)
      deactivateSharedIdentitySupabaseSession()
      clearSharedIdentitySession()
      clearViewDateSelections()
      setAuthSessionId(null)
      setSessionContext(null)
      setAuthMessage(message)
      setAuthLoading(false)
      setAuthRecoveryRequired(false)
      if (notifyOtherTabs) publishSharedIdentityBrowserEvent('cleared')
    }

    function scheduleSharedIdentityRestore(accessToken: string) {
      if (!active) return
      clearSharedIdentityRefreshTimer()
      sharedIdentityRefreshTimer = window.setTimeout(() => {
        void loadSessionContext(false, true, true)
      }, sharedIdentityRefreshDelayMs(accessToken))
    }

    function scheduleSessionRecovery(restoreSharedSession: boolean, retryAfterMs: number | null = null) {
      if (!active) return
      if (sessionRecoveryTimer !== undefined) return
      const delayMs = sharedIdentityRecoveryDelayMs(sessionRecoveryAttempt, retryAfterMs)
      sessionRecoveryAttempt += 1
      sessionRecoveryTimer = window.setTimeout(() => {
        sessionRecoveryTimer = undefined
        void loadSessionContext(false, restoreSharedSession, restoreSharedSession)
      }, delayMs)
    }

    function showTransientSecureAccessRecovery(message: string) {
      setAuthMessage(message)
      setAuthRecoveryRequired(true)
      setAuthLoading(false)
    }

    function showTerminalSecureAccessFailure(message: string) {
      clearSessionRecoveryTimer(true)
      setAuthMessage(message)
      setAuthRecoveryRequired(false)
      setAuthLoading(false)
    }

    async function restoreSharedIdentitySession(
      notifyOtherTabs: boolean,
      generation: number,
    ): Promise<'missing' | 'preserved' | 'restored' | 'retrying' | 'stale'> {
      const previouslyShared = getSharedIdentitySessionScope() !== null
      let restored
      try {
        restored = await runSecureAccessRequest((signal) => hydrateSharedIdentitySession(signal))
      } catch (error) {
        if (!isCurrentSessionGeneration(generation)) return 'stale'
        const retryable = error instanceof SecureAccessRequestTimeoutError
          || (shouldPreserveSharedIdentitySessionOnRestoreError(error)
            && isTransientSharedIdentitySessionRestoreError(error))
        if (retryable) {
          scheduleSessionRecovery(true, sharedIdentitySessionRestoreRetryAfterMs(error))
          showTransientSecureAccessRecovery(
            'SygShift is reconnecting to your secure session. Your sign-in has been preserved.',
          )
          return 'retrying'
        }
        showTerminalSecureAccessFailure(
          'The shared-session service returned an unexpected response. Your current sign-in has not been cleared.',
        )
        return 'preserved'
      }
      if (!isCurrentSessionGeneration(generation)) return 'stale'
      if (!restored) {
        if (previouslyShared) tearDownSharedIdentitySession(null, notifyOtherTabs)
        return 'missing'
      }
      if (restored.scope === 'sygsphere' && !isSygSpherePath(window.location.pathname)) {
        void clearSharedIdentityServerSession(restored.accessToken)
        tearDownSharedIdentitySession(null, notifyOtherTabs)
        return 'missing'
      }
      try {
        await runSecureAccessRequest((signal) => activateSharedIdentitySupabaseSession(
          restored.accessToken,
          restored.refreshToken,
          signal,
        ))
      } catch (error) {
        if (!isCurrentSessionGeneration(generation)) return 'stale'
        if (
          error instanceof SecureAccessRequestTimeoutError
          || isTransientSharedIdentitySupabaseSessionError(error)
        ) {
          scheduleSessionRecovery(true)
          showTransientSecureAccessRecovery(
            'SygShift is reconnecting to secure authentication services. Your sign-in has been preserved.',
          )
          return 'retrying'
        }
        if (isConfirmedInvalidSharedIdentitySupabaseSessionError(error)) {
          void clearSharedIdentityServerSession(restored.accessToken)
          tearDownSharedIdentitySession(
            'Your secure shared session is no longer valid. Open SygShift from Sygilant again or sign in directly.',
            notifyOtherTabs,
          )
          return 'missing'
        }
        showTerminalSecureAccessFailure(
          'Secure authentication returned an unexpected response. Your current sign-in has not been cleared.',
        )
        return 'preserved'
      }
      if (!isCurrentSessionGeneration(generation)) return 'stale'
      clearSessionRecoveryTimer()
      scheduleSharedIdentityRestore(restored.accessToken)
      if (notifyOtherTabs) publishSharedIdentityBrowserEvent('updated')
      return 'restored'
    }

    async function performSessionContextLoad(
      generation: number,
      showLoading = true,
      restoreSharedSession = false,
      notifyOtherTabs = false,
    ) {
      if (!isCurrentSessionGeneration(generation)) return
      if (showLoading) setAuthLoading(true)
      setAuthMessage(null)

      let sharedRestoreOutcome: 'missing' | 'preserved' | 'restored' | 'retrying' | 'stale' = 'missing'
      if (restoreSharedSession) {
        sharedRestoreOutcome = await restoreSharedIdentitySession(notifyOtherTabs, generation)
      }
      if (!isCurrentSessionGeneration(generation) || sharedRestoreOutcome === 'stale') return

      let data
      try {
        const result = await runSecureAccessRequest(() => getSupabaseClient().auth.getSession())
        if (result.error) throw result.error
        data = result.data
      } catch (error) {
        if (!isCurrentSessionGeneration(generation)) return
        const sharedSessionExpected = getSharedIdentitySessionScope() !== null
          || sharedRestoreOutcome === 'preserved'
          || sharedRestoreOutcome === 'restored'
          || sharedRestoreOutcome === 'retrying'
        if (sharedSessionExpected && isConfirmedInvalidSharedIdentitySupabaseSessionError(error)) {
          void clearSharedIdentityServerSession()
          tearDownSharedIdentitySession(
            'Your secure shared session is no longer valid. Open SygShift from Sygilant again or sign in directly.',
            notifyOtherTabs,
          )
          return
        }
        if (
          error instanceof SecureAccessRequestTimeoutError
          || isTransientSharedIdentitySupabaseSessionError(error)
        ) {
          scheduleSessionRecovery(sharedSessionExpected)
          showTransientSecureAccessRecovery(
            'SygShift is reconnecting to secure authentication services. Your sign-in has been preserved.',
          )
          return
        }
        showTerminalSecureAccessFailure(
          'Secure authentication returned an unexpected response. Your current sign-in has not been cleared.',
        )
        return
      }
      if (!isCurrentSessionGeneration(generation)) return
      setAuthSessionId(data.session ? authSessionIdFromAccessToken(data.session.access_token) : null)

      if (!data.session) {
        if (sharedRestoreOutcome === 'retrying') return
        if (sharedRestoreOutcome === 'preserved') {
          setAuthLoading(false)
          return
        }
        clearSessionScopedQueryCaches(queryClient)
        deactivateSharedIdentitySupabaseSession()
        clearSharedIdentitySession()
        clearViewDateSelections()
        setSessionContext(null)
        setAuthRecoveryRequired(false)
        setAuthLoading(false)
        return
      }

      try {
        const context = await runSecureAccessRequest((signal) => getSessionContextWithSignal(signal))
        if (!isCurrentSessionGeneration(generation)) return
        if (sharedRestoreOutcome !== 'retrying') clearSessionRecoveryTimer(true)
        queryClient.setQueryData(['session-context'], context)
        bindViewDateSelectionOwner(context.employeeId)
        setSessionContext(context)
        setAuthMessage(null)
        setAuthRecoveryRequired(false)
      } catch (error) {
        if (!isCurrentSessionGeneration(generation)) return
        if (error instanceof SecureAccessRequestTimeoutError || isTransientSessionContextError(error)) {
          scheduleSessionRecovery(getSharedIdentitySessionScope() !== null)
          showTransientSecureAccessRecovery(
            'SygShift is reconnecting to secure account services. Your sign-in has been preserved.',
          )
          return
        }
        const wasShared = getSharedIdentitySessionScope() !== null
        if (wasShared) {
          void clearSharedIdentityServerSession(data.session.access_token)
          tearDownSharedIdentitySession(null, true)
        } else {
          await signOut()
          clearSessionScopedQueryCaches(queryClient)
        }
        if (isCurrentSessionGeneration(generation)) {
          setSessionContext(null)
          setAuthRecoveryRequired(false)
          setAuthMessage('Your account is not linked to an active SygShift employee record.')
        }
      } finally {
        if (isCurrentSessionGeneration(generation)) setAuthLoading(false)
      }
    }

    async function loadSessionContext(
      showLoading = true,
      restoreSharedSession = false,
      notifyOtherTabs = false,
    ): Promise<void> {
      const generation = sessionGeneration
      const requestedIntent = { notifyOtherTabs, restoreSharedSession, showLoading }
      if (sessionLoadInFlight?.generation === generation) {
        const state = sessionLoadInFlight.state
        const strongestIntent = state.pendingIntent
          ? mergeSessionLoadIntents(state.currentIntent, state.pendingIntent)
          : state.currentIntent
        if (!sessionLoadIntentCovers(strongestIntent, requestedIntent)) {
          state.pendingIntent = mergeSessionLoadIntents(strongestIntent, requestedIntent)
        }
        return sessionLoadInFlight.promise
      }
      const state: SessionLoadFlightState = {
        currentIntent: requestedIntent,
        pendingIntent: null,
      }
      const request = runSessionLoadFlight(generation, state)
      const inFlight = { generation, promise: request, state }
      sessionLoadInFlight = inFlight
      try {
        await request
      } finally {
        if (sessionLoadInFlight === inFlight) sessionLoadInFlight = null
      }
    }

    async function runSessionLoadFlight(
      generation: number,
      state: SessionLoadFlightState,
    ): Promise<void> {
      let intent = state.currentIntent
      while (isCurrentSessionGeneration(generation)) {
        state.currentIntent = intent
        await performSessionContextLoad(
          generation,
          intent.showLoading,
          intent.restoreSharedSession,
          intent.notifyOtherTabs,
        )
        if (!isCurrentSessionGeneration(generation)) return
        const nextIntent = state.pendingIntent
        state.pendingIntent = null
        if (!nextIntent) return
        intent = nextIntent
      }
    }

    function mergeSessionLoadIntents(
      left: SessionLoadIntent,
      right: SessionLoadIntent,
    ): SessionLoadIntent {
      return {
        notifyOtherTabs: left.notifyOtherTabs || right.notifyOtherTabs,
        restoreSharedSession: left.restoreSharedSession || right.restoreSharedSession,
        showLoading: left.showLoading || right.showLoading,
      }
    }

    function sessionLoadIntentCovers(
      available: SessionLoadIntent,
      requested: SessionLoadIntent,
    ): boolean {
      return (!requested.notifyOtherTabs || available.notifyOtherTabs)
        && (!requested.restoreSharedSession || available.restoreSharedSession)
        && (!requested.showLoading || available.showLoading)
    }

    authRecoveryRetryRef.current = async () => {
      if (!active) return
      setAuthRecoveryRetrying(true)
      try {
        await loadSessionContext(false, true, true)
      } finally {
        if (active) setAuthRecoveryRetrying(false)
      }
    }

    void (async () => {
      await loadSessionContext(true, true)
      if (!active) return
      const authClient = getSupabaseClient()
      const { data: { subscription } } = authClient.auth.onAuthStateChange((_event, session) => {
        if (!isActiveSupabaseClient(authClient)) return
        if (!session) {
          invalidateSessionLoads()
          clearSessionScopedQueryCaches(queryClient)
          void clearPushSession()
          if (!getSharedIdentitySessionScope()) clearSharedIdentitySession()
          deactivateSharedIdentitySupabaseSession()
          clearViewDateSelections()
          setAuthSessionId(null)
          setSessionContext(null)
          setAuthRecoveryRequired(false)
          setAuthLoading(false)
          return
        }

        if (getSharedIdentitySessionScope()) return
        setAuthSessionId(authSessionIdFromAccessToken(session.access_token))

        if (_event === 'SIGNED_IN') {
          invalidateSessionLoads()
          clearSessionScopedQueryCaches(queryClient)
          void loadSessionContext(true)
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
        if (getSharedIdentitySessionScope()) {
          tearDownSharedIdentitySession(null, false)
        } else {
          invalidateSessionLoads()
          clearSharedIdentityRefreshTimer()
          clearSessionRecoveryTimer(true)
          clearSessionScopedQueryCaches(queryClient)
          setAuthRecoveryRequired(false)
          void loadSessionContext(true)
        }
        return
      }
      invalidateSessionLoads()
      clearSessionScopedQueryCaches(queryClient)
      void loadSessionContext(true, true)
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
      activeSecureRequestController?.abort(new SecureAccessRequestCancelledError())
      authRecoveryRetryRef.current = null
      authSessionInvalidationRef.current = null
      clearSharedIdentityRefreshTimer()
      clearSessionRecoveryTimer()
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
    authSessionInvalidationRef.current?.()
    setAuthMessage(null)

    try {
      await signOut()
      clearSessionScopedQueryCaches(queryClient)
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
      authSessionInvalidationRef.current?.()
      try {
        await signOut()
      } finally {
        clearSessionScopedQueryCaches(queryClient)
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
  }, [navigate, queryClient, sessionContext])

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

  if (isSupabaseConfigured && authRecoveryRequired && !sessionContext) {
    return (
      <main className="security-page">
        <section className="security-card" role="alert">
          <ShieldAlert aria-hidden="true" size={36} />
          <h1>Secure access is temporarily unavailable</h1>
          <p>Your sign-in is still protected, but SygShift could not verify your account services within 12 seconds. The workspace remains closed until that verification succeeds.</p>
          <p>SygShift will keep retrying safely in the background. You can also retry now without signing in again.</p>
          <div className="security-card__actions">
            <button className="primary-action" disabled={authRecoveryRetrying} onClick={retrySecureAccess} type="button">
              {authRecoveryRetrying ? 'Retrying secure access…' : 'Retry secure access'}
            </button>
          </div>
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
    return withCommunicationsRuntime(
      <main className="security-page">
        <section className="security-card security-card--compact" role="status">
          <ShieldCheck aria-hidden="true" size={36} />
          <h1>Checking required actions…</h1>
          <p>SygShift is checking your current schedules, notices, training, and documents before opening the workspace.</p>
        </section>
      </main>
    )
  }

  if (isSupabaseConfigured && requiredActionCheckpointActive && !checkpointAllowsLocation(location.pathname, location.search)) {
    return withCommunicationsRuntime(<Navigate to="/actions?checkpoint=required" replace state={{ from: location }} />)
  }

  if (isSupabaseConfigured && lacksRouteAccess) {
    return withCommunicationsRuntime(<Navigate to={resolveAuthorizedLandingRoute(sessionContext)} replace />)
  }

  return withCommunicationsRuntime(
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
          {sessionContext && !needsSecurityCheckpoint && !requiredActionCheckpointActive ? <PlatformPresenceReporter /> : null}
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
                  <span>{workforceRoleLabel(accountSummary?.employment.primaryRole) || 'Employee'} · @{sessionContext.username}</span>
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
          ) : null}
          fallbackTimeZone={sessionContext?.timeZone}
          serverTimestamp={maintenanceStatusQuery.data?.serverTime}
        />

        {authMessage ? (
          <div className="shell-alert" role="alert">
            {authMessage}
          </div>
        ) : null}

        {requiredActionQuery.isError ? (
          <div className="shell-alert shell-alert--warning" role="alert">
            Required actions could not be refreshed. Your verified workspace remains available, protected access is unchanged, and SygShift will retry automatically.
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
