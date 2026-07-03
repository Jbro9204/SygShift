import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('SygShift shell', () => {
  it('renders the operations overview without fabricated schedule data', async () => {
    window.history.replaceState({}, '', '/')
    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>,
    )

    expect(await screen.findByRole('heading', { name: 'One clear view of the day.' })).toBeVisible()
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Import review' })).toBeVisible()
    expect(screen.getByText('No schedule has been published.')).toBeVisible()
  })
})
