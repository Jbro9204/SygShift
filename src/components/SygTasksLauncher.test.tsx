import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SygTasksLauncher } from './SygTasksLauncher'

const mocks = vi.hoisted(() => ({ getMySygTasksBadge: vi.fn() }))
vi.mock('../data/sygtasks', () => ({ getMySygTasksBadge: mocks.getMySygTasksBadge }))

function renderLauncher(path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>
      <SygTasksLauncher />
    </MemoryRouter></QueryClientProvider>,
  )
}

describe('SygTasks launcher', () => {
  beforeEach(() => mocks.getMySygTasksBadge.mockReset().mockResolvedValue({ count: 0, unreadCount: 0, activeAlarmCount: 0 }))
  it('opens the existing SygTasks route with accessible branded artwork', () => {
    renderLauncher()

    const launcher = screen.getByRole('link', { name: 'Open SygTasks work management' })
    expect(launcher).toHaveAttribute('href', '/tasks')
    expect(launcher).toHaveClass('syg-launcher', 'syg-launcher--tasks')
    expect(launcher).toHaveAttribute('aria-describedby', 'sygtasks-launcher-tooltip')
    expect(screen.getByRole('tooltip')).toHaveTextContent('SygTasks · Work Management')
    expect(document.querySelector('img[src="/branding/sygtasks-logo.png"]')).toBeInTheDocument()
    expect(document.querySelector('img[src="/branding/sygtasks-emblem.png"]')).toBeInTheDocument()
  })

  it('exposes the active state and keeps its badge separate from SygSphere', async () => {
    mocks.getMySygTasksBadge.mockResolvedValue({ count: 3, unreadCount: 2, activeAlarmCount: 1 })
    renderLauncher('/tasks')

    const launcher = screen.getByRole('link', { name: 'Open SygTasks work management' })
    expect(launcher).toHaveAttribute('aria-current', 'page')
    expect(launcher).toHaveClass('sygtasks-launcher--active')
    expect(await screen.findByLabelText('3 SygTasks updates need attention')).toHaveTextContent('3')
    expect(document.querySelector('.sphere-badge')).not.toBeInTheDocument()
  })
})
