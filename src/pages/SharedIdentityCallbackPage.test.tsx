import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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

vi.mock('../lib/supabase', () => supabaseMocks)

const sharedIdentityToken = 'shared-token'.repeat(5)

afterEach(() => {
  clearSharedIdentitySession()
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
})

function renderCallback() {
  return render(
    <MemoryRouter initialEntries={['/auth/shared-identity/callback']}>
      <Routes>
        <Route path="/auth/shared-identity/callback" element={<SharedIdentityCallbackPage />} />
        <Route path="/" element={<p>Platform opened</p>} />
        <Route path="/sygsphere" element={<p>SygSphere opened</p>} />
      </Routes>
    </MemoryRouter>,
  )
}
