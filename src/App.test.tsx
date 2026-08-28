import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('SygShift shell', () => {
  it('renders the application shell without fabricated Home data', async () => {
    window.history.replaceState({}, '', '/')
    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Preparing your Home page...')).toBeVisible()
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Home' })).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Import Review' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Operational Import' })).not.toBeInTheDocument()
  })
})
