import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSygTaskActivity } from '../../data/sygtasks'
import { SygTasksActivityPanel } from './SygTasksActivityPanel'

vi.mock('../../data/sygtasks', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../data/sygtasks')>(),
  getSygTaskActivity: vi.fn(),
}))

const taskId = '44444444-4444-4444-8444-444444444444'

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><SygTasksActivityPanel taskId={taskId} /></QueryClientProvider>)
}

describe('SygTasks activity panel', () => {
  beforeEach(() => {
    vi.mocked(getSygTaskActivity).mockReset()
  })

  it('shows the actor, exact time, and expandable previous-to-new details', async () => {
    vi.mocked(getSygTaskActivity).mockResolvedValue({
      taskId,
      events: [{
        id: 4,
        action: 'task.updated',
        entityType: 'task',
        entityId: taskId,
        details: { before: { status: 'ready' }, after: { status: 'in_progress' } },
        actorId: '11111111-1111-4111-8111-111111111111',
        actorName: 'Jordan Brown',
        actorSource: 'employee',
        createdAt: '2026-09-10T16:35:00.000Z',
        subject: null,
        label: null,
        relatedTask: null,
      }],
      page: { size: 50, hasMore: false, nextBeforeId: null },
    })

    const user = userEvent.setup()
    renderPanel()

    expect(await screen.findByText((_, node) => node?.tagName === 'P' && node.textContent === 'Jordan Brown changed the status')).toBeInTheDocument()
    expect(screen.getByText('Employee action')).toBeInTheDocument()
    expect(screen.getByText(/MDT/)).toBeInTheDocument()
    await user.click(screen.getByText('View change'))
    expect(screen.getByText('Previous').parentElement).toHaveTextContent('Ready')
    expect(screen.getByText('New').parentElement).toHaveTextContent('In progress')
  })

  it('loads earlier activity with the server cursor', async () => {
    vi.mocked(getSygTaskActivity)
      .mockResolvedValueOnce({ taskId, events: [], page: { size: 50, hasMore: true, nextBeforeId: 25 } })
      .mockResolvedValueOnce({ taskId, events: [], page: { size: 50, hasMore: false, nextBeforeId: null } })

    const user = userEvent.setup()
    renderPanel()
    await user.click(await screen.findByRole('button', { name: 'Load Earlier Activity' }))

    expect(getSygTaskActivity).toHaveBeenNthCalledWith(2, taskId, 25, 50)
  })
})
