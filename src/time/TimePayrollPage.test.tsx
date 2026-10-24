import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PayrollEmployeeSummary, PayrollExportBatch, PayrollExportDetail, TimekeepingReviewRow } from '../data/timekeeping'
import {
  capturePayrollFileOperationOwner,
  commitPayrollFileSideEffectIfCurrent,
  downloadPayrollHistoryForOwner,
  downloadPayrollPreviewForOwner,
  finalizeLockedPayrollWorkbookDownload,
  lockPayrollExportAndPrepareWorkbook,
  lockPayrollExportForOwner,
  payrollFileOperationOwnerIsCurrent,
  payrollFileOperationReceiptIsCurrent,
  payrollPeriodOperationIsCurrent,
  PayrollEmployeeSummaryTable,
  PayrollLockRecoveryNotice,
  PayrollRowsTable,
  PeriodControls,
  resetPayrollPeriodReceiptsIfChanged,
  stalePayrollLockResult,
  tryBeginPayrollFileOperation,
  verifiedPayrollQueryData,
  type PayrollFileOperationOwner,
} from './TimePayrollPage'
import type { PayrollWeeklyEmployeeSummary, PayrollWorkbookWeek } from './payrollWorkbook'

const week: PayrollWorkbookWeek = {
  label: 'Week 1',
  weekEndsOn: '2026-10-10',
  weekStartsOn: '2026-10-04',
}

const weeklySummary: PayrollWeeklyEmployeeSummary = {
  accountabilityCount: 0,
  breakMinutes: 30,
  employeeId: '73000000-0000-4000-8000-000000000001',
  employeeName: 'Jordan Brown',
  employmentType: 'hourly',
  epMinutes: 120,
  exceptionCount: 0,
  hasActivity: true,
  hasWorkedDetail: true,
  unclassifiedCategoryMinutes: 0,
  locationCount: 1,
  needsReview: false,
  otherPaidMinutes: 0,
  overtimeMinutes: 60,
  paidMinutes: 480,
  regularCategoryMinutes: 240,
  regularMinutes: 420,
  scheduledMinutes: 480,
  sickPayMinutes: 0,
  trainingMinutes: 0,
  truepMinutes: 120,
  username: 'jbrown',
  vacationPayMinutes: 0,
  workedShiftCount: 1,
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

describe('payroll category presentation', () => {
  it('shows category partitions separately from non-overtime and overtime totals', () => {
    render(
      <PayrollEmployeeSummaryTable
        groups={[{ summaries: [weeklySummary], week }]}
        onSelectSummary={vi.fn()}
        selectedSummary={null}
      />,
    )

    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Total worked' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Regular' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'EP' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'TRUEP' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Non-OT' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: /OT included in category totals/ })).toBeInTheDocument()
    expect(screen.getByText(/overtime is already included in one category/i)).toBeInTheDocument()
  })

  it('labels an old locked row without a category as legacy and unclassified', () => {
    const row = {
      breakMinutes: 0,
      crossesPayrollBoundary: false,
      employeeId: weeklySummary.employeeId,
      employeeName: weeklySummary.employeeName,
      employmentType: 'hourly',
      exceptionCodes: [],
      firstClockIn: '2026-10-05T13:00:00.000Z',
      grossMinutes: 480,
      lastClockOut: '2026-10-05T21:00:00.000Z',
      locationName: 'Executive Protection',
      manualAdjustment: false,
      mixedPayrollCategories: false,
      mixedWorkTypes: false,
      operationalDate: '2026-10-05',
      overtimeMinutes: 0,
      paidMinutes: 480,
      payrollAssignmentSource: 'scheduled_shift',
      payrollBatchWeekEndsOn: week.weekEndsOn,
      payrollBatchWeekStartsOn: week.weekStartsOn,
      payrollNotes: [],
      payrollReady: true,
      postName: 'Protection Detail',
      regularMinutes: 480,
      rowKind: 'time_event',
      scheduledStartsAt: '2026-10-05T13:00:00.000Z',
      shiftId: '73000000-0000-4000-8000-000000000002',
      siteCode: 'EP',
      siteName: 'Executive Protection',
      timeOffMinutes: 0,
      timeZone: 'America/Denver',
      username: weeklySummary.username,
      workType: 'post',
    } as unknown as TimekeepingReviewRow
    const summary: PayrollEmployeeSummary = {
      breakMinutes: 0,
      employeeId: weeklySummary.employeeId,
      employeeName: weeklySummary.employeeName,
      employmentType: 'hourly',
      epMinutes: 0,
      exceptionCount: 0,
      firstDate: row.operationalDate,
      grossMinutes: 480,
      lastDate: row.operationalDate,
      locationCount: 1,
      notes: ['Legacy locked row has no payroll category.'],
      overtimeMinutes: 0,
      paidMinutes: 480,
      payrollReady: true,
      postMinutes: 480,
      readyCount: 1,
      regularCategoryMinutes: 0,
      regularMinutes: 480,
      role: 'admin',
      trainingMinutes: 0,
      truepMinutes: 0,
      unclassifiedCategoryMinutes: 480,
      username: weeklySummary.username,
      workedShiftCount: 1,
    }

    render(<PayrollRowsTable rows={[row]} summary={summary} week={week} />)

    expect(screen.getByText('Legacy / unclassified')).toBeInTheDocument()
    expect(screen.getByText('Historical locked row; not reassigned.')).toBeInTheDocument()
  })
})

describe('official payroll lock recovery', () => {
  const batch = {
    createdAt: '2026-10-24T12:00:00.000Z',
    createdBy: '73000000-0000-4000-8000-000000000010',
    createdByName: 'Payroll Reviewer',
    digest: 'a'.repeat(64),
    fromDate: '2026-10-04',
    grossMinutes: 480,
    id: '73000000-0000-4000-8000-000000000011',
    note: 'Reviewed and ready.',
    paidMinutes: 480,
    rowCount: 1,
    throughDate: '2026-10-17',
  } satisfies PayrollExportBatch

  it('returns the locked batch as success when a follow-up workbook read fails', async () => {
    const result = await lockPayrollExportAndPrepareWorkbook(
      { fromDate: batch.fromDate, note: batch.note, throughDate: batch.throughDate },
      {
        createBatch: vi.fn().mockResolvedValue(batch),
        getAccountabilityEvents: vi.fn().mockRejectedValue(new Error('Accountability lookup timed out.')),
        getBatchDetail: vi.fn().mockResolvedValue({ batch, exceptionResolutionHistory: [], rows: [] } satisfies PayrollExportDetail),
      },
    )

    expect(result.batch).toBe(batch)
    expect(result.workbook).toBeNull()
    expect(result.preparationError?.message).toBe('Accountability lookup timed out.')
  })

  it('does not hide a failure that occurs before the server confirms the lock', async () => {
    await expect(lockPayrollExportAndPrepareWorkbook(
      { fromDate: batch.fromDate, note: batch.note, throughDate: batch.throughDate },
      {
        createBatch: vi.fn().mockRejectedValue(new Error('Lock was rejected.')),
        getAccountabilityEvents: vi.fn(),
        getBatchDetail: vi.fn(),
      },
    )).rejects.toThrow('Lock was rejected.')
  })

  it('keeps a confirmed lock successful when local workbook generation fails', () => {
    const detail = { batch, exceptionResolutionHistory: [], rows: [] } satisfies PayrollExportDetail
    const result = finalizeLockedPayrollWorkbookDownload(
      { batch, preparationError: null, workbook: { accountabilityEvents: [], detail } },
      () => { throw new Error('Browser download was blocked.') },
    )

    expect(result.batch.id).toBe(batch.id)
    expect(result.workbook).toBeNull()
    expect(result.preparationError?.message).toBe('Browser download was blocked.')
  })

  it('never reports an undownloaded workbook as a successful receipt after its period becomes stale', () => {
    const detail = { batch, exceptionResolutionHistory: [], rows: [] } satisfies PayrollExportDetail
    const result = stalePayrollLockResult(
      { batch, preparationError: null, workbook: { accountabilityEvents: [], detail } },
      4,
    )

    expect(result.batch.id).toBe(batch.id)
    expect(result.periodGeneration).toBe(4)
    expect(result.workbook).toBeNull()
    expect(result.preparationError?.message).toMatch(/selected period changed/i)
  })

  it('replaces failed-preparation guidance with a successful retry receipt', () => {
    const retry = vi.fn()
    const view = render(
      <PayrollLockRecoveryNotice
        batchDigest={batch.digest}
        batchId={batch.id}
        onRetryDownload={retry}
        preparationError={new Error('Accountability lookup timed out.')}
        recoveredFileName={null}
        retryDownloadError={null}
        retryDownloadPending={false}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Retry Workbook Download' }))
    expect(retry).toHaveBeenCalledWith(batch.id)

    view.rerender(
      <PayrollLockRecoveryNotice
        batchDigest={batch.digest}
        batchId={batch.id}
        onRetryDownload={retry}
        preparationError={new Error('Accountability lookup timed out.')}
        recoveredFileName="SygShift-Payroll-2026-10-04-to-2026-10-17.xlsx"
        retryDownloadError={null}
        retryDownloadPending={false}
      />,
    )

    expect(screen.queryByText(/could not be prepared/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry Workbook Download' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/remained locked.*downloaded successfully/i)
  })
})

describe('payroll background-refresh truthfulness', () => {
  it('does not expose cached payroll inputs after a failed refresh', () => {
    const cached = { summary: { rowCount: 3 } }

    expect(verifiedPayrollQueryData({ data: cached, isError: false, isRefetchError: false })).toBe(cached)
    expect(verifiedPayrollQueryData({ data: cached, isError: true, isRefetchError: true })).toBeUndefined()
    expect(verifiedPayrollQueryData({ data: cached, isError: true, isRefetchError: false })).toBeUndefined()
  })
})

describe('payroll period receipt scope', () => {
  it('synchronously rejects a second same-frame file operation before React rerenders', () => {
    const inFlight = { current: false }

    expect(tryBeginPayrollFileOperation(inFlight)).toBe(true)
    expect(tryBeginPayrollFileOperation(inFlight)).toBe(false)
    expect(inFlight.current).toBe(true)
  })

  it('holds every period control fixed while an official payroll file operation is in flight', () => {
    const onChange = vi.fn()
    render(
      <PeriodControls
        disabled
        fromDate="2026-10-04"
        onChange={onChange}
        throughDate="2026-10-17"
      />,
    )

    for (const control of screen.getAllByRole('button')) expect(control).toBeDisabled()
    for (const control of screen.getAllByDisplayValue(/2026-10-/)) expect(control).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(/stays fixed until the current payroll file operation finishes/i)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('clears preview, lock, download, and recovery state when the selected period changes', () => {
    const resetters = {
      clearRecoveredDownload: vi.fn(),
      resetDownload: vi.fn(),
      resetExport: vi.fn(),
      resetPreview: vi.fn(),
    }

    expect(resetPayrollPeriodReceiptsIfChanged(
      { fromDate: '2026-10-04', throughDate: '2026-10-17' },
      { fromDate: '2026-10-18', throughDate: '2026-10-31' },
      resetters,
    )).toBe(true)
    expect(resetters.resetPreview).toHaveBeenCalledTimes(1)
    expect(resetters.resetExport).toHaveBeenCalledTimes(1)
    expect(resetters.resetDownload).toHaveBeenCalledTimes(1)
    expect(resetters.clearRecoveredDownload).toHaveBeenCalledTimes(1)
  })

  it('keeps a valid receipt when the selected period did not change', () => {
    const resetters = {
      clearRecoveredDownload: vi.fn(),
      resetDownload: vi.fn(),
      resetExport: vi.fn(),
      resetPreview: vi.fn(),
    }

    expect(resetPayrollPeriodReceiptsIfChanged(
      { fromDate: '2026-10-04', throughDate: '2026-10-17' },
      { fromDate: '2026-10-04', throughDate: '2026-10-17' },
      resetters,
    )).toBe(false)
    expect(resetters.resetPreview).not.toHaveBeenCalled()
    expect(resetters.resetExport).not.toHaveBeenCalled()
    expect(resetters.resetDownload).not.toHaveBeenCalled()
    expect(resetters.clearRecoveredDownload).not.toHaveBeenCalled()
  })

  it('rejects a late operation result after the selected period generation changes', () => {
    expect(payrollPeriodOperationIsCurrent(4, 4)).toBe(true)
    expect(payrollPeriodOperationIsCurrent(4, 5)).toBe(false)
  })
})

describe('payroll file account ownership', () => {
  const identityA = {
    authSessionId: '74000000-0000-4000-8000-000000000001',
    authUserId: '74000000-0000-4000-8000-000000000002',
    employeeId: '74000000-0000-4000-8000-000000000003',
  }
  const identityB = {
    authSessionId: '74000000-0000-4000-8000-000000000004',
    authUserId: '74000000-0000-4000-8000-000000000005',
    employeeId: '74000000-0000-4000-8000-000000000006',
  }
  const owner: PayrollFileOperationOwner = { ...identityA, lifecycleGeneration: 7 }
  const batch = {
    createdAt: '2026-10-24T12:00:00.000Z',
    createdBy: identityA.employeeId,
    createdByName: 'Payroll Reviewer',
    digest: 'b'.repeat(64),
    fromDate: '2026-10-04',
    grossMinutes: 480,
    id: '74000000-0000-4000-8000-000000000007',
    note: 'Reviewed and ready.',
    paidMinutes: 480,
    rowCount: 1,
    throughDate: '2026-10-17',
  } satisfies PayrollExportBatch
  const detail = { batch, exceptionResolutionHistory: [], rows: [] } satisfies PayrollExportDetail

  it('captures auth user, auth session, employee, and lifecycle as one immutable owner', async () => {
    const captured = await capturePayrollFileOperationOwner(identityA.employeeId, 7, async () => identityA)

    expect(captured).toEqual(owner)
    await expect(capturePayrollFileOperationOwner(identityA.employeeId, 7, async () => identityB))
      .rejects.toThrow(/account changed/i)
  })

  it('withholds a preview file when the account changes during deferred verification', async () => {
    let currentIdentity = identityA
    const verification = deferred<void>()
    const download = vi.fn(() => ({ fileName: 'preview.xlsx', size: 128 }))
    const resultPromise = downloadPayrollPreviewForOwner(
      {} as Parameters<typeof downloadPayrollPreviewForOwner>[0],
      'preview.xlsx',
      owner,
      (candidate) => payrollFileOperationOwnerIsCurrent(
        candidate,
        () => 7,
        () => true,
        async () => {
          await verification.promise
          return currentIdentity
        },
      ),
      download,
    )

    currentIdentity = identityB
    verification.resolve()
    await expect(resultPromise).resolves.toMatchObject({ download: null, owner, staleOwner: true })
    expect(download).not.toHaveBeenCalled()
  })

  it('preserves a confirmed official lock receipt but does not download after an account switch', async () => {
    let currentIdentity = identityA
    const lockResponse = deferred<PayrollExportBatch>()
    const download = vi.fn()
    const verifier = async (candidate: PayrollFileOperationOwner) => (
      candidate.authUserId === currentIdentity.authUserId
      && candidate.authSessionId === currentIdentity.authSessionId
      && candidate.employeeId === currentIdentity.employeeId
    )
    const resultPromise = lockPayrollExportForOwner(
      { fromDate: batch.fromDate, note: batch.note, throughDate: batch.throughDate },
      owner,
      3,
      () => 3,
      verifier,
      {
        createBatch: vi.fn(() => lockResponse.promise),
        getAccountabilityEvents: vi.fn().mockResolvedValue([]),
        getBatchDetail: vi.fn().mockResolvedValue(detail),
      },
      download,
    )

    currentIdentity = identityB
    lockResponse.resolve(batch)
    const result = await resultPromise

    expect(result.batch).toBe(batch)
    expect(result.staleOwner).toBe(true)
    expect(result.workbook).toBeNull()
    expect(result.preparationError?.message).toMatch(/changed signed-in accounts/i)
    expect(download).not.toHaveBeenCalled()
  })

  it('does not download or retain account A history data after a deferred response resolves under account B', async () => {
    let currentIdentity = identityA
    const detailResponse = deferred<PayrollExportDetail>()
    const download = vi.fn(() => ({ fileName: 'official.xlsx', size: 256 }))
    const verifier = async (candidate: PayrollFileOperationOwner) => (
      candidate.authUserId === currentIdentity.authUserId
      && candidate.authSessionId === currentIdentity.authSessionId
      && candidate.employeeId === currentIdentity.employeeId
    )
    const resultPromise = downloadPayrollHistoryForOwner(
      { batchId: batch.id },
      owner,
      2,
      () => 2,
      verifier,
      {
        getAccountabilityEvents: vi.fn().mockResolvedValue([]),
        getBatchDetail: vi.fn(() => detailResponse.promise),
      },
      download,
    )

    currentIdentity = identityB
    detailResponse.resolve(detail)
    const result = await resultPromise

    expect(result).toMatchObject({ accountabilityEvents: null, detail: null, download: null, staleOwner: true })
    expect(download).not.toHaveBeenCalled()
  })

  it('withholds a late onSuccess cache write after an account change', async () => {
    let currentIdentity = identityA
    const verification = deferred<void>()
    const cacheWrite = vi.fn()
    const committed = commitPayrollFileSideEffectIfCurrent(
      owner,
      (candidate) => payrollFileOperationOwnerIsCurrent(
        candidate,
        () => 7,
        () => true,
        async () => {
          await verification.promise
          return currentIdentity
        },
      ),
      cacheWrite,
    )

    currentIdentity = identityB
    verification.resolve()
    await expect(committed).resolves.toBe(false)
    expect(cacheWrite).not.toHaveBeenCalled()
  })

  it('invalidates a late callback after unmount even when the same auth identity remains available', async () => {
    let mounted = true
    const verification = deferred<void>()
    const cacheWrite = vi.fn()
    const committed = commitPayrollFileSideEffectIfCurrent(
      owner,
      (candidate) => payrollFileOperationOwnerIsCurrent(
        candidate,
        () => 7,
        () => mounted,
        async () => {
          await verification.promise
          return identityA
        },
      ),
      cacheWrite,
    )

    mounted = false
    verification.resolve()
    await expect(committed).resolves.toBe(false)
    expect(cacheWrite).not.toHaveBeenCalled()
  })

  it('fails closed when sign-out makes identity revalidation unavailable', async () => {
    await expect(payrollFileOperationOwnerIsCurrent(
      owner,
      () => 7,
      () => true,
      async () => { throw new Error('No session') },
    )).resolves.toBe(false)
  })

  it('never renders an account A receipt in account B or a later lifecycle', () => {
    const result = { owner, staleOwner: false }

    expect(payrollFileOperationReceiptIsCurrent(result, identityA.employeeId, 7)).toBe(true)
    expect(payrollFileOperationReceiptIsCurrent(result, identityB.employeeId, 7)).toBe(false)
    expect(payrollFileOperationReceiptIsCurrent(result, identityA.employeeId, 8)).toBe(false)
    expect(payrollFileOperationReceiptIsCurrent({ ...result, staleOwner: true }, identityA.employeeId, 7)).toBe(false)
  })
})
