import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SygilantLauncher } from './SygilantLauncher'

describe('Sygilant launcher', () => {
  it('opens the returned secure handoff in the current tab', async () => {
    const navigate = vi.fn()
    render(<SygilantLauncher launch={vi.fn().mockResolvedValue('https://sygilant.us/auth/continue')} navigate={navigate} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open Sygilant main platform' }))
    expect(screen.getByRole('button', { name: 'Opening Sygilant main platform' })).toBeDisabled()
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://sygilant.us/auth/continue'))
  })

  it('shows accessible failure feedback and never navigates on error', async () => {
    const navigate = vi.fn()
    render(<SygilantLauncher launch={vi.fn().mockRejectedValue(new Error('Secure handoff is unavailable.'))} navigate={navigate} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open Sygilant main platform' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Secure handoff is unavailable.')
    expect(navigate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Open Sygilant main platform' })).toBeEnabled()
  })
})
