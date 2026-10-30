// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnnouncementBanner } from '../data/announcements'
import { AppShell } from './AppShell'

const employeeId = 'a25a5f5f-45b6-4e43-87a6-79298ed9347f'
const accessToken = 'header.eyJleHAiOjQxMDI0NDQ4MDAsInNlc3Npb25faWQiOiI3YzIxNzAxYS01NmVkLTRjNjQtOGM0Ny1jOWRjNTE2ZTQzOTgifQ.signature'

type OperationalWorkspaceFixture = {
  serverTimestamp: string
  alerts: Array<{
    id: string
    alertType: string
    priority: 'normal' | 'high' | 'urgent'
    title: string
    summary: string
    employeeId: string | null
    shiftId: string | null
    directPath: string | null
    createdAt: string
    acknowledgedAt: string | null
    active?: boolean
    lifecycleStatus?: 'active_operations' | 'payroll_review' | 'resolved'
    liveUntil?: string | null
  }>
}

const shared = vi.hoisted(() => ({
  activeAccessToken: null as string | null,
  activationError: null as Error | null,
  activationFailureKind: 'transient' as 'invalid' | 'terminal' | 'transient',
  authGetSessionPromise: null as Promise<{
    data: { session: { access_token: string } | null }
    error?: Error | null
  }> | null,
  authSourceActive: true,
  authListener: null as null | ((event: string, session: { access_token: string } | null) => void),
  announcementBannerError: null as Error | null,
  announcementBanners: [] as AnnouncementBanner[],
  browserListener: null as ((action: 'cleared' | 'updated') => void) | null,
  emergencyRegistrationError: null as Error | null,
  emergencyRegistrationFailureKind: 'transient' as 'compatibility' | 'revoked' | 'transient',
  hydrateError: null as Error | null,
  hydrateTransient: true,
  hydrateResult: null as null | { accessToken: string; expiresAt: number; refreshToken: string; scope: 'platform' | 'sygsphere' },
  operationalWorkspace: { alerts: [], serverTimestamp: '2026-10-05T12:00:00.000Z' } as OperationalWorkspaceFixture,
  requiredActionBlocking: false,
  requiredActionError: null as Error | null,
  scope: null as null | 'platform' | 'sygsphere',
  sessionContextError: null as Error | null,
  sessionContextFailureKind: 'transient' as 'compatibility' | 'revoked' | 'transient',
}))

vi.mock('../lib/sharedIdentitySession', () => ({
  clearSharedIdentityServerSession: vi.fn(async () => {
    shared.activeAccessToken = null
    shared.scope = null
  }),
  clearSharedIdentitySession: vi.fn(() => {
    shared.activeAccessToken = null
    shared.scope = null
  }),
  getSharedIdentitySessionScope: vi.fn(() => shared.scope),
  hydrateSharedIdentitySession: vi.fn(async () => {
    if (shared.hydrateError) throw shared.hydrateError
    if (shared.hydrateResult) shared.scope = shared.hydrateResult.scope
    return shared.hydrateResult
  }),
  isTransientSharedIdentitySessionRestoreError: vi.fn((error: unknown) => shared.hydrateTransient && error === shared.hydrateError),
  sharedIdentityRecoveryDelayMs: vi.fn(() => 5_000),
  sharedIdentityRefreshDelayMs: vi.fn(() => 60_000),
  sharedIdentitySessionRestoreRetryAfterMs: vi.fn(() => 2_000),
  shouldPreserveSharedIdentitySessionOnRestoreError: vi.fn((error: unknown) => error === shared.hydrateError),
}))

vi.mock('../lib/sharedIdentityBrowserSync', () => ({
  publishSharedIdentityBrowserEvent: vi.fn(),
  subscribeToSharedIdentityBrowserEvents: vi.fn((listener: (action: 'cleared' | 'updated') => void) => {
    shared.browserListener = listener
    return () => { shared.browserListener = null }
  }),
}))

vi.mock('../lib/supabase', () => ({
  activateSharedIdentitySupabaseSession: vi.fn(async (token: string) => {
    if (shared.activationError) throw shared.activationError
    shared.activeAccessToken = token
  }),
  deactivateSharedIdentitySupabaseSession: vi.fn(() => {
    shared.activeAccessToken = null
  }),
  getSupabaseClient: vi.fn(() => ({
    auth: {
      getSession: vi.fn(async () => shared.authGetSessionPromise ?? {
        data: {
          session: shared.activeAccessToken ? { access_token: shared.activeAccessToken } : null,
        },
        error: null,
      }),
      onAuthStateChange: vi.fn((listener: (event: string, session: { access_token: string } | null) => void) => {
        shared.authListener = listener
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      }),
    },
  })),
  isConfirmedInvalidSharedIdentitySupabaseSessionError: vi.fn((error: unknown) => (
    error === shared.activationError && shared.activationFailureKind === 'invalid'
  )),
  isActiveSupabaseClient: vi.fn(() => shared.authSourceActive),
  isSupabaseConfigured: true,
  isTransientSharedIdentitySupabaseSessionError: vi.fn((error: unknown) => (
    error === shared.activationError && shared.activationFailureKind === 'transient'
  )),
}))

vi.mock('../data/auth', () => ({
  SESSION_CONTEXT_REFRESH_EVENT: 'sygshift:session-context-refresh',
  authSessionIdFromAccessToken: vi.fn(() => '7c21701a-56ed-4c64-8c47-c9dc516e4398'),
  getSessionContext: vi.fn(async () => {
    if (shared.sessionContextError) throw shared.sessionContextError
    return {
      accessGeneration: 1,
      displayName: 'Shared User',
      employeeId,
      hasMfa: false,
      mfaEnrolledAt: null,
      mfaRequired: true,
      mustChangePassword: false,
      passwordChangedAt: null,
      permissions: ['actions.self.view', 'apps.sygilant.access', 'operations.view', 'time.view'],
      role: 'guard',
      timeZone: 'America/Denver',
      username: 'shareduser',
    }
  }),
  getSessionContextWithSignal: vi.fn(async () => {
    if (shared.sessionContextError) throw shared.sessionContextError
    return {
      accessGeneration: 1,
      displayName: 'Shared User',
      employeeId,
      hasMfa: false,
      mfaEnrolledAt: null,
      mfaRequired: true,
      mustChangePassword: false,
      passwordChangedAt: null,
      permissions: ['actions.self.view', 'apps.sygilant.access', 'operations.view', 'time.view'],
      role: 'guard',
      timeZone: 'America/Denver',
      username: 'shareduser',
    }
  }),
  isExplicitSessionContextRevocationError: vi.fn((error: unknown) => (
    error === shared.sessionContextError && shared.sessionContextFailureKind === 'revoked'
  )),
  isTransientSessionContextError: vi.fn((error: unknown) => (
    error === shared.sessionContextError && shared.sessionContextFailureKind === 'transient'
  )),
  notifySessionContextChanged: vi.fn(),
  recordCompletedSignInWithRetry: vi.fn(async () => undefined),
  signOut: vi.fn(async () => undefined),
}))

vi.mock('../data/emergencyAccessSession', () => ({
  isExplicitEmergencyPlatformSessionRevocationError: vi.fn((error: unknown) => (
    error === shared.emergencyRegistrationError && shared.emergencyRegistrationFailureKind === 'revoked'
  )),
  isTransientEmergencyPlatformSessionError: vi.fn((error: unknown) => (
    error === shared.emergencyRegistrationError && shared.emergencyRegistrationFailureKind === 'transient'
  )),
  registerEmergencyPlatformSession: vi.fn(async () => {
    if (shared.emergencyRegistrationError) throw shared.emergencyRegistrationError
    return {
      accessGeneration: 1,
      application: 'sygshift',
      expiresAt: '2026-10-29T23:00:00.000Z',
      id: 'f7658ad9-c43a-45b7-973f-f531649d0f29',
      registered: true,
    }
  }),
}))

vi.mock('../data/announcements', async (loadOriginal) => ({
  ...await loadOriginal<typeof import('../data/announcements')>(),
  getActiveAnnouncementBanners: vi.fn(async () => {
    if (shared.announcementBannerError) throw shared.announcementBannerError
    return shared.announcementBanners
  }),
}))
vi.mock('../data/timeOperations', async (loadOriginal) => ({
  ...await loadOriginal<typeof import('../data/timeOperations')>(),
  getTimekeepingOperationsWorkspace: vi.fn(async () => shared.operationalWorkspace),
}))
vi.mock('../data/actionCenter', () => ({
  getRequiredActionCheckpoint: vi.fn(async () => {
    if (shared.requiredActionError) throw shared.requiredActionError
    return {
      blocking: shared.requiredActionBlocking,
      items: [],
      rollout: { enabled: true, enrolled: shared.requiredActionBlocking, mode: 'canary' },
      serverTimestamp: '2026-09-11T12:00:00Z',
      summary: { announcements: 0, critical: 0, documents: 0, hrTasks: 0, overdue: 0, schedules: 0, signatures: 0, training: 0 },
      total: 0,
      urgentAccess: [],
    }
  }),
}))
vi.mock('../data/maintenance', () => ({
  getMaintenanceStatus: vi.fn(async () => ({ active: [], recentlyCompleted: [], upcoming: [] })),
  maintenanceFeatureForPath: vi.fn(() => null),
}))
vi.mock('../data/systemStatus', () => ({
  deriveSystemServiceStatus: vi.fn(() => ({ label: 'Operational', tone: 'operational' })),
  getSystemReadiness: vi.fn(async () => ({ checks: [] })),
}))
vi.mock('../data/myAccount', () => ({
  getMyAccount: vi.fn(async () => { throw new Error('Optional account summary unavailable') }),
  getMyAccountPhoto: vi.fn(),
}))
vi.mock('../data/pushNotifications', () => ({ clearPushSession: vi.fn(async () => undefined) }))
vi.mock('../lib/payrollReminder', () => ({ shouldShowPayrollExportReminder: vi.fn(() => false) }))
vi.mock('../lib/time', () => ({ lastCompletedPayrollWeek: vi.fn(() => ({ fromLabel: '09/01/2026', throughLabel: '09/07/2026' })) }))
vi.mock('../lib/theme', () => ({
  applyTheme: vi.fn(),
  getCurrentTheme: vi.fn(() => 'light'),
}))
vi.mock('./MaintenanceNotice', () => ({
  MaintenanceNotice: () => null,
  MaintenanceUnavailablePanel: () => <div>Maintenance unavailable</div>,
}))
vi.mock('./SystemStatusIndicator', () => ({ SystemStatusIndicator: () => null }))
vi.mock('./SupportHelpButton', () => ({ SupportHelpButton: () => null }))
vi.mock('./SygSphereLauncher', () => ({ SygSphereLauncher: () => null }))
vi.mock('./SygilantLauncher', () => ({ SygilantLauncher: () => null }))
vi.mock('./SygTasksLauncher', () => ({ SygTasksLauncher: () => null }))
vi.mock('./SygTasksAlarmHost', () => ({ SygTasksAlarmHost: () => null }))
vi.mock('./OperationalTimeHeader', () => ({ OperationalTimeHeader: () => <header>Header</header> }))
vi.mock('./HeaderNotificationButton', () => ({ HeaderNotificationButton: () => null }))
vi.mock('./LiveNotifications', () => ({ LiveNotifications: () => null }))

beforeEach(() => {
  shared.activeAccessToken = null
  shared.activationError = null
  shared.activationFailureKind = 'transient'
  shared.authGetSessionPromise = null
  shared.authListener = null
  shared.authSourceActive = true
  shared.announcementBannerError = null
  shared.announcementBanners = []
  shared.browserListener = null
  shared.emergencyRegistrationError = null
  shared.emergencyRegistrationFailureKind = 'transient'
  shared.hydrateError = null
  shared.hydrateTransient = true
  shared.hydrateResult = null
  shared.operationalWorkspace = { alerts: [], serverTimestamp: '2026-10-05T12:00:00.000Z' }
  shared.requiredActionBlocking = false
  shared.requiredActionError = null
  shared.scope = null
  shared.sessionContextError = null
  shared.sessionContextFailureKind = 'transient'
  localStorage.clear()
  sessionStorage.clear()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  window.scrollTo = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('AppShell shared-session lifecycle', () => {
  it('clears a SygSphere-scoped session opened on the platform home and falls back to login', async () => {
    prepareSharedSession('sygsphere')
    renderShell('/')

    expect(await screen.findByText('Native login')).toBeInTheDocument()
    expect(screen.queryByText('Platform home')).not.toBeInTheDocument()
    const { clearSharedIdentityServerSession } = await import('../lib/sharedIdentitySession')
    expect(clearSharedIdentityServerSession).toHaveBeenCalledWith(accessToken)
  })

  it('opens an inherited SygSphere session only in the exact SygSphere workspace', async () => {
    prepareSharedSession('sygsphere')
    renderShell('/sygsphere')

    expect(await screen.findByText('SygSphere workspace')).toBeInTheDocument()
    expect(screen.queryByText('Account security')).not.toBeInTheDocument()
  })

  it('returns a SygSphere-scoped user to SygSphere when internal navigation targets another route', async () => {
    const user = userEvent.setup()
    prepareSharedSession('sygsphere')
    renderShell('/sygsphere')
    await screen.findByText('SygSphere workspace')

    await user.click(screen.getByRole('link', { name: 'Attempt time route' }))
    expect(await screen.findByText('SygSphere workspace')).toBeInTheDocument()
    expect(screen.queryByText('Time route')).not.toBeInTheDocument()
  })

  it('allows a platform-scoped session to open the normal SygShift home', async () => {
    prepareSharedSession('platform')
    renderShell('/')

    expect(await screen.findByText('Platform home')).toBeInTheDocument()
    expect(screen.queryByText('Account security')).not.toBeInTheDocument()
  })

  it('keeps the verified workspace open when required-action details are temporarily unavailable', async () => {
    const user = userEvent.setup()
    shared.requiredActionError = new Error('connection pool timeout')
    prepareSharedSession('platform')
    renderShell('/')

    expect(await screen.findByText('Platform home')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Required actions could not be verified' })).not.toBeInTheDocument()
    expect(screen.getByText(/Required actions could not be refreshed/)).toBeInTheDocument()

    shared.requiredActionError = null
    await user.click(screen.getByRole('button', { name: 'Retry check' }))

    await waitFor(() => {
      expect(screen.queryByText(/Required actions could not be refreshed/)).not.toBeInTheDocument()
    })
    expect(screen.getByText('Platform home')).toBeInTheDocument()
  })

  it('redirects an authenticated employee when the authoritative checkpoint is blocking', async () => {
    shared.requiredActionBlocking = true
    prepareSharedSession('platform')
    renderShell('/time')

    expect(await screen.findByText('Action Center workspace')).toBeInTheDocument()
    expect(screen.queryByText('Time route')).not.toBeInTheDocument()
    expect(document.querySelector('.app-shell--required-actions')).not.toBeNull()
  })

  it('keeps cached blocking checkpoint data authoritative when its background refresh fails', async () => {
    const user = userEvent.setup()
    shared.requiredActionBlocking = true
    prepareSharedSession('platform')
    const { queryClient } = renderShell('/actions')
    expect(await screen.findByText('Action Center workspace')).toBeInTheDocument()

    shared.requiredActionError = new Error('temporary checkpoint refresh failure')
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['required-action-checkpoint', employeeId] })
    })

    expect(document.querySelector('.app-shell--required-actions')).not.toBeNull()

    await user.click(screen.getByRole('link', { name: 'Attempt time route' }))
    expect(await screen.findByText('Action Center workspace')).toBeInTheDocument()
    expect(screen.queryByText('Time route')).not.toBeInTheDocument()
  })

  it('bounds a stalled required-action request and opens the verified workspace in degraded mode', async () => {
    vi.useFakeTimers()
    const checkpointData = await import('../data/actionCenter')
    const getCheckpoint = vi.mocked(checkpointData.getRequiredActionCheckpoint)
    let requestSignal: AbortSignal | undefined
    getCheckpoint.mockImplementationOnce((signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      requestSignal = signal
      signal?.addEventListener('abort', () => reject(new Error('required-action request timed out')), { once: true })
    }))
    prepareSharedSession('platform')
    const view = renderShell('/')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(screen.getByText('Checking required actions…')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_100)
    })

    expect(requestSignal).toHaveProperty('aborted', true)
    expect(screen.getByText('Platform home')).toBeInTheDocument()
    expect(screen.getByText(/Required actions could not be refreshed/)).toBeInTheDocument()
    view.unmount()
  })

  it('replaces a bounded cold-start check with a fail-closed recovery card and keeps retries single-flight', async () => {
    vi.useFakeTimers()
    const timeoutError = new Error('secure access request timed out')
    shared.hydrateError = timeoutError
    const sharedSession = await import('../lib/sharedIdentitySession')
    const hydrate = vi.mocked(sharedSession.hydrateSharedIdentitySession)
    const waitForAbort = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      if (!signal) {
        reject(timeoutError)
        return
      }
      signal.addEventListener('abort', () => reject(timeoutError), { once: true })
    })
    hydrate
      .mockImplementationOnce(waitForAbort)
      .mockImplementationOnce(waitForAbort)

    const view = renderShell('/')
    expect(screen.getByText('Checking secure access…')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_999)
    })
    expect(screen.getByText('Checking secure access…')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.getByRole('heading', { name: 'Secure access is temporarily unavailable' })).toBeInTheDocument()
    expect(screen.queryByText('Native login')).not.toBeInTheDocument()
    expect(screen.queryByText('Platform home')).not.toBeInTheDocument()
    expect(hydrate).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(hydrate).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: 'Retry secure access' }))
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })

    expect(hydrate).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Retrying secure access…' })).toBeDisabled()
    view.unmount()
  })

  it('advances beyond secure access when a background cold-start retry completes verification', async () => {
    vi.useFakeTimers()
    const timeoutError = new Error('secure access request timed out')
    shared.hydrateError = timeoutError
    const sharedSession = await import('../lib/sharedIdentitySession')
    const hydrate = vi.mocked(sharedSession.hydrateSharedIdentitySession)
    hydrate.mockImplementationOnce((signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(timeoutError), { once: true })
    }))

    const view = renderShell('/')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })
    expect(screen.getByRole('heading', { name: 'Secure access is temporarily unavailable' })).toBeInTheDocument()

    shared.hydrateError = null
    prepareSharedSession('platform')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(screen.getByText('Checking required actions…')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Secure access is temporarily unavailable' })).not.toBeInTheDocument()
    view.unmount()
  })

  it('bounds a stalled session-context check and keeps the cold-start workspace closed', async () => {
    vi.useFakeTimers()
    const timeoutError = new Error('session context timed out')
    shared.sessionContextError = timeoutError
    prepareSharedSession('platform')
    const auth = await import('../data/auth')
    const getContext = vi.mocked(auth.getSessionContextWithSignal)
    getContext.mockImplementationOnce((signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(timeoutError), { once: true })
    }))

    const view = renderShell('/')
    expect(screen.getByText('Checking secure access…')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })

    expect(screen.getByRole('heading', { name: 'Secure access is temporarily unavailable' })).toBeInTheDocument()
    expect(screen.queryByText('Platform home')).not.toBeInTheDocument()
    expect(screen.queryByText('Native login')).not.toBeInTheDocument()
    expect(getContext).toHaveBeenCalledTimes(1)
    expect(getContext.mock.calls[0]?.[0]).toHaveProperty('aborted', true)
    view.unmount()
  })

  it('preserves the shared session and retries when Supabase activation fails transiently', async () => {
    shared.activationError = new TypeError('network unavailable')
    shared.activationFailureKind = 'transient'
    prepareSharedSession('platform')
    renderShell('/')

    expect(await screen.findByRole('heading', { name: 'Secure access is temporarily unavailable' })).toBeInTheDocument()
    expect(shared.scope).toBe('platform')
    const sharedSession = await import('../lib/sharedIdentitySession')
    expect(sharedSession.clearSharedIdentityServerSession).not.toHaveBeenCalled()
    expect(sharedSession.clearSharedIdentitySession).not.toHaveBeenCalled()
  })

  it('bounds stalled Supabase activation without clearing a valid shared session', async () => {
    vi.useFakeTimers()
    prepareSharedSession('platform')
    const supabase = await import('../lib/supabase')
    const activate = vi.mocked(supabase.activateSharedIdentitySupabaseSession)
    let activationSignal: AbortSignal | undefined
    activate.mockImplementationOnce((_token, _refreshToken, signal) => {
      activationSignal = signal
      return new Promise<never>(() => undefined)
    })

    const view = renderShell('/')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })

    expect(screen.getByRole('heading', { name: 'Secure access is temporarily unavailable' })).toBeInTheDocument()
    expect(activationSignal).toHaveProperty('aborted', true)
    expect(shared.scope).toBe('platform')
    const sharedSession = await import('../lib/sharedIdentitySession')
    expect(sharedSession.clearSharedIdentityServerSession).not.toHaveBeenCalled()
    expect(sharedSession.clearSharedIdentitySession).not.toHaveBeenCalled()
    view.unmount()
  })

  it('bounds stalled Supabase session acquisition and releases the cold-start check', async () => {
    vi.useFakeTimers()
    prepareSharedSession('platform')
    shared.authGetSessionPromise = new Promise(() => undefined)

    const view = renderShell('/')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })

    expect(screen.getByRole('heading', { name: 'Secure access is temporarily unavailable' })).toBeInTheDocument()
    expect(screen.queryByText('Platform home')).not.toBeInTheDocument()
    expect(shared.scope).toBe('platform')
    view.unmount()
  })

  it('does not commit delayed session context after another tab clears the shared session', async () => {
    prepareSharedSession('platform')
    const auth = await import('../data/auth')
    const getContext = vi.mocked(auth.getSessionContextWithSignal)
    let resolveContext: ((context: Awaited<ReturnType<typeof auth.getSessionContextWithSignal>>) => void) | undefined
    getContext.mockImplementationOnce(() => new Promise((resolve) => {
      resolveContext = resolve
    }))

    const { queryClient } = renderShell('/')
    await waitFor(() => expect(getContext).toHaveBeenCalledTimes(1))
    act(() => shared.browserListener?.('cleared'))
    expect(await screen.findByText('Native login')).toBeInTheDocument()

    await act(async () => {
      resolveContext?.({
        accessGeneration: 1,
        displayName: 'Stale Shared User',
        employeeId,
        hasMfa: false,
        mfaEnrolledAt: null,
        mfaRequired: true,
        mustChangePassword: false,
        passwordChangedAt: null,
        permissions: ['operations.view'],
        role: 'guard',
        timeZone: 'America/Denver',
        username: 'stale-shared-user',
      })
      await Promise.resolve()
    })

    expect(screen.getByText('Native login')).toBeInTheDocument()
    expect(screen.queryByText('Platform home')).not.toBeInTheDocument()
    expect(queryClient.getQueryData(['session-context'])).toBeUndefined()
  })

  it('does not recommit delayed session context after Supabase signs out', async () => {
    prepareSharedSession('platform')
    const { queryClient } = renderShell('/')
    expect(await screen.findByText('Platform home')).toBeInTheDocument()

    const auth = await import('../data/auth')
    const getContext = vi.mocked(auth.getSessionContextWithSignal)
    let resolveContext: ((context: Awaited<ReturnType<typeof auth.getSessionContextWithSignal>>) => void) | undefined
    getContext.mockImplementationOnce(() => new Promise((resolve) => {
      resolveContext = resolve
    }))
    window.dispatchEvent(new Event('sygshift:session-context-refresh'))
    await waitFor(() => expect(getContext).toHaveBeenCalledTimes(2))

    act(() => shared.authListener?.('SIGNED_OUT', null))
    expect(await screen.findByText('Native login')).toBeInTheDocument()
    await act(async () => {
      resolveContext?.({
        accessGeneration: 1,
        displayName: 'Stale Signed-out User',
        employeeId,
        hasMfa: false,
        mfaEnrolledAt: null,
        mfaRequired: true,
        mustChangePassword: false,
        passwordChangedAt: null,
        permissions: ['operations.view'],
        role: 'guard',
        timeZone: 'America/Denver',
        username: 'stale-signed-out-user',
      })
      await Promise.resolve()
    })

    expect(screen.getByText('Native login')).toBeInTheDocument()
    expect(screen.queryByText('Platform home')).not.toBeInTheDocument()
    expect(queryClient.getQueryData(['session-context'])).toBeUndefined()
  })

  it('ignores SIGNED_OUT emitted by the retired native client after a shared handoff', async () => {
    prepareSharedSession('platform')
    renderShell('/')
    expect(await screen.findByText('Platform home')).toBeInTheDocument()
    await waitFor(() => expect(shared.authListener).not.toBeNull())
    const { deactivateSharedIdentitySupabaseSession } = await import('../lib/supabase')
    vi.mocked(deactivateSharedIdentitySupabaseSession).mockClear()

    shared.authSourceActive = false
    act(() => shared.authListener?.('SIGNED_OUT', null))

    expect(screen.getByText('Platform home')).toBeInTheDocument()
    expect(screen.queryByText('Native login')).not.toBeInTheDocument()
    expect(shared.activeAccessToken).toBe(accessToken)
    expect(shared.scope).toBe('platform')
    expect(deactivateSharedIdentitySupabaseSession).not.toHaveBeenCalled()
  })

  it('runs a queued shared restore when it collides with a weaker context refresh', async () => {
    prepareSharedSession('platform')
    renderShell('/')
    expect(await screen.findByText('Platform home')).toBeInTheDocument()
    const auth = await import('../data/auth')
    const sharedSession = await import('../lib/sharedIdentitySession')
    const browserSync = await import('../lib/sharedIdentityBrowserSync')
    const getContext = vi.mocked(auth.getSessionContextWithSignal)
    const hydrate = vi.mocked(sharedSession.hydrateSharedIdentitySession)
    const publish = vi.mocked(browserSync.publishSharedIdentityBrowserEvent)
    hydrate.mockClear()
    publish.mockClear()
    let resolveContext: ((context: Awaited<ReturnType<typeof auth.getSessionContextWithSignal>>) => void) | undefined
    getContext.mockImplementationOnce(() => new Promise((resolve) => {
      resolveContext = resolve
    }))

    window.dispatchEvent(new Event('sygshift:session-context-refresh'))
    await waitFor(() => expect(resolveContext).toBeTypeOf('function'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(hydrate).not.toHaveBeenCalled()

    await act(async () => {
      resolveContext?.({
        accessGeneration: 1,
        displayName: 'Shared User',
        employeeId,
        hasMfa: false,
        mfaEnrolledAt: null,
        mfaRequired: true,
        mustChangePassword: false,
        passwordChangedAt: null,
        permissions: ['apps.sygilant.access', 'operations.view', 'time.view'],
        role: 'guard',
        timeZone: 'America/Denver',
        username: 'shareduser',
      })
      await Promise.resolve()
    })

    await waitFor(() => expect(hydrate).toHaveBeenCalledOnce())
    await waitFor(() => expect(publish).toHaveBeenCalledWith('updated'))
    expect(screen.getByText('Platform home')).toBeInTheDocument()
  })

  it('clears a stale recovery card when a retry reaches a terminal restore response', async () => {
    vi.useFakeTimers()
    shared.scope = 'platform'
    shared.hydrateError = new Error('temporary restore failure')
    const view = renderShell('/')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByRole('heading', { name: 'Secure access is temporarily unavailable' })).toBeInTheDocument()

    shared.hydrateError = new Error('deterministic restore failure')
    shared.hydrateTransient = false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })

    expect(screen.queryByRole('heading', { name: 'Secure access is temporarily unavailable' })).not.toBeInTheDocument()
    expect(screen.getByText('Native login')).toBeInTheDocument()
    expect(shared.scope).toBe('platform')
    const sharedSession = await import('../lib/sharedIdentitySession')
    expect(sharedSession.clearSharedIdentityServerSession).not.toHaveBeenCalled()
    expect(sharedSession.clearSharedIdentitySession).not.toHaveBeenCalled()
    view.unmount()
  })

  it('keeps the shell alert count limited to current operational alerts', async () => {
    shared.operationalWorkspace = {
      serverTimestamp: '2026-10-05T12:00:00.000Z',
      alerts: [
        operationalAlert('Current urgent alert', { liveUntil: '2026-10-05T13:00:00.000Z' }),
        operationalAlert('Current high alert', { id: '10000000-0000-4000-8000-000000000002', priority: 'high', liveUntil: '2026-10-05T13:00:00.000Z' }),
        operationalAlert('Expired alert', { id: '10000000-0000-4000-8000-000000000003', liveUntil: '2026-10-05T12:00:00.000Z' }),
        operationalAlert('Inactive alert', { id: '10000000-0000-4000-8000-000000000004', active: false }),
        operationalAlert('Resolved alert', { id: '10000000-0000-4000-8000-000000000005', lifecycleStatus: 'resolved' }),
      ],
    }
    prepareSharedSession('platform')
    renderShell('/')

    expect(await screen.findByText('Current urgent alert')).toBeVisible()
    expect(screen.getByLabelText('Alert 1 of 2')).toBeVisible()
    expect(screen.queryByText('Expired alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Inactive alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Resolved alert')).not.toBeInTheDocument()
  })

  it('renders an urgent employee-facing banner in the global workspace strip', async () => {
    shared.announcementBanners = [announcementBanner('System maintenance')]
    prepareSharedSession('platform')
    renderShell('/')

    expect(await screen.findByText('System maintenance')).toBeVisible()
    expect(screen.getByText('Maintenance is in progress.')).toBeVisible()
  })

  it('shows a plain-language global warning when banner alerts cannot be verified', async () => {
    shared.announcementBannerError = new Error('Unexpected validation details')
    prepareSharedSession('platform')
    renderShell('/')

    expect(await screen.findByText('Banner alerts unavailable')).toBeVisible()
    expect(screen.getByText('Current banner alerts could not be verified. Refresh the page or try again shortly.')).toBeVisible()
    expect(screen.queryByText('Unexpected validation details')).not.toBeInTheDocument()
  })

  it('switches scaled laptop viewports to the full-width navigation drawer without losing the saved desktop preference', async () => {
    const removeEventListener = vi.fn()
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: true,
      media: '(max-width: 1280px)',
      onchange: null,
      removeEventListener,
    })))
    localStorage.setItem('sygshift.sidebar.collapsed', 'true')
    prepareSharedSession('platform')
    const view = renderShell('/')

    expect(await screen.findByText('Platform home')).toBeInTheDocument()
    expect(view.container.querySelector('.app-shell')).toHaveClass('app-shell--compact-navigation')
    expect(view.container.querySelector('.app-shell')).not.toHaveClass('app-shell--sidebar-collapsed')
    expect(view.container.querySelector('.sidebar')).not.toHaveClass('sidebar--collapsed')
    expect(localStorage.getItem('sygshift.sidebar.collapsed')).toBe('true')
    view.unmount()
    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('deactivates the browser client and returns to login when Worker restoration reports revocation', async () => {
    prepareSharedSession('sygsphere')
    renderShell('/sygsphere')
    await screen.findByText('SygSphere workspace')
    shared.hydrateResult = null

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await waitFor(() => expect(screen.getByText('Native login')).toBeInTheDocument())
    expect(shared.activeAccessToken).toBeNull()
    const { deactivateSharedIdentitySupabaseSession } = await import('../lib/supabase')
    expect(deactivateSharedIdentitySupabaseSession).toHaveBeenCalled()
  })

  it('keeps an active shared session when Worker restoration is temporarily unavailable', async () => {
    prepareSharedSession('sygsphere')
    renderShell('/sygsphere')
    await screen.findByText('SygSphere workspace')
    vi.clearAllMocks()
    shared.hydrateError = new Error('temporary restore failure')

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(screen.getByText('SygSphere workspace')).toBeInTheDocument()
    expect(shared.activeAccessToken).toBe(accessToken)
    const { clearSharedIdentityServerSession, clearSharedIdentitySession } = await import('../lib/sharedIdentitySession')
    const { deactivateSharedIdentitySupabaseSession } = await import('../lib/supabase')
    expect(clearSharedIdentityServerSession).not.toHaveBeenCalled()
    expect(clearSharedIdentitySession).not.toHaveBeenCalled()
    expect(deactivateSharedIdentitySupabaseSession).not.toHaveBeenCalled()
  })

  it('keeps the shared restore retry scheduled after context succeeds and resets backoff after recovery', async () => {
    vi.useFakeTimers()
    prepareSharedSession('sygsphere')
    const view = renderShell('/sygsphere')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(shared.activeAccessToken).toBe(accessToken)

    const sharedSession = await import('../lib/sharedIdentitySession')
    const hydrate = vi.mocked(sharedSession.hydrateSharedIdentitySession)
    const recoveryDelay = vi.mocked(sharedSession.sharedIdentityRecoveryDelayMs)
    hydrate.mockClear()
    recoveryDelay.mockClear()
    shared.hydrateError = new Error('temporary restore failure')

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(hydrate).toHaveBeenCalledTimes(1)
    expect(recoveryDelay).toHaveBeenLastCalledWith(0, 2_000)

    shared.hydrateError = null
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999)
    })
    expect(hydrate).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(hydrate).toHaveBeenCalledTimes(2)

    shared.hydrateError = new Error('second temporary restore failure')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999)
    })
    expect(hydrate).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(hydrate).toHaveBeenCalledTimes(3)
    expect(recoveryDelay).toHaveBeenLastCalledWith(0, 2_000)

    view.unmount()
  })

  it('advances recovery backoff when restore succeeds but session context remains transiently unavailable', async () => {
    vi.useFakeTimers()
    prepareSharedSession('sygsphere')
    const view = renderShell('/sygsphere')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(shared.activeAccessToken).toBe(accessToken)

    const sharedSession = await import('../lib/sharedIdentitySession')
    const hydrate = vi.mocked(sharedSession.hydrateSharedIdentitySession)
    const recoveryDelay = vi.mocked(sharedSession.sharedIdentityRecoveryDelayMs)
    hydrate.mockClear()
    recoveryDelay.mockClear()
    shared.sessionContextError = new Error('connection pool timeout')

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(hydrate).toHaveBeenCalledTimes(1)
    expect(recoveryDelay).toHaveBeenLastCalledWith(0, null)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(hydrate).toHaveBeenCalledTimes(2)
    expect(recoveryDelay).toHaveBeenLastCalledWith(1, null)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(hydrate).toHaveBeenCalledTimes(3)
    expect(recoveryDelay).toHaveBeenLastCalledWith(2, null)

    view.unmount()
  })

  it('closes the workspace but preserves sign-in when centralized revalidation is transiently unavailable', async () => {
    prepareSharedSession('platform')
    renderShell('/')
    await screen.findByText('Platform home')
    vi.clearAllMocks()
    shared.sessionContextError = new Error('connection pool timeout')

    await act(async () => {
      window.dispatchEvent(new Event('sygshift:session-context-refresh'))
    })

    expect(await screen.findByRole('heading', { name: 'Secure access is temporarily unavailable' })).toBeInTheDocument()
    expect(screen.queryByText('Platform home')).not.toBeInTheDocument()
    expect(shared.activeAccessToken).toBe(accessToken)
    const { signOut } = await import('../data/auth')
    const { clearSharedIdentityServerSession } = await import('../lib/sharedIdentitySession')
    const { deactivateSharedIdentitySupabaseSession } = await import('../lib/supabase')
    expect(signOut).not.toHaveBeenCalled()
    expect(clearSharedIdentityServerSession).not.toHaveBeenCalled()
    expect(deactivateSharedIdentitySupabaseSession).not.toHaveBeenCalled()
  })

  it('does not open a verified workspace until the platform session registry accepts it', async () => {
    shared.emergencyRegistrationError = new Error('registry unavailable')
    prepareSharedSession('platform')
    renderShell('/')

    expect(await screen.findByRole('heading', { name: 'Secure access is temporarily unavailable' })).toBeInTheDocument()
    expect(screen.queryByText('Platform home')).not.toBeInTheDocument()
    expect(shared.activeAccessToken).toBe(accessToken)
    const { signOut } = await import('../data/auth')
    expect(signOut).not.toHaveBeenCalled()
  })

  it('preserves a native Auth session across a central context compatibility failure', async () => {
    shared.activeAccessToken = accessToken
    shared.sessionContextError = new Error('central context contract changed')
    shared.sessionContextFailureKind = 'compatibility'
    renderShell('/')

    expect(await screen.findByRole('heading', { name: 'Secure access is temporarily unavailable' })).toBeInTheDocument()
    expect(screen.queryByText('Platform home')).not.toBeInTheDocument()
    expect(shared.activeAccessToken).toBe(accessToken)
    const { signOut } = await import('../data/auth')
    expect(signOut).not.toHaveBeenCalled()
  })

  it('recovers a preserved login after a platform registry compatibility failure', async () => {
    shared.emergencyRegistrationError = new Error('registry response is from another compatible release')
    shared.emergencyRegistrationFailureKind = 'compatibility'
    prepareSharedSession('platform')
    renderShell('/')

    expect(await screen.findByRole('heading', { name: 'Secure access is temporarily unavailable' })).toBeInTheDocument()
    expect(shared.activeAccessToken).toBe(accessToken)

    shared.emergencyRegistrationError = null
    fireEvent.click(screen.getByRole('button', { name: 'Retry secure access' }))

    expect(await screen.findByText('Platform home')).toBeInTheDocument()
    const { signOut } = await import('../data/auth')
    expect(signOut).not.toHaveBeenCalled()
  })

  it('still destroys a native session when central context explicitly reports suspension', async () => {
    shared.activeAccessToken = accessToken
    shared.sessionContextError = new Error('access suspended')
    shared.sessionContextFailureKind = 'revoked'
    renderShell('/')

    expect(await screen.findByText('Native login')).toBeInTheDocument()
    const { signOut } = await import('../data/auth')
    expect(signOut).toHaveBeenCalledOnce()
    expect(screen.queryByRole('heading', { name: 'Secure access is temporarily unavailable' })).not.toBeInTheDocument()
  })

  it('still clears a shared session when the central registry explicitly reports revocation', async () => {
    shared.emergencyRegistrationError = new Error('access revoked')
    shared.emergencyRegistrationFailureKind = 'revoked'
    prepareSharedSession('platform')
    renderShell('/')

    expect(await screen.findByText('Native login')).toBeInTheDocument()
    const { clearSharedIdentityServerSession } = await import('../lib/sharedIdentitySession')
    expect(clearSharedIdentityServerSession).toHaveBeenCalledWith(accessToken)
    expect(shared.activeAccessToken).toBeNull()
  })

  it('purges Client Communications and session context caches when the authenticated session ends', async () => {
    shared.activeAccessToken = accessToken
    const { queryClient } = renderShell('/')
    await waitFor(() => expect(shared.authListener).not.toBeNull())

    const communicationsKey = ['client-communications', employeeId, 'workspace', 'all', '', 1, 20]
    const requiredActionKey = ['required-action-checkpoint', employeeId]
    queryClient.setQueryData(communicationsKey, { privatePreview: 'Employee A message' })
    queryClient.setQueryData(requiredActionKey, { blocking: true, items: [{ title: 'Private employee action' }] })
    queryClient.setQueryData(['session-context'], { employeeId })
    queryClient.setQueryData(['unrelated-cache'], { retained: true })

    act(() => shared.authListener?.('SIGNED_OUT', null))

    expect(queryClient.getQueryData(communicationsKey)).toBeUndefined()
    expect(queryClient.getQueryData(requiredActionKey)).toBeUndefined()
    expect(queryClient.getQueryData(['session-context'])).toBeUndefined()
    expect(queryClient.getQueryData(['unrelated-cache'])).toEqual({ retained: true })
  })
})

function prepareSharedSession(scope: 'platform' | 'sygsphere') {
  shared.scope = scope
  shared.hydrateResult = {
    accessToken,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    refreshToken: 'refresh-token',
    scope,
  }
}

function operationalAlert(
  title: string,
  overrides: Partial<OperationalWorkspaceFixture['alerts'][number]> = {},
): OperationalWorkspaceFixture['alerts'][number] {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    alertType: 'employee_call_off',
    priority: 'urgent',
    title,
    summary: `${title} summary`,
    employeeId,
    shiftId: '20000000-0000-4000-8000-000000000001',
    directPath: '/time/operations',
    createdAt: '2026-10-05T10:00:00.000Z',
    acknowledgedAt: null,
    active: true,
    lifecycleStatus: 'active_operations',
    ...overrides,
  }
}

function announcementBanner(title: string): AnnouncementBanner {
  return {
    id: '30000000-0000-4000-8000-000000000001',
    title,
    message: 'Maintenance is in progress.',
    tone: 'urgent',
    ctaLabel: null,
    ctaHref: null,
    audience: 'all',
    audienceRoles: [],
    active: true,
    lifecycleStatus: 'active',
    startsAt: '2026-10-27T13:00:00.000Z',
    expiresAt: '2026-10-28T13:00:00.000Z',
    canceledAt: null,
    createdAt: '2026-10-27T13:00:00.000Z',
    updatedAt: '2026-10-27T13:00:00.000Z',
  }
}

function renderShell(initialEntry: string) {
  window.history.replaceState({}, '', initialEntry)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<div>Platform home</div>} />
            <Route path="/actions" element={<div>Action Center workspace <Link to="/time">Attempt time route</Link></div>} />
            <Route path="/my-documents" element={<div>My Documents workspace</div>} />
            <Route path="/sygsphere" element={<div>SygSphere workspace <Link to="/time">Attempt time route</Link></div>} />
            <Route path="/time" element={<div>Time route</div>} />
          </Route>
          <Route path="/account-security" element={<div>Account security</div>} />
          <Route path="/login" element={<div>Native login</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...view, queryClient }
}
