import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SygilantLauncher } from './SygilantLauncher'

describe('Sygilant launcher', () => {
  const handoff = {
    applicationId: 'sygilant' as const,
    applicationUrl: 'https://sygilant.us',
    assertion: `ssli_v1.${'a'.repeat(80)}.${'b'.repeat(64)}`,
    destination: '/dashboard' as const,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    requestId: crypto.randomUUID(),
  }

  it('submits the returned secure handoff in the current tab', async () => {
    const submit = vi.fn()
    render(<SygilantLauncher launch={vi.fn().mockResolvedValue(handoff)} submit={submit} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open Sygilant main platform' }))
    expect(screen.getByRole('button', { name: 'Opening Sygilant main platform' })).toBeDisabled()
    await waitFor(() => expect(submit).toHaveBeenCalledWith(handoff))
  })

  it('uses the production transparent Sygilant wordmark asset', () => {
    render(<SygilantLauncher launch={vi.fn()} submit={vi.fn()} />)
    expect(document.querySelectorAll('img[src="/branding/sygilant-horizontal-transparent.png"]')).toHaveLength(2)
  })

  it('shows accessible failure feedback and never navigates on error', async () => {
    const submit = vi.fn()
    render(<SygilantLauncher launch={vi.fn().mockRejectedValue(new Error('Secure handoff is unavailable.'))} submit={submit} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open Sygilant main platform' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Secure handoff is unavailable.')
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Open Sygilant main platform' })).toBeEnabled()
  })
})
