import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { attendanceFixture } from '../test/attendanceFixture'
import { AttendanceReportWorkspace } from './AttendanceReportWorkspace'

const mocks = vi.hoisted(() => ({ report: vi.fn(), download: vi.fn() }))
vi.mock('../data/accountability', () => ({ getAttendanceReport: mocks.report }))
vi.mock('../lib/xlsxWorkbook', () => ({ downloadXlsxWorkbook: mocks.download }))

describe('Attendance report workflow', () => {
  it('shows corrected records by default, filters, and exports all pages with server permission recheck', async () => {
    const events = Array.from({ length: 25 }, (_, index) => attendanceFixture({ id: String(index), note: `Record ${index}` }))
    mocks.report.mockResolvedValue({ fromDate: '2026-08-30', throughDate: '2026-09-05', serverTimestamp: '2026-09-06T12:00:00Z', events })
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><AttendanceReportWorkspace from="2026-08-30" through="2026-09-05" onRangeChange={vi.fn()} canExport /></MemoryRouter></QueryClientProvider>)
    await screen.findByRole('heading', { name: '25 documented occurrences' })
    expect(screen.getAllByText('Test Employee')).toHaveLength(10)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Page 2 of 3')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Export Excel' }))
    await waitFor(() => expect(mocks.report).toHaveBeenCalledWith({ fromDate: '2026-08-30', throughDate: '2026-09-05', export: true }))
    await waitFor(() => expect(mocks.download).toHaveBeenCalled())
    expect(mocks.download.mock.calls[0][0][1].rows).toHaveLength(29)
    fireEvent.change(screen.getByLabelText('Review state'), { target: { value: 'open' } })
    await screen.findByRole('heading', { name: '0 documented occurrences' })
    expect(screen.queryByRole('navigation', { name: 'Attendance pages' })).not.toBeInTheDocument()
  })
})
