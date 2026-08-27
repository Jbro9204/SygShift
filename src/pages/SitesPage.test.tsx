import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionContext } from '../data/auth'
import type { Site } from '../data/workforce'
import { SitesPage } from './SitesPage'
import {
  filterSites,
  postCountLabel,
  postCoverageTime,
  siteAddress,
  siteCoverageLabel,
} from './sitesDirectory'

const authMocks = vi.hoisted(() => ({
  getSessionContext: vi.fn(),
}))

const workforceMocks = vi.hoisted(() => ({
  deleteUnusedPost: vi.fn(),
  deleteUnusedSite: vi.fn(),
  getRecentlyDeletedSitesAndPosts: vi.fn(),
  getSites: vi.fn(),
  upsertPost: vi.fn(),
  upsertSite: vi.fn(),
}))

vi.mock('../data/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/auth')>()
  return { ...actual, getSessionContext: authMocks.getSessionContext }
})

vi.mock('../data/workforce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/workforce')>()
  return { ...actual, ...workforceMocks }
})

vi.mock('../lib/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/supabase')>()
  return { ...actual, isSupabaseConfigured: true }
})

const sites: Site[] = [
  {
    active: true,
    address_line_1: '100 Main Street',
    city: 'Denver',
    code: 'MAIN',
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Main Campus',
    postal_code: '80202',
    posts: [
      {
        active: true,
        default_end_time: '18:00:00',
        default_start_time: '06:00:00',
        id: '21111111-1111-4111-8111-111111111111',
        name: 'Front Desk',
        requires_armed: false,
      },
      {
        active: true,
        default_end_time: null,
        default_start_time: null,
        id: '21111111-1111-4111-8111-222222222222',
        name: 'Parking Patrol',
        requires_armed: true,
      },
    ],
    region: 'CO',
    time_zone: 'America/Denver',
  },
  {
    active: false,
    address_line_1: null,
    city: 'Aurora',
    code: 'ANNEX',
    id: '11111111-1111-4111-8111-222222222222',
    name: 'Annex',
    postal_code: null,
    posts: [],
    region: 'CO',
    time_zone: 'America/Denver',
  },
]

function session(permissions: string[]): SessionContext {
  return {
    displayName: 'Jordan Brown',
    employeeId: '31111111-1111-4111-8111-111111111111',
    hasMfa: true,
    mfaEnrolledAt: '2026-08-01T12:00:00Z',
    mfaRequired: true,
    mustChangePassword: false,
    passwordChangedAt: '2026-08-01T12:00:00Z',
    permissions,
    role: 'admin',
    username: 'jbrown',
  }
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SitesPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  HTMLDialogElement.prototype.showModal = vi.fn(function showModal(
    this: HTMLDialogElement,
  ) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function close(
    this: HTMLDialogElement,
  ) {
    this.open = false
  })
  authMocks.getSessionContext.mockResolvedValue(
    session(['sites.view', 'sites.manage']),
  )
  workforceMocks.getRecentlyDeletedSitesAndPosts.mockResolvedValue([])
  workforceMocks.getSites.mockResolvedValue(sites)
  workforceMocks.deleteUnusedPost.mockResolvedValue(sites)
  workforceMocks.deleteUnusedSite.mockResolvedValue(sites)
  workforceMocks.upsertPost.mockResolvedValue(sites)
  workforceMocks.upsertSite.mockResolvedValue(sites)
})

describe('Sites & Posts directory', () => {
  it('formats directory summaries without losing coverage information', () => {
    expect(siteAddress(sites[0])).toBe('100 Main Street Denver, CO 80202')
    expect(siteCoverageLabel(sites[0])).toBe('1 armed · 1 unarmed')
    expect(postCountLabel(2)).toBe('2 posts +')
    expect(postCountLabel(1, true)).toBe('1 post −')
    expect(postCoverageTime(sites[0].posts[0])).toBe(
      '6:00 AM (06:00) – 6:00 PM (18:00)',
    )
    expect(postCoverageTime(sites[0].posts[1])).toBe('Time set per shift')
  })

  it('searches all operational fields and applies the site status filter', () => {
    expect(
      filterSites(sites, 'front desk', 'all').map((site) => site.name),
    ).toEqual(['Main Campus'])
    expect(
      filterSites(sites, 'aurora', 'all').map((site) => site.name),
    ).toEqual(['Annex'])
    expect(filterSites(sites, '', 'active').map((site) => site.name)).toEqual([
      'Main Campus',
    ])
    expect(filterSites(sites, '', 'inactive').map((site) => site.name)).toEqual(
      ['Annex'],
    )
  })

  it('keeps only one site expanded and exposes the correct accessible state', async () => {
    renderPage()

    const mainToggle = await screen.findByRole('button', {
      name: 'Expand Main Campus posts',
    })
    fireEvent.click(mainToggle)
    expect(
      screen.getByRole('region', { name: 'Main Campus details' }),
    ).toBeVisible()
    expect(mainToggle).toHaveAttribute('aria-expanded', 'true')

    const annexToggle = screen.getByRole('button', {
      name: 'Expand Annex posts',
    })
    fireEvent.click(annexToggle)
    expect(
      screen.queryByRole('region', { name: 'Main Campus details' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Annex details' })).toBeVisible()
    expect(annexToggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('opens Add Post with the parent site already fixed and visible', async () => {
    renderPage()

    fireEvent.click(
      await screen.findByRole('button', { name: 'Expand Main Campus posts' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add post' }))

    expect(screen.getByRole('dialog', { name: 'Add post' })).toBeVisible()
    expect(screen.getByText('Parent site')).toBeVisible()
    expect(screen.getByText('Main Campus · MAIN')).toBeVisible()
  })

  it('preserves every Add Site field and submits through the existing mutation', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Add Site' }))
    fireEvent.change(screen.getByLabelText('Site name'), {
      target: { value: 'West Annex' },
    })
    fireEvent.change(screen.getByLabelText(/Site code/), {
      target: { value: 'WEST' },
    })
    fireEvent.change(screen.getByLabelText('Address'), {
      target: { value: '200 West Street' },
    })
    fireEvent.change(screen.getByLabelText('City'), {
      target: { value: 'Lakewood' },
    })
    fireEvent.change(screen.getByLabelText('State/region'), {
      target: { value: 'CO' },
    })
    fireEvent.change(screen.getByLabelText('Postal code'), {
      target: { value: '80226' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save site' }))

    await waitFor(() => expect(workforceMocks.upsertSite).toHaveBeenCalled())
    expect(workforceMocks.upsertSite.mock.calls[0][0]).toEqual({
      active: true,
      addressLine1: '200 West Street',
      city: 'Lakewood',
      code: 'WEST',
      name: 'West Annex',
      postalCode: '80226',
      region: 'CO',
      siteId: undefined,
      timeZone: 'America/Denver',
    })
  })

  it('submits a new post for the expanded parent without asking for the site again', async () => {
    renderPage()

    fireEvent.click(
      await screen.findByRole('button', { name: 'Expand Main Campus posts' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add post' }))
    fireEvent.change(screen.getByLabelText('Post name'), {
      target: { value: 'East Gate' },
    })
    fireEvent.change(screen.getByLabelText(/Default start/), {
      target: { value: '18:00' },
    })
    fireEvent.change(screen.getByLabelText(/Default end/), {
      target: { value: '06:00' },
    })
    fireEvent.click(screen.getByLabelText('Armed post'))
    fireEvent.click(screen.getByRole('button', { name: 'Save post' }))

    await waitFor(() => expect(workforceMocks.upsertPost).toHaveBeenCalled())
    expect(workforceMocks.upsertPost.mock.calls[0][0]).toEqual({
      active: true,
      defaultEndTime: '06:00',
      defaultStartTime: '18:00',
      name: 'East Gate',
      postId: undefined,
      requiresArmed: true,
      siteId: sites[0].id,
    })
  })

  it('keeps all write controls hidden when sites.manage is not effective', async () => {
    authMocks.getSessionContext.mockResolvedValue(session(['sites.view']))
    renderPage()

    await screen.findByText('Main Campus')
    expect(
      screen.queryByRole('button', { name: 'Add Site' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Manage Main Campus' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Recently Deleted/i }),
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Expand Main Campus posts' }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('region', { name: 'Main Campus details' }),
      ).toBeVisible(),
    )
    expect(
      screen.queryByRole('button', { name: 'Add post' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Edit Front Desk' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Delete Front Desk' }),
    ).not.toBeInTheDocument()
  })

  it('keeps protected site deletion behind Manage and blocks sites with posts', async () => {
    renderPage()

    fireEvent.click(
      await screen.findByRole('button', { name: 'Manage Main Campus' }),
    )

    const protectedDelete = screen.getByRole('button', { name: 'Delete site' })
    expect(protectedDelete).toBeDisabled()
    expect(
      screen.getByText(
        'Delete or otherwise resolve this site’s posts before deleting the site.',
      ),
    ).toBeVisible()
    expect(workforceMocks.deleteUnusedSite).not.toHaveBeenCalled()
  })

  it('uses the existing protected deletion operation for an unused site', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Manage Annex' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete site' }))

    await waitFor(() =>
      expect(workforceMocks.deleteUnusedSite).toHaveBeenCalled(),
    )
    expect(workforceMocks.deleteUnusedSite.mock.calls[0][0]).toBe(sites[1].id)
    confirm.mockRestore()
  })

  it('shows retained deletion metadata without inventing restoration controls', async () => {
    workforceMocks.getRecentlyDeletedSitesAndPosts.mockResolvedValue([
      {
        deletedAt: '2026-08-20T18:30:00Z',
        deletedBy: null,
        displayName: 'Legacy Gate',
        expiresAt: '2026-09-03T18:30:00Z',
        id: '41111111-1111-4111-8111-111111111111',
        metadata: {},
        recordId: '51111111-1111-4111-8111-111111111111',
        recordType: 'post',
      },
    ])
    renderPage()

    fireEvent.click(
      await screen.findByRole('button', { name: /Recently Deleted/i }),
    )

    expect(
      screen.getByRole('dialog', {
        name: 'Recently deleted sites and posts',
      }),
    ).toBeVisible()
    expect(screen.getByText('Legacy Gate')).toBeVisible()
    expect(screen.getByText('14-day retention')).toBeVisible()
    expect(
      screen.getByText('No restoration controls are available in this workflow.'),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: /restore/i }),
    ).not.toBeInTheDocument()
  })
})
