import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { TimePage } from './TimePage'

describe('time and attendance page', () => {
  it('shows the new Time Command Center shell without exposing live employee time data in setup mode', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <TimePage />
      </QueryClientProvider>,
    )

    expect(screen.getByRole('heading', { name: 'Time Command Center' })).toBeVisible()
    expect(screen.getByText('Secure time data is not connected')).toBeVisible()
    expect(screen.queryByText('Clock-in rules are ready for the secure database.')).not.toBeInTheDocument()
  })
})
