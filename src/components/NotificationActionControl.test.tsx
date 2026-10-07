// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationActionControl } from './NotificationActionControl'
import {
  launchSygilantPlatform,
  submitSygilantPlatformLaunch,
} from '../data/platformLaunch'

vi.mock('../data/platformLaunch', async (importOriginal) => ({
  ...await importOriginal<typeof import('../data/platformLaunch')>(),
  isOfficialSygShiftOrigin: vi.fn(() => true),
  launchSygilantPlatform: vi.fn(),
  submitSygilantPlatformLaunch: vi.fn(),
}))

const launchMock = vi.mocked(launchSygilantPlatform)
const submitMock = vi.mocked(submitSygilantPlatformLaunch)
const assertion = `ssli_v1.${'a'.repeat(80)}.${'b'.repeat(64)}`

beforeEach(() => {
  vi.clearAllMocks()
})

describe('cross-platform notification controls', () => {
  it('launches an inbox dispatch action even when best-effort mark-read fails', async () => {
    const destination = '/dispatch?call=4896f7c0-7143-48f9-9978-d1f6a342186f' as const
    const launch = launchFixture(destination)
    launchMock.mockResolvedValue(launch)

    render(<MemoryRouter><NotificationActionControl
      actionPath={destination}
      className="primary-action"
      onBeforeLaunch={() => Promise.reject(new Error('read status unavailable'))}
      sourceId="4896f7c0-7143-48f9-9978-d1f6a342186f"
      sourceType="sygilant_dispatch_assignment"
    >Open dispatch</NotificationActionControl></MemoryRouter>)

    await userEvent.click(screen.getByRole('button', { name: 'Open dispatch' }))
    await vi.waitFor(() => expect(launchMock).toHaveBeenCalledWith(destination))
    expect(submitMock).toHaveBeenCalledWith(launch)
  })

  it('does not wait for a pending mark-read request before preparing the handoff', async () => {
    const destination = '/dispatch?call=4896f7c0-7143-48f9-9978-d1f6a342186f' as const
    const launch = launchFixture(destination)
    launchMock.mockResolvedValue(launch)

    render(<MemoryRouter><NotificationActionControl
      actionPath={destination}
      onBeforeLaunch={() => new Promise(() => undefined)}
      sourceId="4896f7c0-7143-48f9-9978-d1f6a342186f"
      sourceType="sygilant_dispatch_assignment"
    >Open dispatch</NotificationActionControl></MemoryRouter>)

    await userEvent.click(screen.getByRole('button', { name: 'Open dispatch' }))
    await vi.waitFor(() => expect(submitMock).toHaveBeenCalledWith(launch))
  })

  it('launches a live-toast incident correction through the exact report destination', async () => {
    const destination = '/incident-reports?report=eacdc293-e7ff-4d14-8f8e-38340e26a2c5' as const
    const launch = launchFixture(destination)
    const removeToast = vi.fn()
    launchMock.mockResolvedValue(launch)

    render(<MemoryRouter><NotificationActionControl
      actionPath={destination}
      className="live-notification__action"
      onLaunchPrepared={removeToast}
      sourceId="4896f7c0-7143-48f9-9978-d1f6a342186f"
      sourceType="sygilant_report_correction"
    >Open report</NotificationActionControl></MemoryRouter>)

    await userEvent.click(screen.getByRole('button', { name: 'Open report' }))
    await vi.waitFor(() => expect(launchMock).toHaveBeenCalledWith(destination))
    expect(submitMock).toHaveBeenCalledWith(launch)
    expect(removeToast).toHaveBeenCalledOnce()
    expect(submitMock.mock.invocationCallOrder[0]).toBeLessThan(removeToast.mock.invocationCallOrder[0])
  })

  it('does not render a forged cross-platform action', () => {
    render(<MemoryRouter><NotificationActionControl
      actionPath="/incident-reports?report=eacdc293-e7ff-4d14-8f8e-38340e26a2c5&edit=true"
      sourceId="eacdc293-e7ff-4d14-8f8e-38340e26a2c5"
      sourceType="sygilant_report"
    >Open report</NotificationActionControl></MemoryRouter>)

    expect(screen.queryByRole('button', { name: 'Open report' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open report' })).not.toBeInTheDocument()
  })

  it('keeps a live-toast action and its error visible when launch preparation fails', async () => {
    const destination = '/incident-reports?report=eacdc293-e7ff-4d14-8f8e-38340e26a2c5' as const
    const removeToast = vi.fn()
    launchMock.mockRejectedValue(new Error('Secure handoff unavailable'))

    render(<MemoryRouter><NotificationActionControl
      actionPath={destination}
      className="live-notification__action"
      onLaunchPrepared={removeToast}
      sourceId="eacdc293-e7ff-4d14-8f8e-38340e26a2c5"
      sourceType="sygilant_report"
    >Open report</NotificationActionControl></MemoryRouter>)

    await userEvent.click(screen.getByRole('button', { name: 'Open report' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Secure handoff unavailable')
    expect(screen.getByRole('button', { name: 'Open report' })).toBeInTheDocument()
    expect(removeToast).not.toHaveBeenCalled()
    expect(submitMock).not.toHaveBeenCalled()
  })
})

function launchFixture(destination: Parameters<typeof launchSygilantPlatform>[0]) {
  return {
    applicationId: 'sygilant' as const,
    applicationUrl: 'https://sygilant.us',
    assertion,
    destination: destination ?? '/dashboard',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    requestId: crypto.randomUUID(),
  }
}
