import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addDays, format } from 'date-fns'
import { BellRing, CheckCircle2, Clock3, FileClock, ShieldAlert } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { getSessionContext } from '../data/auth'
import {
  acknowledgeOperationalAlert,
  cancelTimeAdjustmentRequest,
  cancelEmployeeCallOff,
  createManualTimeEntry,
  editManualTimeEntry,
  formatTimeOperationsPostLabel,
  getMissingTimeRequestWorkspace,
  getTimekeepingOperationsWorkspace,
  reportEmployeeCallOff,
  resolveOperationalException,
  reviewMissingTimeRequest,
  reviewTimeAdjustmentRequest,
  submitTimeAdjustmentRequest,
  updateEmployeeCallOff,
  toZonedLocalDateTimeInput,
  zonedLocalDateTimeToUtc,
  type OperationalException,
  type ManualTimeEntry,
  type EmployeeCallOffReport,
  type TimeAdjustmentRequest,
  type TimeOperationsWorkspace,
} from '../data/timeOperations'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'
import { TimeButton, TimePageHeader, TimeStatusBadge } from './TimeKit'

type DialogName = 'adjustment' | 'manual' | 'calloff' | null

function dateKey(value: Date): string {
  return format(value, 'yyyy-MM-dd')
}

function readableStatus(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function invalidateOperations(queryClient: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['time-operations-workspace'] }),
    queryClient.invalidateQueries({ queryKey: ['time-exceptions-review'] }),
    queryClient.invalidateQueries({ queryKey: ['time-command-review'] }),
    queryClient.invalidateQueries({ queryKey: ['timekeeping-dashboard'] }),
    queryClient.invalidateQueries({ queryKey: ['my-time-review'] }),
    queryClient.invalidateQueries({ queryKey: ['my-missing-time-workspace'] }),
    queryClient.invalidateQueries({ queryKey: ['missing-time-request-workspace'] }),
  ])
}

export function TimeOperationsPage() {
  const today = new Date()
  const queryClient = useQueryClient()
  const [fromDate, setFromDate] = useState(dateKey(addDays(today, -14)))
  const [throughDate, setThroughDate] = useState(dateKey(addDays(today, 42)))
  const [dialog, setDialog] = useState<DialogName>(null)
  const [selectedRequest, setSelectedRequest] = useState<TimeAdjustmentRequest | null>(null)
  const [selectedException, setSelectedException] = useState<OperationalException | null>(null)
  const [selectedManualEntry, setSelectedManualEntry] = useState<ManualTimeEntry | null>(null)
  const [selectedCallOff, setSelectedCallOff] = useState<EmployeeCallOffReport | null>(null)
  const sessionQuery = useQuery({ enabled: isSupabaseConfigured, queryFn: getSessionContext, queryKey: ['session-context'] })
  const workspaceQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess,
    queryFn: () => getTimekeepingOperationsWorkspace(fromDate, throughDate),
    queryKey: ['time-operations-workspace', fromDate, throughDate],
    refetchInterval: 30_000,
  })
  const missingTimeWorkspaceQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess,
    queryFn: () => getMissingTimeRequestWorkspace(fromDate, throughDate),
    queryKey: ['missing-time-request-workspace', fromDate, throughDate],
    refetchInterval: 30_000,
  })
  const workspace = workspaceQuery.data
  const adjustmentRequests = useMemo(() => {
    const requests = [...(workspace?.adjustmentRequests ?? []), ...(missingTimeWorkspaceQuery.data?.requests ?? [])]
    return [...new Map(requests.map((request) => [request.id, request])).values()]
  }, [missingTimeWorkspaceQuery.data?.requests, workspace?.adjustmentRequests])
  const ownRequests = useMemo(
    () => adjustmentRequests.filter((request) => request.employeeId === sessionQuery.data?.employeeId),
    [adjustmentRequests, sessionQuery.data?.employeeId],
  )

  if (!isSupabaseConfigured || sessionQuery.isPending || workspaceQuery.isPending || missingTimeWorkspaceQuery.isPending) {
    return <main className="page page--sygshift-time"><DataStatePanel icon={Clock3} title="Loading time workflows"><p>Loading requests, exceptions, manual entries, and operational alerts.</p></DataStatePanel></main>
  }
  if (sessionQuery.isError || workspaceQuery.isError || missingTimeWorkspaceQuery.isError || !workspace) {
    return <main className="page page--sygshift-time"><DataStatePanel icon={ShieldAlert} title="Time workflows unavailable" tone="error"><p>{workspaceQuery.error?.message ?? missingTimeWorkspaceQuery.error?.message ?? sessionQuery.error?.message ?? 'The secure workspace could not be loaded.'}</p></DataStatePanel></main>
  }

  const unresolved = workspace.exceptions.filter((exception) => exception.status === 'unresolved')
  const pending = adjustmentRequests.filter((request) => request.status === 'submitted' || request.status === 'under_review')
  const urgent = workspace.alerts.filter((alert) => alert.priority === 'urgent' && !alert.acknowledgedAt)

  return (
    <main className="page page--sygshift-time">
      <TimePageHeader
        actions={<div className="time-operations-header-actions"><TimeButton onClick={() => setDialog('adjustment')} variant="secondary">Request a time change</TimeButton>{workspace.canCreateManualEntry ? <TimeButton onClick={() => setDialog('manual')} variant="secondary">Add manual time</TimeButton> : null}{workspace.canReportCallOff ? <TimeButton onClick={() => setDialog('calloff')} variant="danger">Report Sick / Call-Off</TimeButton> : null}</div>}
        eyebrow="Time workflows"
        summary="Review exceptions without rewriting valid punches, process employee requests, and document operational attendance decisions."
        title="Time Operations"
      />

      <section className="time-operations-range" aria-label="Workspace date range">
        <label><span>From</span><input onChange={(event) => setFromDate(event.target.value)} type="date" value={fromDate} /></label>
        <label><span>Through</span><input onChange={(event) => setThroughDate(event.target.value)} type="date" value={throughDate} /></label>
      </section>

      {urgent.length > 0 ? <AlertQueue alerts={urgent} onChanged={() => invalidateOperations(queryClient)} /> : null}

      <section className="time-operations-metrics" aria-label="Time workflow totals">
        <article><span>Unresolved exceptions</span><strong>{unresolved.length}</strong><small>Automatic clock-outs and missed starts</small></article>
        <article><span>Requests awaiting review</span><strong>{pending.length}</strong><small>Employee-submitted time changes</small></article>
        <article><span>Manual entries</span><strong>{workspace.manualEntries.length}</strong><small>Audited paired time records</small></article>
        <article><span>Your open requests</span><strong>{ownRequests.filter((request) => request.status === 'submitted' || request.status === 'under_review').length}</strong><small>Track decisions and history here</small></article>
      </section>

      <div className="time-operations-grid">
        <section className="time-operations-panel">
          <div className="time-operations-panel__heading"><div><p className="eyebrow">Exception queue</p><h2>Operational time exceptions</h2></div><TimeStatusBadge tone={unresolved.length ? 'warning' : 'good'}>{unresolved.length ? `${unresolved.length} open` : 'Clear'}</TimeStatusBadge></div>
          {workspace.canViewOperations ? unresolved.length ? unresolved.map((exception) => (
            <article className="time-workflow-row" key={exception.id}>
              <div><strong>{exception.employeeName}</strong><span>{readableStatus(exception.exceptionCode)} · {exception.location}</span><small>{formatOperationalDateTime(exception.scheduledStartAt, { timeZone: 'America/Denver' })} – {formatOperationalDateTime(exception.scheduledEndAt, { timeZone: 'America/Denver' })}</small></div>
              {workspace.canResolveExceptions ? <TimeButton onClick={() => setSelectedException(exception)} variant="secondary">Review</TimeButton> : null}
            </article>
          )) : <EmptyMessage icon={CheckCircle2} title="No unresolved operational exceptions" /> : <EmptyMessage icon={ShieldAlert} title="Operations access is not enabled" />}
        </section>

        <section className="time-operations-panel">
          <div className="time-operations-panel__heading"><div><p className="eyebrow">Employee requests</p><h2>Time-adjustment decisions</h2></div><TimeStatusBadge tone={pending.length ? 'warning' : 'good'}>{pending.length ? `${pending.length} waiting` : 'Clear'}</TimeStatusBadge></div>
          {(workspace.canReviewAdjustments ? pending : ownRequests).length ? (workspace.canReviewAdjustments ? pending : ownRequests).map((request) => (
            <article className="time-workflow-row" key={request.id}>
               <div><strong>{request.employeeName}</strong><span>{readableStatus(request.issueType)} · {request.workDate}</span><small>{request.reason} · {readableStatus(request.status)}</small><RequestDecisionHistory actions={workspace.adjustmentRequestActions.filter((action) => action.requestId === request.id)} /></div>
              {workspace.canReviewAdjustments && (request.status === 'submitted' || request.status === 'under_review') ? <TimeButton onClick={() => setSelectedRequest(request)} variant="secondary">Review</TimeButton> : request.employeeId === sessionQuery.data.employeeId && (request.status === 'submitted' || request.status === 'under_review') ? <CancelRequestButton id={request.id} onChanged={() => invalidateOperations(queryClient)} /> : null}
            </article>
          )) : <EmptyMessage icon={FileClock} title="No time-adjustment requests in this range" />}
        </section>
      </div>

      {workspace.canViewOperations ? (
        <section className="time-operations-panel">
          <div className="time-operations-panel__heading"><div><p className="eyebrow">Audit history</p><h2>Manual time entries</h2></div></div>
          {workspace.manualEntries.length ? workspace.manualEntries.map((entry) => (
            <article className="time-workflow-row time-workflow-row--wide" key={entry.id}>
              <div><strong>{entry.employeeName}</strong><span>{formatOperationalDateTime(entry.clockInAt)} – {formatOperationalDateTime(entry.clockOutAt)}</span><small>{entry.reason} · entered by {entry.createdBy}{entry.lastEditedAt ? ` · last edited ${formatOperationalDateTime(entry.lastEditedAt)}` : ''}</small></div>
              <div className="time-workflow-row__actions"><TimeStatusBadge tone="good">{readableStatus(entry.approvalStatus)}</TimeStatusBadge>{workspace.canEditManualEntry ? <TimeButton onClick={() => setSelectedManualEntry(entry)} variant="secondary">Edit</TimeButton> : null}</div>
            </article>
          )) : <EmptyMessage icon={Clock3} title="No manual entries in this range" />}
        </section>
      ) : null}

      {workspace.canViewOperations ? (
        <section className="time-operations-panel">
          <div className="time-operations-panel__heading"><div><p className="eyebrow">Attendance history</p><h2>Active sick and call-off records</h2></div><TimeStatusBadge tone={workspace.callOffReports.length ? 'warning' : 'good'}>{workspace.callOffReports.length ? `${workspace.callOffReports.length} active` : 'Clear'}</TimeStatusBadge></div>
          {workspace.callOffReports.length ? workspace.callOffReports.map((report) => (
            <article className="time-workflow-row time-workflow-row--wide" key={report.id}>
              <div><strong>{report.employeeName}</strong><span>{readableStatus(report.callOffType)} · {report.location}</span><small>{formatOperationalDateTime(report.startsAt, { timeZone: report.timeZone })} – {formatOperationalDateTime(report.endsAt, { timeZone: report.timeZone })} · received by {report.receivedBy || 'authorized user'}</small></div>
              <div className="time-workflow-row__actions"><TimeStatusBadge tone={report.replacementNeeded ? 'warning' : 'good'}>{report.replacementNeeded ? 'Coverage needed' : 'No replacement needed'}</TimeStatusBadge>{workspace.canReportCallOff ? <TimeButton onClick={() => setSelectedCallOff(report)} variant="secondary">Maintain</TimeButton> : null}</div>
            </article>
          )) : <EmptyMessage icon={CheckCircle2} title="No active call-offs in this range" />}
        </section>
      ) : null}

      {dialog === 'adjustment' ? <AdjustmentDialog onClose={() => setDialog(null)} onSaved={() => invalidateOperations(queryClient)} workspace={workspace} employeeId={sessionQuery.data.employeeId} /> : null}
      {dialog === 'manual' ? <ManualEntryDialog onClose={() => setDialog(null)} onSaved={() => invalidateOperations(queryClient)} workspace={workspace} /> : null}
      {dialog === 'calloff' ? <CallOffDialog onClose={() => setDialog(null)} onSaved={() => invalidateOperations(queryClient)} workspace={workspace} /> : null}
      {selectedRequest ? <RequestReviewDialog onClose={() => setSelectedRequest(null)} onSaved={() => invalidateOperations(queryClient)} request={selectedRequest} /> : null}
      {selectedException ? <ExceptionReviewDialog exception={selectedException} onClose={() => setSelectedException(null)} onSaved={() => invalidateOperations(queryClient)} /> : null}
      {selectedManualEntry ? <ManualEntryEditDialog entry={selectedManualEntry} onClose={() => setSelectedManualEntry(null)} onSaved={() => invalidateOperations(queryClient)} workspace={workspace} /> : null}
      {selectedCallOff ? <CallOffMaintenanceDialog onClose={() => setSelectedCallOff(null)} onSaved={() => invalidateOperations(queryClient)} report={selectedCallOff} /> : null}
    </main>
  )
}

function ManualEntryEditDialog({ entry, onClose, onSaved, workspace }: { entry: ManualTimeEntry; onClose: () => void; onSaved: () => Promise<unknown>; workspace: TimeOperationsWorkspace }) {
  const [confirmWarnings, setConfirmWarnings] = useState(false)
  const [shiftId, setShiftId] = useState(entry.shiftId ?? '')
  const [postId, setPostId] = useState(entry.postId ?? '')
  const mutation = useMutation({ mutationFn: editManualTimeEntry, onSuccess: async () => { await onSaved(); onClose() } })
  const shifts = workspace.shifts.filter((shift) => shift.employeeId === entry.employeeId)
  const linkedShift = shifts.find((shift) => shift.shiftId === shiftId)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const shift = shifts.find((item) => item.shiftId === shiftId)
    mutation.mutate({
      id: entry.id,
      clockInAt: zonedLocalDateTimeToUtc(String(data.get('clockInAt')), shift?.timeZone ?? workspace.posts.find((post) => post.id === postId)?.timeZone),
      clockOutAt: zonedLocalDateTimeToUtc(String(data.get('clockOutAt')), shift?.timeZone ?? workspace.posts.find((post) => post.id === postId)?.timeZone),
      shiftId: shift?.shiftId ?? null,
      postId: shift ? shift.postId : (postId || null),
      reason: String(data.get('reason')),
      notes: String(data.get('notes') || '') || null,
      confirmWarnings,
    })
  }
  return (
    <ModalDialog busy={mutation.isPending} className="modal-dialog--time-workflow" description="The source punches remain intact. SygShift appends corrections and a before-and-after audit record." onClose={onClose} title={`Edit ${entry.employeeName}'s manual time`}>
      <form className="time-workflow-form" onSubmit={submit}>
        <label><span>Related scheduled shift</span><select onChange={(event) => setShiftId(event.target.value)} value={shiftId}><option value="">No related shift</option>{shifts.map((shift) => <option key={shift.shiftId} value={shift.shiftId}>{formatOperationalDateTime(shift.startsAt, { timeZone: shift.timeZone })} · {shift.location}</option>)}</select></label>
        <label>
          <span>Site / post</span>
          <select disabled={Boolean(linkedShift)} onChange={(event) => setPostId(event.target.value)} required={!linkedShift} value={linkedShift ? (linkedShift.postId ?? '') : postId}>
            <option value="">{linkedShift && !linkedShift.postId ? 'Event location comes from the linked shift' : 'Choose site / post'}</option>
            {workspace.posts.map((post) => <option key={post.id} value={post.id}>{formatTimeOperationsPostLabel(post)}</option>)}
          </select>
          <small className="field-help">For patrol time, choose the exact client/accounting Site/Post, such as MG Properties, PERA, or Patrol Libraries and Elevon. Use a general Patrol post only when that was the actual assignment.</small>
        </label>
        <div className="time-workflow-form__two"><label><span>Clock-in</span><input defaultValue={toZonedLocalDateTimeInput(entry.clockInAt, linkedShift?.timeZone)} name="clockInAt" required type="datetime-local" /></label><label><span>Clock-out</span><input defaultValue={toZonedLocalDateTimeInput(entry.clockOutAt, linkedShift?.timeZone)} name="clockOutAt" required type="datetime-local" /></label></div>
        <label><span>Edit reason</span><input maxLength={200} name="reason" required /></label>
        <label><span>Notes</span><textarea defaultValue={entry.notes ?? ''} maxLength={1000} name="notes" rows={3} /></label>
        <label className="time-workflow-confirm"><input checked={confirmWarnings} onChange={(event) => setConfirmWarnings(event.target.checked)} type="checkbox" /><span>I reviewed the corrected times and authorize saving if SygShift detects a disclosed warning.</span></label>
        {mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}
        <div className="time-workflow-form__actions"><TimeButton onClick={onClose} type="button" variant="secondary">Cancel</TimeButton><TimeButton type="submit" variant="primary">Save correction</TimeButton></div>
      </form>
    </ModalDialog>
  )
}

function EmptyMessage({ icon: Icon, title }: { icon: typeof Clock3; title: string }) {
  return <div className="time-workflow-empty"><Icon aria-hidden="true" size={25} /><strong>{title}</strong></div>
}

function RequestDecisionHistory({ actions }: { actions: TimeOperationsWorkspace['adjustmentRequestActions'] }) {
  if (actions.length === 0) return null
  return <details className="time-request-history"><summary>Decision history</summary><ol>{actions.map((action) => <li key={action.id}><strong>{readableStatus(action.action)}</strong><span>{action.note || 'No additional note.'}</span><small>{action.actor} · {formatOperationalDateTime(action.createdAt)}</small></li>)}</ol></details>
}

function AdjustmentDialog({ employeeId, onClose, onSaved, workspace }: { employeeId: string; onClose: () => void; onSaved: () => Promise<unknown>; workspace: TimeOperationsWorkspace }) {
  const employeeShifts = workspace.shifts.filter((shift) => shift.employeeId === employeeId)
  const [issueType, setIssueType] = useState<'clock_in' | 'clock_out' | 'both_punches' | 'missing_shift' | 'other'>('both_punches')
  const mutation = useMutation({ mutationFn: submitTimeAdjustmentRequest, onSuccess: async () => { await onSaved(); onClose() } })
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const selectedShift = employeeShifts.find((shift) => shift.shiftId === data.get('shiftId'))
    mutation.mutate({
      shiftId: String(data.get('shiftId') || '') || null,
      workDate: String(data.get('workDate')),
      issueType,
      requestedClockInAt: data.get('clockInAt') ? zonedLocalDateTimeToUtc(String(data.get('clockInAt')), selectedShift?.timeZone) : null,
      requestedClockOutAt: data.get('clockOutAt') ? zonedLocalDateTimeToUtc(String(data.get('clockOutAt')), selectedShift?.timeZone) : null,
      reason: String(data.get('reason')),
      notes: String(data.get('notes') || '') || null,
    })
  }
  return <ModalDialog busy={mutation.isPending} className="modal-dialog--time-workflow" description="Submitting a request does not change payroll until an authorized reviewer approves it." onClose={onClose} title="Request a time adjustment"><form className="time-workflow-form" onSubmit={submit}><label><span>Scheduled shift (optional)</span><select name="shiftId" onChange={(event) => { const shift = employeeShifts.find((item) => item.shiftId === event.target.value); if (shift) setIssueType('both_punches') }}><option value="">No scheduled shift / missing shift</option>{employeeShifts.map((shift) => <option key={shift.shiftId} value={shift.shiftId}>{formatOperationalDateTime(shift.startsAt, { timeZone: shift.timeZone })} · {shift.location}</option>)}</select></label><label><span>Work date</span><input name="workDate" required type="date" /></label><label><span>What needs correction?</span><select onChange={(event) => setIssueType(event.target.value as typeof issueType)} value={issueType}><option value="clock_in">Clock-in</option><option value="clock_out">Clock-out</option><option value="both_punches">Both punches</option><option value="missing_shift">Missing shift</option><option value="other">Other issue</option></select></label><div className="time-workflow-form__two"><label><span>Requested clock-in</span><input name="clockInAt" type="datetime-local" /></label><label><span>Requested clock-out</span><input name="clockOutAt" type="datetime-local" /></label></div><label><span>Reason</span><input maxLength={160} name="reason" required /></label><label><span>Notes</span><textarea maxLength={1000} name="notes" rows={4} /></label>{mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}<div className="time-workflow-form__actions"><TimeButton onClick={onClose} type="button" variant="secondary">Cancel</TimeButton><TimeButton type="submit" variant="primary">Submit request</TimeButton></div></form></ModalDialog>
}

function ManualEntryDialog({ onClose, onSaved, workspace }: { onClose: () => void; onSaved: () => Promise<unknown>; workspace: TimeOperationsWorkspace }) {
  const [employeeId, setEmployeeId] = useState('')
  const [shiftId, setShiftId] = useState('')
  const [postId, setPostId] = useState('')
  const [confirmWarnings, setConfirmWarnings] = useState(false)
  const mutation = useMutation({ mutationFn: createManualTimeEntry, onSuccess: async () => { await onSaved(); onClose() } })
  const shifts = workspace.shifts.filter((shift) => shift.employeeId === employeeId)
  const linkedShift = shifts.find((shift) => shift.shiftId === shiftId)
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); const timeZone = linkedShift?.timeZone ?? workspace.posts.find((post) => post.id === postId)?.timeZone; mutation.mutate({ employeeId, workDate: String(data.get('workDate')), clockInAt: zonedLocalDateTimeToUtc(String(data.get('clockInAt')), timeZone), clockOutAt: zonedLocalDateTimeToUtc(String(data.get('clockOutAt')), timeZone), shiftId: linkedShift?.shiftId ?? null, postId: linkedShift ? linkedShift.postId : (postId || null), reason: String(data.get('reason')), notes: String(data.get('notes') || '') || null, exceptionId: String(data.get('exceptionId') || '') || null, confirmWarnings }) }
  return (
    <ModalDialog busy={mutation.isPending} className="modal-dialog--time-workflow" description="Creates one audited clock-in/clock-out pair. Existing punches are never overwritten." onClose={onClose} title="Add manual time">
      <form className="time-workflow-form" onSubmit={submit}>
        <label><span>Employee</span><select onChange={(event) => { setEmployeeId(event.target.value); setShiftId('') }} required value={employeeId}><option value="">Choose employee</option>{workspace.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
        <label><span>Related scheduled shift</span><select onChange={(event) => setShiftId(event.target.value)} value={shiftId}><option value="">No related shift</option>{shifts.map((shift) => <option key={shift.shiftId} value={shift.shiftId}>{formatOperationalDateTime(shift.startsAt, { timeZone: shift.timeZone })} · {shift.location}</option>)}</select></label>
        <label>
          <span>Site / post</span>
          <select disabled={Boolean(linkedShift)} onChange={(event) => setPostId(event.target.value)} required={!linkedShift} value={linkedShift ? (linkedShift.postId ?? '') : postId}>
            <option value="">{linkedShift && !linkedShift.postId ? 'Event location comes from the linked shift' : 'Choose site / post'}</option>
            {workspace.posts.map((post) => <option key={post.id} value={post.id}>{formatTimeOperationsPostLabel(post)}</option>)}
          </select>
          <small className="field-help">For patrol time, choose the exact client/accounting Site/Post, such as MG Properties, PERA, or Patrol Libraries and Elevon. Use a general Patrol post only when that was the actual assignment.</small>
        </label>
        <label><span>Exception being resolved</span><select name="exceptionId"><option value="">None</option>{workspace.exceptions.filter((item) => item.employeeId === employeeId && item.status === 'unresolved').map((item) => <option key={item.id} value={item.id}>{readableStatus(item.exceptionCode)} · {formatOperationalDateTime(item.scheduledStartAt)}</option>)}</select></label>
        <label><span>Work date</span><input defaultValue={dateKey(new Date())} name="workDate" required type="date" /></label>
        <div className="time-workflow-form__two"><label><span>Clock-in</span><input name="clockInAt" required type="datetime-local" /></label><label><span>Clock-out</span><input name="clockOutAt" required type="datetime-local" /></label></div>
        <label><span>Entry reason</span><input maxLength={200} name="reason" required /></label>
        <label><span>Notes</span><textarea maxLength={1000} name="notes" rows={3} /></label>
        <label className="time-workflow-confirm"><input checked={confirmWarnings} onChange={(event) => setConfirmWarnings(event.target.checked)} type="checkbox" /><span>I reviewed the times and authorize saving if SygShift detects a schedule, overlap, or long-shift warning.</span></label>
        {mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}
        <div className="time-workflow-form__actions"><TimeButton onClick={onClose} type="button" variant="secondary">Cancel</TimeButton><TimeButton type="submit" variant="primary">Save manual entry</TimeButton></div>
      </form>
    </ModalDialog>
  )
}

function CallOffDialog({ onClose, onSaved, workspace }: { onClose: () => void; onSaved: () => Promise<unknown>; workspace: TimeOperationsWorkspace }) {
  const [employeeId, setEmployeeId] = useState('')
  const mutation = useMutation({ mutationFn: reportEmployeeCallOff, onSuccess: async () => { await onSaved(); onClose() } })
  const shifts = workspace.shifts.filter((shift) => shift.employeeId === employeeId && new Date(shift.endsAt) >= new Date(workspace.serverTimestamp))
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); mutation.mutate({ employeeId, shiftId: String(data.get('shiftId')), callOffType: data.get('callOffType') as 'sick' | 'other', reason: String(data.get('reason')), callReceivedAt: zonedLocalDateTimeToUtc(String(data.get('callReceivedAt'))), notes: String(data.get('notes') || '') || null, replacementNeeded: data.get('replacementNeeded') === 'on', operationalDetails: String(data.get('operationalDetails') || '') || null }) }
  return <ModalDialog busy={mutation.isPending} className="modal-dialog--time-workflow modal-dialog--call-off" description="Creates a persistent urgent alert and keeps the original scheduled shift in the audit record." onClose={onClose} title="Report Sick / Call-Off"><form className="time-workflow-form" onSubmit={submit}><label><span>Employee</span><select onChange={(event) => setEmployeeId(event.target.value)} required value={employeeId}><option value="">Choose employee</option>{workspace.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label><label><span>Scheduled shift</span><select name="shiftId" required><option value="">Choose shift</option>{shifts.map((shift) => <option key={shift.shiftId} value={shift.shiftId}>{formatOperationalDateTime(shift.startsAt, { timeZone: shift.timeZone })} · {shift.location}</option>)}</select></label><div className="time-workflow-form__two"><label><span>Call-off type</span><select name="callOffType"><option value="sick">Sick</option><option value="other">Other</option></select></label><label><span>Call received</span><input defaultValue={toZonedLocalDateTimeInput(workspace.serverTimestamp)} name="callReceivedAt" required type="datetime-local" /></label></div><label><span>Reason</span><input maxLength={200} name="reason" required /></label><label><span>Notes</span><textarea maxLength={1000} name="notes" rows={3} /></label><label><span>Operational details</span><textarea maxLength={1000} name="operationalDetails" rows={3} /></label><label className="time-workflow-confirm"><input defaultChecked name="replacementNeeded" type="checkbox" /><span>Replacement coverage is needed.</span></label>{mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}<div className="time-workflow-form__actions"><TimeButton onClick={onClose} type="button" variant="secondary">Cancel</TimeButton><TimeButton type="submit" variant="danger">Record call-off</TimeButton></div></form></ModalDialog>
}

function CallOffMaintenanceDialog({ onClose, onSaved, report }: { onClose: () => void; onSaved: () => Promise<unknown>; report: EmployeeCallOffReport }) {
  const [mode, setMode] = useState<'update' | 'cancel'>('update')
  const mutation = useMutation({
    mutationFn: async (form: FormData) => {
      if (mode === 'cancel') return cancelEmployeeCallOff(report.id, String(form.get('cancellationReason')))
      return updateEmployeeCallOff({
        id: report.id,
        callOffType: form.get('callOffType') as 'sick' | 'other',
        reason: String(form.get('reason')),
        notes: String(form.get('notes') || '') || null,
        operationalDetails: String(form.get('operationalDetails') || '') || null,
        replacementNeeded: form.get('replacementNeeded') === 'on',
      })
    },
    onSuccess: async () => { await onSaved(); onClose() },
  })
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); mutation.mutate(new FormData(event.currentTarget)) }
  return <ModalDialog busy={mutation.isPending} className="modal-dialog--time-workflow modal-dialog--call-off" description="Updates and cancellations are permission-checked and added to the permanent call-off audit history." onClose={onClose} title={`Maintain ${report.employeeName}'s call-off`}><form className="time-workflow-form" onSubmit={submit}><div className="time-request-summary"><strong>{report.location}</strong><span>{formatOperationalDateTime(report.startsAt, { timeZone: report.timeZone })} – {formatOperationalDateTime(report.endsAt, { timeZone: report.timeZone })}</span><small>Received by {report.receivedBy || 'authorized user'} · {formatOperationalDateTime(report.callReceivedAt, { timeZone: report.timeZone })}</small></div><div className="time-workflow-mode" role="group" aria-label="Maintenance action"><TimeButton onClick={() => setMode('update')} type="button" variant={mode === 'update' ? 'primary' : 'secondary'}>Update record</TimeButton><TimeButton onClick={() => setMode('cancel')} type="button" variant={mode === 'cancel' ? 'danger' : 'secondary'}>Cancel call-off</TimeButton></div>{mode === 'update' ? <><label><span>Call-off type</span><select defaultValue={report.callOffType} name="callOffType"><option value="sick">Sick</option><option value="other">Other</option></select></label><label><span>Reason</span><input defaultValue={report.reason} maxLength={200} name="reason" required /></label><label><span>Update notes</span><textarea maxLength={1000} name="notes" rows={3} /></label><label><span>Operational details</span><textarea defaultValue={report.operationalDetails ?? ''} maxLength={1000} name="operationalDetails" rows={3} /></label><label className="time-workflow-confirm"><input defaultChecked={report.replacementNeeded} name="replacementNeeded" type="checkbox" /><span>Replacement coverage is needed.</span></label></> : <label><span>Cancellation reason</span><textarea maxLength={1000} name="cancellationReason" required rows={4} /></label>}{mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}<div className="time-workflow-form__actions"><TimeButton onClick={onClose} type="button" variant="secondary">Close</TimeButton><TimeButton type="submit" variant={mode === 'cancel' ? 'danger' : 'primary'}>{mode === 'cancel' ? 'Confirm cancellation' : 'Save call-off update'}</TimeButton></div></form></ModalDialog>
}

function RequestReviewDialog({ onClose, onSaved, request }: { onClose: () => void; onSaved: () => Promise<unknown>; request: TimeAdjustmentRequest }) {
  const [decision, setDecision] = useState<'under_review' | 'approved' | 'partially_approved' | 'rejected'>('under_review')
  const [confirmWarnings, setConfirmWarnings] = useState(false)
  const isMissingTimeRequest = request.issueType === 'missing_shift' && Boolean(request.requestedPostId)
  const requestTimeZone = request.requestedTimeZone ?? 'America/Denver'
  const mutation = useMutation({
    mutationFn: async (input: { id: string; status: typeof decision; decisionNote: string; confirmWarnings: boolean }) => {
      if (isMissingTimeRequest) {
        if (input.status === 'partially_approved') throw new Error('Missing-time requests must be approved, rejected, or left under review.')
        return reviewMissingTimeRequest({ ...input, status: input.status })
      }
      return reviewTimeAdjustmentRequest(input)
    },
    onSuccess: async () => { await onSaved(); onClose() },
  })
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); mutation.mutate({ id: request.id, status: decision, decisionNote: String(data.get('decisionNote')), confirmWarnings }) }
  return (
    <ModalDialog busy={mutation.isPending} className="modal-dialog--time-workflow" description="The original request and every decision remain in audit history." onClose={onClose} title={`Review ${request.employeeName}'s request`}>
      <form className="time-workflow-form" onSubmit={submit}>
        <div className="time-request-summary">
          <strong>{readableStatus(request.issueType)} · {request.workDate}</strong>
          {request.requestedLocation ? <span>{request.requestedLocation}</span> : null}
          <span>{request.reason}</span>
          <small>{request.requestedClockInAt ? `Requested in: ${formatOperationalDateTime(request.requestedClockInAt, { timeZone: requestTimeZone })}` : 'No clock-in requested'} · {request.requestedClockOutAt ? `Requested out: ${formatOperationalDateTime(request.requestedClockOutAt, { timeZone: requestTimeZone })}` : 'No clock-out requested'}</small>
          {isMissingTimeRequest ? <small>{request.requestedUnpaidBreakMinutes > 0 ? `${request.requestedUnpaidBreakMinutes} unpaid break minutes` : 'No unpaid break reported'} · No payroll effect until approved</small> : null}
        </div>
        <label>
          <span>Decision</span>
          <select onChange={(event) => setDecision(event.target.value as typeof decision)} value={decision}>
            <option value="under_review">Mark under review</option>
            <option value="approved">Approve</option>
            {!isMissingTimeRequest ? <option value="partially_approved">Partially approve</option> : null}
            <option value="rejected">Reject</option>
          </select>
        </label>
        <label><span>Decision note</span><textarea maxLength={1000} name="decisionNote" required rows={4} /></label>
        {decision === 'approved' || decision === 'partially_approved' ? <label className="time-workflow-confirm"><input checked={confirmWarnings} onChange={(event) => setConfirmWarnings(event.target.checked)} type="checkbox" /><span>I reviewed the requested times, Site/Post, unpaid break, and authorize any disclosed validation warnings.</span></label> : null}
        {mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}
        <div className="time-workflow-form__actions"><TimeButton onClick={onClose} type="button" variant="secondary">Cancel</TimeButton><TimeButton type="submit" variant="primary">Save decision</TimeButton></div>
      </form>
    </ModalDialog>
  )
}

function ExceptionReviewDialog({ exception, onClose, onSaved }: { exception: OperationalException; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [action, setAction] = useState<'resolved' | 'dismissed'>('resolved')
  const mutation = useMutation({ mutationFn: resolveOperationalException, onSuccess: async () => { await onSaved(); onClose() } })
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); mutation.mutate({ id: exception.id, action, method: action === 'resolved' ? 'resolved_manual_entry' : 'dismissed', note: String(data.get('note')) }) }
  return <ModalDialog busy={mutation.isPending} className="modal-dialog--time-workflow" description="Use manual time to correct missing punches. Dismiss only when the exception was generated incorrectly." onClose={onClose} title={`Review ${readableStatus(exception.exceptionCode)}`}><form className="time-workflow-form" onSubmit={submit}><div className="time-request-summary"><strong>{exception.employeeName}</strong><span>{exception.location}</span><small>{formatOperationalDateTime(exception.scheduledStartAt)} – {formatOperationalDateTime(exception.scheduledEndAt)}</small></div><label><span>Resolution</span><select onChange={(event) => setAction(event.target.value as typeof action)} value={action}><option value="resolved">Mark resolved after correction</option><option value="dismissed">Dismiss incorrect exception</option></select></label><label><span>Documented reason</span><textarea maxLength={1000} name="note" required rows={4} /></label>{mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}<div className="time-workflow-form__actions"><TimeButton onClick={onClose} type="button" variant="secondary">Leave unresolved</TimeButton><TimeButton type="submit" variant="primary">Save resolution</TimeButton></div></form></ModalDialog>
}

function CancelRequestButton({ id, onChanged }: { id: string; onChanged: () => Promise<unknown> }) {
  const mutation = useMutation({ mutationFn: cancelTimeAdjustmentRequest, onSuccess: onChanged })
  return <TimeButton disabled={mutation.isPending} onClick={() => mutation.mutate(id)} variant="secondary">Cancel request</TimeButton>
}

function AlertQueue({ alerts, onChanged }: { alerts: TimeOperationsWorkspace['alerts']; onChanged: () => Promise<unknown> }) {
  const mutation = useMutation({ mutationFn: acknowledgeOperationalAlert, onSuccess: onChanged })
  return <section className="operational-alert-queue" aria-label="Urgent operational alerts"><div className="operational-alert-queue__heading"><BellRing aria-hidden="true" size={24} /><div><strong>Urgent attendance action required</strong><span>Corrected attendance and schedule changes clear automatically. Unresolved items move to payroll review after the live response window.</span></div></div>{alerts.map((alert) => <article key={alert.id}><div><strong>{alert.title}</strong><span>{alert.summary}</span><small>{formatOperationalDateTime(alert.createdAt)}</small></div><TimeButton disabled={mutation.isPending} onClick={() => mutation.mutate(alert.id)} variant="secondary">Acknowledge</TimeButton></article>)}</section>
}
