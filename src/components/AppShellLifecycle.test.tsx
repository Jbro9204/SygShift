// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isOperationalAlertLive } from '../data/timeOperations'
import { advanceServerTimestamp } from '../lib/operationalAlertClock'
import { AppShell } from './AppShell'

const employeeId = 'a25a5f5f-45b6-4e43-87a6-79298ed9347f'
const authUserId = 'b25a5f5f-45b6-4e43-87a6-79298ed9347f'
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
    data: { session: { access_token: string; user: { id: string } } | null }
    error?: Error | null
  }> | null,
  authUserId: 'b25a5f5f-45b6-4e43-87a6-79298ed9347f',
  authSourceActive: true,
  authListener: null as null | ((event: string, session: { access_token: string; user: { id: string } } | null) => void),
  browserListener: null as ((action: 'cleared' | 'updated') => void) | null,
  hydrateError: null as Error | null,
  hydrateTransient: true,
  hydrateResult: null as null | { accessToken: string; expiresAt: number; refreshToken: string; scope: 'platform' | 'sygsphere' },
  operationalWorkspaceError: null as Error | null,
  operationalWorkspace: { alerts: [], serverTimestamp: '2026-10-05T12:00:00.000Z' } as OperationalWorkspaceFixture,
  requiredActionBlocking: false,
  requiredActionError: null as Error | null,
  scope: null as null | 'platform' | 'sygsphere',
  sessionContextError: null as Error | null,
  sessionContextTransient: true,
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
          session: shared.activeAccessToken
            ? { access_token: shared.activeAccessToken, user: { id: shared.authUserId } }
            : null,
        },
        error: null,
      }),
      onAuthStateChange: vi.fn((listener: (event: string, session: { access_token: string; user: { id: string } } | null) => void) => {
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
  LOCAL_SIGN_OUT_BARRIER_EVENT: 'sygshift:local-sign-out-barrier-change',
  LOCAL_SIGN_OUT_BARRIER_STORAGE_KEY: 'sygshift:local-sign-out-barrier:v1',
  SESSION_CONTEXT_REFRESH_EVENT: 'sygshift:session-context-refresh',
  authSessionIdFromAccessToken: vi.fn(() => '7c21701a-56ed-4c64-8c47-c9dc516e4398'),
  beginLocalSignOutBarrier: vi.fn(() => {
    window.localStorage.setItem('sygshift:local-sign-out-barrier:v1', 'blocked')
    window.dispatchEvent(new Event('sygshift:local-sign-out-barrier-change'))
  }),
  clearPendingTotpEnrollment: vi.fn(() => window.sessionStorage.removeItem('sygshift:totp-setup')),
  getSessionContext: vi.fn(async () => {
    if (shared.sessionContextError) throw shared.sessionContextError
    return {
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
  hasLocalSignOutBarrier: vi.fn(() => window.localStorage.getItem('sygshift:local-sign-out-barrier:v1') === 'blocked'),
  isTransientSessionContextError: vi.fn((error: unknown) => (
    shared.sessionContextTransient && error === shared.sessionContextError
  )),
  recordCompletedSignInWithRetry: vi.fn(async () => undefined),
  signOut: vi.fn(async (_options?: { sharedIdentityServerSessionCleared?: boolean }) => {
    window.localStorage.removeItem('sygshift:local-sign-out-barrier:v1')
    window.dispatchEvent(new Event('sygshift:local-sign-out-barrier-change'))
  }),
}))

vi.mock('../data/announcements', () => ({ getActiveAnnouncementBanners: vi.fn(async () => []) }))
vi.mock('../data/timeOperations', async (loadOriginal) => ({
  ...await loadOriginal<typeof import('../data/timeOperations')>(),
  getTimekeepingOperationsWorkspace: vi.fn(async () => {
    if (shared.operationalWorkspaceError) throw shared.operationalWorkspaceError
    return shared.operationalWorkspace
  }),
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
vi.mock('../lib/time', async (loadOriginal) => ({
  ...await loadOriginal<typeof import('../lib/time')>(),
  lastCompletedPayrollWeek: vi.fn(() => ({ fromLabel: '09/01/2026', throughLabel: '09/07/2026' })),
}))
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
vi.mock('./OperationalTimeHeader', () => ({
  OperationalTimeHeader: ({ accountControls }: { accountControls?: React.ReactNode }) => <header>Header{accountControls}</header>,
}))
vi.mock('./HeaderNotificationButton', () => ({ HeaderNotificationButton: () => null }))
vi.mock('./LiveNotifications', () => ({ LiveNotifications: () => null }))

beforeEach(() => {
  shared.activeAccessToken = null
  shared.activationError = null
  shared.activationFailureKind = 'transient'
  shared.authGetSessionPromise = null
  shared.authUserId = authUserId
  shared.authListener = null
  shared.authSourceActive = true
  shared.browserListener = null
  shared.hydrateError = null
  shared.hydrateTransient = true
  shared.hydrateResult = null
  shared.operationalWorkspaceError = null
  shared.operationalWorkspace = { alerts: [], serverTimestamp: '2026-10-05T12:00:00.000Z' }
  shared.requiredActionBlocking = false
  shared.requiredActionError = null
  shared.scope = null
  shared.sessionContextError = null
  shared.sessionContextTransient = true
  localStorage.clear()
  sessionStorage.clear()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  window.scrollTo = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.restoreAllMocks()
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

  it('realigns attendance alert queries to verified server time when the device date is wrong', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-04T12:00:00.000Z'))
    shared.operationalWorkspace = { alerts: [], serverTimestamp: '2026-10-05T12:00:00.000Z' }
    const timeOperations = await import('../data/timeOperations')
    const getWorkspace = vi.mocked(timeOperations.getTimekeepingOperationsWorkspace)
    prepareSharedSession('platform')
    renderShell('/')

    await screen.findByText('Platform home')
    await waitFor(() => {
      expect(getWorkspace).toHaveBeenCalledWith('2026-10-04', '2026-10-04')
      expect(getWorkspace).toHaveBeenCalledWith('2026-10-05', '2026-10-05')
    })
  })

  it('locks the workspace instead of claiming success when local sign out fails', async () => {
    const user = userEvent.setup()
    const auth = await import('../data/auth')
    vi.mocked(auth.signOut).mockRejectedValueOnce(new Error('Your local browser session could not be cleared.'))
    prepareSharedSession('platform')
    renderShell('/')

    await screen.findByText('Platform home')
    await user.click(screen.getByRole('button', { name: 'Sign Out' }))

    expect(await screen.findByRole('heading', { name: 'Sign out could not be completed' })).toBeInTheDocument()
    expect(screen.queryByText('Platform home')).not.toBeInTheDocument()
    expect(screen.queryByText('Native login')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try sign out again' })).toBeEnabled()
  })

  it('keeps a failed local sign-out locked after reload and propagates the lock across tabs', async () => {
    const auth = await import('../data/auth')
    localStorage.setItem('sygshift:local-sign-out-barrier:v1', 'blocked')
    prepareSharedSession('platform')
    const firstView = renderShell('/')

    expect(await screen.findByRole('heading', { name: 'Sign out could not be completed' })).toBeInTheDocument()
    expect(screen.queryByText('Platform home')).not.toBeInTheDocument()
    expect(vi.mocked(auth.getSessionContextWithSignal)).not.toHaveBeenCalled()

    firstView.unmount()
    cleanup()
    localStorage.removeItem('sygshift:local-sign-out-barrier:v1')
    prepareSharedSession('platform')
    renderShell('/')
    expect(await screen.findByText('Platform home')).toBeInTheDocument()

    localStorage.setItem('sygshift:local-sign-out-barrier:v1', 'blocked')
    fireEvent(window, new StorageEvent('storage', {
      key: 'sygshift:local-sign-out-barrier:v1',
      newValue: 'blocked',
    }))

    expect(await screen.findByRole('heading', { name: 'Sign out could not be completed' })).toBeInTheDocument()
    expect(screen.queryByText('Platform home')).not.toBeInTheDocument()
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
      await vi.advanceTimersByTimeAsync(100)
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

    await waitFor(() => expect(screen.getByText('Current urgent alert')).toBeVisible())
    expect(screen.getByLabelText('Alert 1 of 2')).toBeVisible()
    expect(screen.queryByText('Expired alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Inactive alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Resolved alert')).not.toBeInTheDocument()
  })

  it('advances a successful server timestamp using elapsed client time', () => {
    const advancedTimestamp = advanceServerTimestamp(
      '2026-10-05T12:00:00.000Z',
      Date.parse('2026-10-05T12:00:05.000Z'),
      Date.parse('2026-10-05T12:00:35.000Z'),
    )
    const alert = operationalAlert('Brief urgent alert', { liveUntil: '2026-10-05T12:00:10.000Z' })

    expect(advancedTimestamp).toBe('2026-10-05T12:00:30.000Z')
    expect(isOperationalAlertLive(alert, '2026-10-05T12:00:00.000Z')).toBe(true)
    expect(isOperationalAlertLive(alert, advancedTimestamp)).toBe(false)
  })

  it('derives elapsed server time from a monotonic clock instead of a corrected device clock', () => {
    const deviceClock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2036-10-05T12:00:35.000Z'))

    expect(advanceServerTimestamp('2026-10-05T12:00:00.000Z', 5_000, 35_000))
      .toBe('2026-10-05T12:00:30.000Z')
    expect(deviceClock).not.toHaveBeenCalled()
  })

  it('uses the operational date and refreshes it after operational midnight', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-05T05:59:55.000Z')
    prepareSharedSession('platform')
    const view = renderShell('/')
    const { getTimekeepingOperationsWorkspace } = await import('../data/timeOperations')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(getTimekeepingOperationsWorkspace).toHaveBeenCalledWith('2026-10-04', '2026-10-04')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(getTimekeepingOperationsWorkspace).toHaveBeenCalledWith('2026-10-05', '2026-10-05')
    view.unmount()
  })

  it('hides previously loaded attendance facts when alert verification fails', async () => {
    shared.operationalWorkspace = {
      serverTimestamp: '2026-10-05T12:00:00.000Z',
      alerts: [operationalAlert('Previously verified urgent alert', { liveUntil: '2026-10-05T13:00:00.000Z' })],
    }
    prepareSharedSession('platform')
    const { queryClient } = renderShell('/')

    await waitFor(() => expect(screen.getByText('Previously verified urgent alert')).toBeVisible())
    shared.operationalWorkspaceError = new Error('attendance service unavailable')
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['time-operations-shell-alerts'] })
    })

    expect(await screen.findByText(/Attendance alerts could not be verified/)).toBeVisible()
    expect(screen.queryByText('Previously verified urgent alert')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Retry alerts' })).toHaveLength(1)
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

  it('does not sign out an authenticated user when session context has a transient connection failure', async () => {
    prepareSharedSession('platform')
    renderShell('/')
    await screen.findByText('Platform home')
    vi.clearAllMocks()
    shared.sessionContextError = new Error('connection pool timeout')

    await act(async () => {
      window.dispatchEvent(new Event('sygshift:session-context-refresh'))
    })

    expect(screen.getByText('Platform home')).toBeInTheDocument()
    expect(shared.activeAccessToken).toBe(accessToken)
    const { signOut } = await import('../data/auth')
    const { clearSharedIdentityServerSession } = await import('../lib/sharedIdentitySession')
    const { deactivateSharedIdentitySupabaseSession } = await import('../lib/supabase')
    expect(signOut).not.toHaveBeenCalled()
    expect(clearSharedIdentityServerSession).not.toHaveBeenCalled()
    expect(deactivateSharedIdentitySupabaseSession).not.toHaveBeenCalled()
  })

  it('locks and purges a previously verified workspace when terminal account verification and local sign out both fail', async () => {
    const auth = await import('../data/auth')
    vi.mocked(auth.getSessionContextWithSignal).mockResolvedValueOnce({
      displayName: 'Native User',
      employeeId,
      hasMfa: true,
      mfaEnrolledAt: '2026-01-01T00:00:00.000Z',
      mfaRequired: true,
      mustChangePassword: false,
      passwordChangedAt: '2026-01-01T00:00:00.000Z',
      permissions: ['actions.self.view', 'operations.view', 'time.view'],
      role: 'guard',
      timeZone: 'America/Denver',
      username: 'nativeuser',
    })
    shared.activeAccessToken = accessToken
    const { queryClient } = renderShell('/')
    expect(await screen.findByText('Platform home')).toBeInTheDocument()
    queryClient.setQueryData(['employee-private-record'], { employeeId, note: 'private' })

    vi.mocked(auth.signOut).mockRejectedValueOnce(new Error('local browser credential cleanup failed'))
    shared.sessionContextError = new Error('employee link removed')
    shared.sessionContextTransient = false

    await act(async () => {
      window.dispatchEvent(new Event('sygshift:session-context-refresh'))
    })

    expect(await screen.findByRole('heading', { name: 'Sign out could not be completed' })).toBeInTheDocument()
    expect(screen.queryByText('Platform home')).not.toBeInTheDocument()
    expect(screen.queryByText('Native login')).not.toBeInTheDocument()
    expect(queryClient.getQueryData(['employee-private-record'])).toBeUndefined()
    expect(screen.getByText(/account is no longer authorized/)).toBeInTheDocument()
  })

  it('sets the browser-wide sign-out barrier before shared revocation and keeps reloads and sibling tabs locked when revocation fails', async () => {
    prepareSharedSession('platform')
    const firstView = renderShell('/')
    expect(await screen.findByText('Platform home')).toBeInTheDocument()

    const auth = await import('../data/auth')
    const sharedSession = await import('../lib/sharedIdentitySession')
    const { deactivateSharedIdentitySupabaseSession } = await import('../lib/supabase')
    const clearQueries = vi.spyOn(firstView.queryClient, 'clear')
    sessionStorage.setItem('sygshift:totp-setup', JSON.stringify({ secret: 'pending-enrollment' }))
    vi.mocked(sharedSession.clearSharedIdentityServerSession).mockRejectedValueOnce(new Error('shared revocation unavailable'))
    shared.sessionContextError = new Error('employee link removed')
    shared.sessionContextTransient = false

    await act(async () => {
      window.dispatchEvent(new Event('sygshift:session-context-refresh'))
    })

    expect(await screen.findByRole('heading', { name: 'Sign out could not be completed' })).toBeInTheDocument()
    expect(localStorage.getItem('sygshift:local-sign-out-barrier:v1')).toBe('blocked')
    expect(vi.mocked(auth.beginLocalSignOutBarrier).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sharedSession.clearSharedIdentityServerSession).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )
    expect(sharedSession.clearSharedIdentityServerSession).toHaveBeenCalledWith(accessToken)
    expect(auth.signOut).not.toHaveBeenCalled()
    expect(screen.queryByText('Platform home')).not.toBeInTheDocument()
    expect(deactivateSharedIdentitySupabaseSession).toHaveBeenCalled()
    expect(sharedSession.clearSharedIdentitySession).toHaveBeenCalled()
    expect(shared.activeAccessToken).toBeNull()
    expect(shared.scope).toBeNull()
    expect(sessionStorage.getItem('sygshift:totp-setup')).toBeNull()
    expect(vi.mocked(deactivateSharedIdentitySupabaseSession).mock.invocationCallOrder[0]).toBeLessThan(
      clearQueries.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )
    expect(vi.mocked(sharedSession.clearSharedIdentitySession).mock.invocationCallOrder[0]).toBeLessThan(
      clearQueries.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )

    firstView.unmount()
    cleanup()
    vi.clearAllMocks()
    shared.sessionContextError = null
    prepareSharedSession('platform')
    renderShell('/')
    expect(await screen.findByRole('heading', { name: 'Sign out could not be completed' })).toBeInTheDocument()
    expect(auth.getSessionContextWithSignal).not.toHaveBeenCalled()
    expect(shared.activeAccessToken).toBeNull()
    expect(shared.scope).toBeNull()

    fireEvent(window, new StorageEvent('storage', {
      key: 'sygshift:local-sign-out-barrier:v1',
      newValue: 'blocked',
    }))
    expect(await screen.findByRole('heading', { name: 'Sign out could not be completed' })).toBeInTheDocument()
    expect(screen.queryByText('Platform home')).not.toBeInTheDocument()
  })

  it('purges every cached query and pending enrollment secret when the authenticated session ends', async () => {
    shared.activeAccessToken = accessToken
    const { queryClient } = renderShell('/')
    await waitFor(() => expect(shared.authListener).not.toBeNull())
    const { getSecurityKeySessionToken, setSecurityKeySession } = await import('../lib/securityKeySession')

    const communicationsKey = ['client-communications', employeeId, 'workspace', 'all', '', 1, 20]
    const requiredActionKey = ['required-action-checkpoint', employeeId]
    queryClient.setQueryData(communicationsKey, { privatePreview: 'Employee A message' })
    queryClient.setQueryData(requiredActionKey, { blocking: true, items: [{ title: 'Private employee action' }] })
    queryClient.setQueryData(['session-context'], { employeeId })
    queryClient.setQueryData(['unrelated-cache'], { retained: true })
    queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => ({ privateResult: employeeId }),
      mutationKey: ['employee-private-mutation'],
    })
    sessionStorage.setItem('sygshift:totp-setup', JSON.stringify({ secret: 'private-enrollment-secret' }))
    setSecurityKeySession('employee-a-security-key', '2099-01-01T00:00:00.000Z')

    act(() => shared.authListener?.('SIGNED_OUT', null))

    expect(queryClient.getQueryData(communicationsKey)).toBeUndefined()
    expect(queryClient.getQueryData(requiredActionKey)).toBeUndefined()
    expect(queryClient.getQueryData(['session-context'])).toBeUndefined()
    expect(queryClient.getQueryData(['unrelated-cache'])).toBeUndefined()
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0)
    expect(sessionStorage.getItem('sygshift:totp-setup')).toBeNull()
    expect(getSecurityKeySessionToken()).toBeNull()
  })

  it('refreshes a repeated same-user SIGNED_IN event without clearing cache or remounting the workspace', async () => {
    const auth = await import('../data/auth')
    const getContext = vi.mocked(auth.getSessionContextWithSignal)
    getContext.mockResolvedValue({
      displayName: 'Native User',
      employeeId,
      hasMfa: true,
      mfaEnrolledAt: '2026-01-01T00:00:00.000Z',
      mfaRequired: true,
      mustChangePassword: false,
      passwordChangedAt: '2026-01-01T00:00:00.000Z',
      permissions: ['actions.self.view', 'operations.view', 'time.view'],
      role: 'guard',
      timeZone: 'America/Denver',
      username: 'nativeuser',
    })
    shared.activeAccessToken = accessToken
    const { queryClient } = renderShell('/')
    expect(await screen.findByText('Platform home')).toBeInTheDocument()
    await waitFor(() => expect(shared.authListener).not.toBeNull())
    const callsBeforeRefresh = getContext.mock.calls.length
    queryClient.setQueryData(['employee-private-cache'], { retainedForSameUser: true })

    act(() => shared.authListener?.('SIGNED_IN', {
      access_token: accessToken,
      user: { id: authUserId },
    }))

    expect(screen.getByText('Platform home')).toBeInTheDocument()
    expect(screen.queryByText('Checking secure access…')).not.toBeInTheDocument()
    expect(queryClient.getQueryData(['employee-private-cache'])).toEqual({ retainedForSameUser: true })
    await waitFor(() => expect(getContext.mock.calls.length).toBeGreaterThan(callsBeforeRefresh))
  })

  it('purges all cached employee state and TOTP setup when SIGNED_IN changes accounts', async () => {
    const auth = await import('../data/auth')
    const pushNotifications = await import('../data/pushNotifications')
    const { getSecurityKeySessionToken, setSecurityKeySession } = await import('../lib/securityKeySession')
    vi.mocked(auth.getSessionContextWithSignal).mockResolvedValue({
      displayName: 'Native User',
      employeeId,
      hasMfa: true,
      mfaEnrolledAt: '2026-01-01T00:00:00.000Z',
      mfaRequired: true,
      mustChangePassword: false,
      passwordChangedAt: '2026-01-01T00:00:00.000Z',
      permissions: ['actions.self.view', 'operations.view', 'time.view'],
      role: 'guard',
      timeZone: 'America/Denver',
      username: 'nativeuser',
    })
    shared.activeAccessToken = accessToken
    const { queryClient } = renderShell('/')
    expect(await screen.findByText('Platform home')).toBeInTheDocument()
    await waitFor(() => expect(shared.authListener).not.toBeNull())
    queryClient.setQueryData(['employee-private-cache'], { employeeId })
    sessionStorage.setItem('sygshift:totp-setup', JSON.stringify({ secret: 'employee-a-secret' }))
    setSecurityKeySession('employee-a-security-key', '2099-01-01T00:00:00.000Z')

    act(() => shared.authListener?.('SIGNED_IN', {
      access_token: 'employee-b-access-token',
      user: { id: 'c25a5f5f-45b6-4e43-87a6-79298ed9347f' },
    }))

    expect(queryClient.getQueryData(['employee-private-cache'])).toBeUndefined()
    expect(sessionStorage.getItem('sygshift:totp-setup')).toBeNull()
    expect(getSecurityKeySessionToken()).toBeNull()
    expect(pushNotifications.clearPushSession).toHaveBeenCalledOnce()
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
