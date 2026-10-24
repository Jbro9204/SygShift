import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SharedIdentityCallbackPage } from './SharedIdentityCallbackPage'
import {
  clearSharedIdentitySession,
  getSharedIdentitySessionScope,
  getSharedIdentitySessionToken,
} from '../lib/sharedIdentitySession'

const supabaseMocks = vi.hoisted(() => ({
  activateSharedIdentitySupabaseSession: vi.fn(async () => undefined),
  deactivateSharedIdentitySupabaseSession: vi.fn(),
}))

const browserSyncMocks = vi.hoisted(() => ({
  listener: null as null | ((action: 'cleared' | 'updated') => void),
  publishSharedIdentityBrowserEvent: vi.fn(),
}))

vi.mock('../lib/supabase', () => supabaseMocks)
vi.mock('../lib/sharedIdentityBrowserSync', () => ({
  publishSharedIdentityBrowserEvent: browserSyncMocks.publishSharedIdentityBrowserEvent,
  subscribeToSharedIdentityBrowserEvents: vi.fn((listener: (action: 'cleared' | 'updated') => void) => {
    browserSyncMocks.listener = listener
    return () => {
      if (browserSyncMocks.listener === listener) browserSyncMocks.listener = null
    }
  }),
}))

const sharedIdentityToken = 'shared-token'.repeat(5)

afterEach(() => {
  clearSharedIdentitySession()
  browserSyncMocks.listener = null
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('shared identity callback', () => {
  it.each([
    { destination: '/' as const, label: 'Platform opened', scope: 'platform' as const },
    { destination: '/sygsphere' as const, label: 'SygSphere opened', scope: 'sygsphere' as const },
  ])('activates and opens the exact $scope destination', async ({ destination, label, scope }) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      destination,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      persistent: true,
      scope,
      sharedIdentityToken,
      supabaseSession: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      },
    })))

    renderCallback()

    expect(await screen.findByText(label)).toBeInTheDocument()
    expect(supabaseMocks.activateSharedIdentitySupabaseSession).toHaveBeenCalledWith(
      'access-token',
      'refresh-token',
    )
    expect(getSharedIdentitySessionToken()).toBe(sharedIdentityToken)
    expect(getSharedIdentitySessionScope()).toBe(scope)
    expect(browserSyncMocks.publishSharedIdentityBrowserEvent).toHaveBeenCalledWith('updated')
  })

  it('fails closed when the returned destination and scope do not match', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      destination: '/',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      persistent: true,
      scope: 'sygsphere',
      sharedIdentityToken,
      supabaseSession: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      },
    })))

    renderCallback()

    expect(await screen.findByText('SygShift could not open.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in directly to SygShift' })).toHaveAttribute('href', '/login')
    expect(screen.getByRole('link', { name: 'Return to Sygilant' })).toHaveAttribute('href', 'https://sygilant.us')
    expect(supabaseMocks.activateSharedIdentitySupabaseSession).not.toHaveBeenCalled()
    expect(getSharedIdentitySessionToken()).toBeNull()
  })

  it('shows a recoverable handoff error without calling finalization again', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    renderCallback('/auth/shared-identity/callback?handoff=failed')

    expect(await screen.findByText('SygShift could not open.')).toBeInTheDocument()
    expect(screen.getByText(/Return to Sygilant and try the SygShift button again/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Return to Sygilant' })).toHaveAttribute('href', 'https://sygilant.us')
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/v1/auth/shared-identity/finalize',
      expect.anything(),
    )
  })

  it('shows the callback failure even when remote session cleanup is unavailable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/session/logout')) {
        return Response.json({ error: 'temporarily_unavailable' }, { status: 503 })
      }
      return Response.json({ error: 'invalid_handoff' }, { status: 400 })
    })
    vi.stubGlobal('fetch', fetchMock)

    renderCallback()

    expect(await screen.findByText('SygShift could not open.')).toBeInTheDocument()
    expect(screen.getByText('The shared SygShift session could not be verified.')).toBeInTheDocument()
    expect(supabaseMocks.deactivateSharedIdentitySupabaseSession).toHaveBeenCalled()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/shared-identity/session/logout',
      expect.objectContaining({ method: 'POST' }),
    ))
  })

  it('does not recreate a session when another tab signs out during finalization', async () => {
    let finishFinalization: ((response: Response) => void) | null = null
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith('/session/logout')) return Promise.resolve(new Response(null, { status: 204 }))
      return new Promise<Response>((resolve) => { finishFinalization = resolve })
    })
    vi.stubGlobal('fetch', fetchMock)

    renderCallback()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/shared-identity/finalize',
      expect.objectContaining({ method: 'POST' }),
    ))

    act(() => browserSyncMocks.listener?.('cleared'))
    await act(async () => {
      finishFinalization?.(Response.json({
        destination: '/',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        persistent: true,
        scope: 'platform',
        sharedIdentityToken,
        supabaseSession: { accessToken: 'access-token', refreshToken: 'refresh-token' },
      }))
      await Promise.resolve()
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/shared-identity/session/logout',
      expect.objectContaining({ method: 'POST' }),
    ))
    expect(supabaseMocks.activateSharedIdentitySupabaseSession).not.toHaveBeenCalled()
    expect(getSharedIdentitySessionToken()).toBeNull()
    expect(screen.queryByText('Platform opened')).not.toBeInTheDocument()
  })
})

function renderCallback(initialEntry = '/auth/shared-identity/callback') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/auth/shared-identity/callback" element={<SharedIdentityCallbackPage />} />
        <Route path="/" element={<p>Platform opened</p>} />
        <Route path="/sygsphere" element={<p>SygSphere opened</p>} />
      </Routes>
    </MemoryRouter>,
  )
}
