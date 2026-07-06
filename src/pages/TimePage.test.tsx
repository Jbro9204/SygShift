import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TimePage } from './TimePage'

describe('time and attendance page', () => {
  it('shows the verified setup state without exposing live employee time data', () => {
    render(<TimePage />)

    expect(screen.getByRole('heading', { name: 'Time & Attendance' })).toBeVisible()
    expect(screen.getByText('Clock-in rules are ready for the secure database.')).toBeVisible()
    expect(screen.getByText('Official punch time comes from the secure server.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Clock in' })).toBeDisabled()
    expect(screen.getByText('Connect Supabase to record live punches')).toBeVisible()
  })
})
