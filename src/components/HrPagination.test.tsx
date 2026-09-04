import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HrPagination } from './HrPagination'

describe('HrPagination', () => {
  it('does not render unnecessary controls for an empty first page', () => {
    const { container } = render(<HrPagination itemCount={0} offset={0} onOffsetChange={() => undefined} onPageSizeChange={() => undefined} pageSize={10} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('presents a compact range and working page controls', () => {
    const onOffsetChange = vi.fn()
    const onPageSizeChange = vi.fn()
    render(<HrPagination itemCount={10} label="Talent records" offset={10} onOffsetChange={onOffsetChange} onPageSizeChange={onPageSizeChange} pageSize={10} />)

    expect(screen.getByText('11–20')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    expect(onOffsetChange).toHaveBeenCalledWith(0)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(onOffsetChange).toHaveBeenCalledWith(20)

    fireEvent.change(screen.getByRole('combobox', { name: 'Talent records rows per page' }), { target: { value: '20' } })
    expect(onPageSizeChange).toHaveBeenCalledWith(20)
    expect(onOffsetChange).toHaveBeenLastCalledWith(0)
  })

  it('keeps a previous-page path when a later page becomes empty', () => {
    render(<HrPagination itemCount={0} offset={10} onOffsetChange={() => undefined} onPageSizeChange={() => undefined} pageSize={10} />)
    expect(screen.getByText('No records on this page')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })
})
