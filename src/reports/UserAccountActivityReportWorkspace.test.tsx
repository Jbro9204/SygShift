import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getUserAccountActivityReport } from '../data/userAccountActivityReport'
import { userAccountActivityReportFixture } from '../test/userAccountActivityFixtures'
import { userAccountActivityWorkbook } from './userAccountActivityReport'
import { UserAccountActivityReportWorkspace } from './UserAccountActivityReportWorkspace'

vi.mock('../data/userAccountActivityReport', () => ({ getUserAccountActivityReport: vi.fn() }))
vi.mock('../lib/xlsxWorkbook', () => ({ downloadXlsxWorkbook: vi.fn() }))
vi.mock('./userAccountActivityReport', async (loadOriginal) => ({
  ...await loadOriginal<typeof import('./userAccountActivityReport')>(),
  userAccountActivityWorkbook: vi.fn(),
}))

const getReport = vi.mocked(getUserAccountActivityReport)

function renderWorkspace(canExport = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter><UserAccountActivityReportWorkspace canExport={canExport} /></MemoryRouter></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  getReport.mockResolvedValue(userAccountActivityReportFixture())
})

describe('User Account Activity role filters', () => {
  it('offers the authoritative catalog even with no matching employees, preserving custom/protected names and primary values', async () => {
    renderWorkspace()
    expect(await screen.findByRole('option', { name: 'Chief' })).toHaveValue('Chief')
    const role = screen.getByLabelText('Role')
    expect(within(role).getAllByRole('option')).toHaveLength(12)
    expect(within(role).getByRole('option', { name: 'Audit & QA' })).toHaveValue('Audit & QA')
    expect(within(role).getByRole('option', { name: 'Human Resources Manager' })).toHaveValue('Human Resources Manager')
    expect(within(role).getByRole('option', { name: 'Recruiting & Licensing' })).toHaveValue('Recruiting Licensing')
    expect(within(role).getByRole('option', { name: 'Admin' })).toHaveValue('Admin')
    fireEvent.change(role, { target: { value: 'Chief' } })
    await waitFor(() => expect(getReport).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'Chief', offset: 0 })))
    expect(screen.getByRole('button', { name: 'Export Excel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeDisabled()
  })

  it('resets pagination and preserves the exact custom role filter in protected exports', async () => {
    getReport.mockResolvedValue(userAccountActivityReportFixture({ totalCount: 60 }))
    renderWorkspace(true)
    await screen.findByRole('option', { name: 'Audit & QA' })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(getReport).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 25 })))
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Audit & QA' } })
    await waitFor(() => expect(getReport).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'Audit & QA', offset: 0 })))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export Excel' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Export Excel' }))
    await waitFor(() => expect(getReport).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'Audit & QA', export: true, offset: 0, pageSize: 50 })))
    await waitFor(() => expect(userAccountActivityWorkbook).toHaveBeenCalledWith(expect.any(Object), expect.stringContaining('Role: Audit & QA')))
  })

  it('does not silently clear or visually hide a selection when the role is retired', async () => {
    renderWorkspace()
    await screen.findByRole('option', { name: 'Chief' })
    getReport.mockResolvedValue(userAccountActivityReportFixture({ roleOptions: [{ value: 'Guard', label: 'Guard', baseRole: 'guard' }] }))
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Chief' } })
    expect(await screen.findByRole('option', { name: 'Chief (unavailable)' })).toBeDisabled()
    expect(screen.getByLabelText('Role')).toHaveValue('Chief')
    expect(getReport).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'Chief' }))
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: '' } })
    await waitFor(() => expect(getReport).toHaveBeenLastCalledWith(expect.objectContaining({ role: '' })))
  })
})
