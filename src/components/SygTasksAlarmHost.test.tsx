import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SygTasksAlarmHost } from './SygTasksAlarmHost'

const mocks = vi.hoisted(() => ({
  getAlarmState: vi.fn(),
  manageAlarm: vi.fn(),
  mutateTasks: vi.fn(),
  playSound: vi.fn(),
  stopAlarmSound: vi.fn(),
}))

vi.mock('../data/sygtasks', () => ({
  getMySygTasksAlarmState: mocks.getAlarmState,
  manageMySygTasksAlarm: mocks.manageAlarm,
  mutateSygTasks: mocks.mutateTasks,
  sygTaskPath: (boardId: string, taskId: string) => `/tasks?board=${boardId}&task=${taskId}`,
}))
vi.mock('../lib/notificationSounds', () => ({
  enableAudio: vi.fn().mockResolvedValue(true),
  getSoundPreferences: () => ({ login: true, notification: true, alarm: true, muted: false, volume: .5 }),
  playSound: mocks.playSound,
  SOUND_PREFERENCES_EVENT: 'sygshift:sound-preferences',
  stopAlarmSound: mocks.stopAlarmSound,
}))

const employeeId = '11111111-1111-4111-8111-111111111111'
const boardId = '22222222-2222-4222-8222-222222222222'
const taskId = '33333333-3333-4333-8333-333333333333'
const occurrenceId = '44444444-4444-4444-8444-444444444444'

function activeAlarm() {
  return {
    serverTime: '2026-09-09T18:00:00Z',
    alarms: [{ occurrenceId, reminderId: employeeId, taskId, boardId, title: 'Confirm weekend coverage', priority: 'urgent',
      dueAt: '2026-09-10T18:00:00Z', scheduledFor: '2026-09-09T18:00:00Z', triggeredAt: '2026-09-09T18:00:00Z',
      deliveryCount: 1, taskVersion: 3, canComplete: true }],
  }
}

function renderHost() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter><SygTasksAlarmHost employeeId={employeeId} /></MemoryRouter></QueryClientProvider>)
}

describe('SygTasks alarm host', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.getAlarmState.mockReset().mockResolvedValue(activeAlarm())
    mocks.manageAlarm.mockReset().mockResolvedValue(undefined)
    mocks.mutateTasks.mockReset().mockResolvedValue({ changed: true })
    mocks.playSound.mockReset().mockResolvedValue(true)
    mocks.stopAlarmSound.mockReset()
  })

  it('presents a persistent alarm with stop, snooze, open, and completion controls', async () => {
    const view = renderHost()
    expect(await screen.findByRole('heading', { name: 'Confirm weekend coverage' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop alarm' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Snooze' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open task/ })).toHaveAttribute('href', `/tasks?board=${boardId}&task=${taskId}`)
    expect(screen.getByRole('button', { name: /Mark complete/ })).toBeInTheDocument()
    await waitFor(() => expect(mocks.playSound).toHaveBeenCalledWith('alarm'))
    view.unmount()
  })

  it('stops local audio immediately and records acknowledgement server-side', async () => {
    const user = userEvent.setup()
    renderHost()
    await user.click(await screen.findByRole('button', { name: 'Stop alarm' }))
    expect(mocks.stopAlarmSound).toHaveBeenCalled()
    expect(mocks.manageAlarm).toHaveBeenCalledWith('acknowledge', occurrenceId, null)
  })
})
