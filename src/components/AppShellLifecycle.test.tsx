// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from './AppShell'

const employeeId = 'a25a5f5f-45b6-4e43-87a6-79298ed9347f'
const accessToken = 'header.eyJleHAiOjQxMDI0NDQ4MDAsInNlc3Npb25faWQiOiI3YzIxNzAxYS01NmVkLTRjNjQtOGM0Ny1jOWRjNTE2ZTQzOTgifQ.signature'

const shared = vi.hoisted(() => ({
  activeAccessToken: null as string | null,
  browserListener: null as ((action: 'cleared' | 'updated') => void) | null,
  hydrateResult: null as null | { accessToken: string; expiresAt: number; refreshToken: string; scope: 'platform' | 'sygsphere' },
  scope: null as null | 'platform' | 'sygsphere',
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
    if (shared.hydrateResult) shared.scope = shared.hydrateResult.scope
    return shared.hydrateResult
  }),
  sharedIdentityRefreshDelayMs: vi.fn(() => 60_000),
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
    shared.activeAccessToken = token
  }),
  deactivateSharedIdentitySupabaseSession: vi.fn(() => {
    shared.activeAccessToken = null
  }),
  getSupabaseClient: vi.fn(() => ({
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session: shared.activeAccessToken ? { access_token: shared.activeAccessToken } : null,
        },
      })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  })),
  isSupabaseConfigured: true,
}))

vi.mock('../data/auth', () => ({
  SESSION_CONTEXT_REFRESH_EVENT: 'sygshift:session-context-refresh',
  authSessionIdFromAccessToken: vi.fn(() => '7c21701a-56ed-4c64-8c47-c9dc516e4398'),
  getSessionContext: vi.fn(async () => ({
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
  })),
  recordCompletedSignInWithRetry: vi.fn(async () => undefined),
  signOut: vi.fn(async () => undefined),
}))

vi.mock('../data/announcements', () => ({ getActiveAnnouncementBanners: vi.fn(async () => []) }))
vi.mock('../data/timeOperations', () => ({ getTimekeepingOperationsWorkspace: vi.fn(async () => ({ alerts: [] })) }))
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
  shared.browserListener = null
  shared.hydrateResult = null
  shared.scope = null
  localStorage.clear()
  sessionStorage.clear()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  window.scrollTo = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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

function renderShell(initialEntry: string) {
  window.history.replaceState({}, '', initialEntry)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<div>Platform home</div>} />
            <Route path="/sygsphere" element={<div>SygSphere workspace <Link to="/time">Attempt time route</Link></div>} />
            <Route path="/time" element={<div>Time route</div>} />
          </Route>
          <Route path="/account-security" element={<div>Account security</div>} />
          <Route path="/login" element={<div>Native login</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
