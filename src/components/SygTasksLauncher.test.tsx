import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { SygTasksLauncher } from './SygTasksLauncher'

function renderLauncher(path = '/') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SygTasksLauncher />
    </MemoryRouter>,
  )
}

describe('SygTasks launcher', () => {
  it('opens the existing SygTasks route with accessible branded artwork', () => {
    renderLauncher()

    const launcher = screen.getByRole('link', { name: 'Open SygTasks work management' })
    expect(launcher).toHaveAttribute('href', '/tasks')
    expect(launcher).toHaveAttribute('aria-describedby', 'sygtasks-launcher-tooltip')
    expect(screen.getByRole('tooltip')).toHaveTextContent('SygTasks · Work Management')
    expect(document.querySelector('img[src="/branding/sygtasks-logo.png"]')).toBeInTheDocument()
    expect(document.querySelector('img[src="/branding/sygtasks-emblem.png"]')).toBeInTheDocument()
  })

  it('exposes the active state without adding a notification badge', () => {
    renderLauncher('/tasks')

    const launcher = screen.getByRole('link', { name: 'Open SygTasks work management' })
    expect(launcher).toHaveAttribute('aria-current', 'page')
    expect(launcher).toHaveClass('sygtasks-launcher--active')
    expect(document.querySelector('.sphere-badge')).not.toBeInTheDocument()
  })
})
