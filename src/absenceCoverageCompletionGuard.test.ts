import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TimeOperationsPage } from './time/TimeOperationsPage'

const savedCallOff = vi.hoisted(() => vi.fn())
const testEmployeeId = 'ac100000-0000-4000-8000-000000000001'
const testShiftId = 'ac200000-0000-4000-8000-000000000001'
vi.mock('./lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('./data/auth', () => ({ getSessionContext: async () => ({ employeeId: 'ac100000-0000-4000-8000-000000000001' }) }))
vi.mock('./pages/RequestsPage', () => ({
  CoverageWorkflowDialog: (props: { initialMode: string; report: { id: string } }) => createElement('span', {
    'data-testid': 'recorded-coverage-workflow', 'data-report-id': props.report.id,
  }, props.initialMode),
}))
vi.mock('./data/timekeeping', async (original) => ({
  ...await original<typeof import('./data/timekeeping')>(), getPendingTimeEventCorrections: async () => [],
}))
vi.mock('./data/timeOperations', async (original) => ({
  ...await original<typeof import('./data/timeOperations')>(),
  getMissingTimeRequestWorkspace: async () => ({ requests: [] }),
  reportEmployeeCallOff: savedCallOff,
  getTimekeepingOperationsWorkspace: async () => ({
    adjustmentRequestActions: [], adjustmentRequests: [], alerts: [], callOffReports: [], exceptions: [], manualEntries: [], posts: [],
    canCreateManualEntry: false, canEditManualEntry: false, canReportCallOff: true,
    canResolveExceptions: false, canReviewAdjustments: false, canViewOperations: true,
    employees: [{ id: testEmployeeId, name: 'Coverage Test Guard', username: 'coverage-test', employmentType: 'hourly' }],
    serverTimestamp: '2026-11-01T08:30:47.125Z',
    shifts: [{ shiftId: testShiftId, employeeId: testEmployeeId, startsAt: '2026-11-01T04:00:00.000Z', endsAt: '2026-11-01T13:00:00.000Z', timeZone: 'America/Denver', location: 'Coverage Test Site', postId: null }],
  }),
}))

const migration = readFileSync('supabase/migrations/20260914141934_absence_coverage_completion.sql', 'utf8')
const contractHardeningMigration = readFileSync('supabase/migrations/20260914145246_absence_coverage_contract_hardening.sql', 'utf8')
const requests = readFileSync('src/data/requests.ts', 'utf8')
const operations = readFileSync('src/time/TimeOperationsPage.tsx', 'utf8')
const accountability = readFileSync('src/time/AccountabilityPage.tsx', 'utf8')

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
  HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
  savedCallOff.mockReset().mockResolvedValue({ id: 'ac300000-0000-4000-8000-000000000001' })
})

describe('absence coverage completion guardrails', () => {
  it('restores the manager permission contract instead of silently defaulting it away', () => {
    expect(migration).toContain("'permissions', jsonb_build_object(")
    expect(contractHardeningMigration).toContain("'canManage', public.has_effective_permission('requests.manage')")
    expect(requests).not.toContain(".optional().default({ canManage: false })")
  })

  it('does not reopen coverage when an absence is corrected to a non-absence', () => {
    expect(contractHardeningMigration).toContain("target_event_type not in ('called_in_sick', 'call_off', 'no_call_no_show')")
    expect(contractHardeningMigration).toContain("'coverageRequired', false")
    expect(accountability).toContain('result.coverageRequired ? result.callOffId : null')
  })

  it('routes every newly recorded call-off into a recoverable coverage workflow', () => {
    expect(migration).toContain("concat('/requests?callOff=', report.id)")
    expect(migration).toContain("'coverageRequired', report.replacement_needed")
    expect(operations).toContain("replacementNeeded: data.get('replacementNeeded') === 'on'")
    expect(operations).toContain("setRecordedCallOff({ id: result.id, replacementNeeded: input.data.get('replacementNeeded') === 'on' })")
    expect(operations).toContain('mutation.mutate({ data: new FormData(event.currentTarget), employeeId, originalInstant: workspace.serverTimestamp })')
    expect(operations).toContain("initialMode={recordedCallOff.replacementNeeded ? 'open_pool' : 'no_replacement'}")
    expect(operations).toContain('Finish coverage')
    expect(accountability).toContain('<option value="call_off">Absent / call-off</option>')
    expect(accountability).toContain('if (result.callOffId) setCoverageCallOffId(result.callOffId)')
    expect(migration).toContain('private.ensure_attendance_absence_call_off_report(')
  })

  it('does not auto-create or backfill a shift while repairing existing alerts', () => {
    const repair = migration.slice(migration.indexOf('-- Repair only active unresolved call-off alerts.'))
    expect(repair).toContain('update public.operational_alerts')
    expect(repair).not.toContain('insert into public.shifts')
    expect(repair).not.toContain('insert into public.shift_assignments')
  })

  it.each([
    { replacementNeeded: true, expectedMode: 'open_pool' },
    { replacementNeeded: false, expectedMode: 'no_replacement' },
  ])('resumes the saved call-off in $expectedMode from its submitted coverage choice', async ({ replacementNeeded, expectedMode }) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, createElement(TimeOperationsPage))))
    fireEvent.click(await screen.findByRole('button', { name: 'Report Sick / Call-Off' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('Employee'), { target: { value: testEmployeeId } })
    fireEvent.change(dialog.getByLabelText('Scheduled shift'), { target: { value: testShiftId } })
    fireEvent.change(dialog.getByLabelText('Reason', { exact: true }), { target: { value: 'Controlled coverage continuation.' } })
    if (!replacementNeeded) fireEvent.click(dialog.getByRole('checkbox'))
    fireEvent.click(dialog.getByRole('button', { name: 'Record call-off' }))
    const coverage = await screen.findByTestId('recorded-coverage-workflow')
    expect(coverage).toHaveTextContent(expectedMode)
    expect(coverage).toHaveAttribute('data-report-id', 'ac300000-0000-4000-8000-000000000001')
    expect(savedCallOff).toHaveBeenCalledOnce()
    expect(savedCallOff.mock.calls[0][0]).toMatchObject({ employeeId: testEmployeeId, shiftId: testShiftId, replacementNeeded })
  })
})
