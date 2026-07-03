import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ImportReviewPage } from './ImportReviewPage'

describe('workbook import review', () => {
  it('shows only verified aggregate data before the secure connection is configured', () => {
    render(<ImportReviewPage />)

    expect(screen.getByRole('heading', { name: 'Workbook import review' })).toBeVisible()
    expect(screen.getByText('110,274')).toBeVisible()
    expect(screen.getByText('9,408')).toBeVisible()
    expect(screen.getByText('Every workbook cell is preserved and traceable.')).toBeVisible()
    expect(screen.getByText('Ready for the secure Supabase connection')).toBeVisible()
  })
})
