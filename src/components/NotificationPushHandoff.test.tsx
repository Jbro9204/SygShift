// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationPushHandoff } from './NotificationPushHandoff'
import {
  launchSygilantPlatform,
  submitSygilantPlatformLaunch,
} from '../data/platformLaunch'
import { markMyNotificationRead } from '../data/notifications'

vi.mock('../data/platformLaunch', async (importOriginal) => ({
  ...await importOriginal<typeof import('../data/platformLaunch')>(),
  isOfficialSygShiftOrigin: vi.fn(() => true),
  launchSygilantPlatform: vi.fn(),
  submitSygilantPlatformLaunch: vi.fn(),
}))
vi.mock('../data/notifications', () => ({ markMyNotificationRead: vi.fn() }))

const launchMock = vi.mocked(launchSygilantPlatform)
const markReadMock = vi.mocked(markMyNotificationRead)
const submitMock = vi.mocked(submitSygilantPlatformLaunch)
const assertion = `ssli_v1.${'a'.repeat(80)}.${'b'.repeat(64)}`

beforeEach(() => {
  vi.clearAllMocks()
})

describe('push notification Sygilant handoff', () => {
  it.each([
    '/dispatch?call=4896f7c0-7143-48f9-9978-d1f6a342186f',
    '/daily-activity-reports?report=eacdc293-e7ff-4d14-8f8e-38340e26a2c5',
    '/incident-reports?report=eacdc293-e7ff-4d14-8f8e-38340e26a2c5',
    '/vehicle-inspections?report=eacdc293-e7ff-4d14-8f8e-38340e26a2c5',
  ] as const)('launches %s without waiting for mark-read success', async (destination) => {
    const launch = launchFixture(destination)
    markReadMock.mockRejectedValue(new Error('read status unavailable'))
    launchMock.mockResolvedValue(launch)

    render(<NotificationPushHandoff
      destinationValue={destination}
      notificationId="2768b3c0-6f71-4ba0-8795-6cd965871a97"
    />)

    await vi.waitFor(() => expect(launchMock).toHaveBeenCalledWith(destination))
    expect(markReadMock).toHaveBeenCalledWith('2768b3c0-6f71-4ba0-8795-6cd965871a97')
    expect(submitMock).toHaveBeenCalledWith(launch)
  })

  it('fails closed when a destination contains extra parameters', () => {
    render(<NotificationPushHandoff
      destinationValue="/dispatch?call=4896f7c0-7143-48f9-9978-d1f6a342186f&admin=true"
      notificationId="2768b3c0-6f71-4ba0-8795-6cd965871a97"
    />)

    expect(screen.getByRole('alert')).toHaveTextContent('notification link is invalid')
    expect(markReadMock).not.toHaveBeenCalled()
    expect(launchMock).not.toHaveBeenCalled()
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
