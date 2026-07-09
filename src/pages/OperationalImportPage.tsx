import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  CalendarCheck,
  CheckCircle2,
  CircleAlert,
  DatabaseZap,
  ListChecks,
  ShieldAlert,
  UserRoundCheck,
  UsersRound,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { getImportReviewSummary } from '../data/importReview'
import {
  acceptScheduleScope,
  getAssigneeAliasQueue,
  getEmployeeMappingOptions,
  getEmployeeMappingQueue,
  getImportMappingReadiness,
  getShiftExceptionQueue,
  getSiteMappingQueue,
  promoteImportScope,
  saveAssigneeAliasMapping,
  saveEmployeeMapping,
  saveScheduleOnlyEmployee,
  saveShiftOverride,
  saveSiteMapping,
  verifiedCurrentImportScope,
  verifiedCurrentScopeBaseline,
  type AssigneeAliasQueueItem,
  type EmployeeMappingInput,
  type EmployeeMappingOption,
  type EmployeeMappingQueueItem,
  type ImportReadiness,
  type ShiftException,
  type SiteMappingQueueItem,
} from '../data/importMapping'
import { isSupabaseConfigured } from '../lib/supabase'

type WorkArea = 'employees' | 'sites' | 'aliases' | 'exceptions'
type EditorState =
  | { type: 'employee'; item: EmployeeMappingQueueItem }
  | { type: 'site'; item: SiteMappingQueueItem }
  | { type: 'alias'; item: AssigneeAliasQueueItem }
  | { type: 'schedule-person'; item: AssigneeAliasQueueItem }
  | { type: 'exception'; item: ShiftException }
  | { type: 'accept-schedules' }
  | { type: 'promote' }

type MappingAction =
  | { type: 'employee'; input: EmployeeMappingInput }
  | { type: 'site'; input: Parameters<typeof saveSiteMapping>[0] }
  | { type: 'alias'; input: Parameters<typeof saveAssigneeAliasMapping>[0] }
  | { type: 'schedule-person'; input: Parameters<typeof saveScheduleOnlyEmployee>[0] }
  | { type: 'exception'; input: Parameters<typeof saveShiftOverride>[0] }
  | { type: 'accept-schedules'; importRunId: string; note: string }
  | { type: 'promote'; importRunId: string; publish: boolean; note: string }

const scope = verifiedCurrentImportScope

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

function payloadText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

function payloadBoolean(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true
}

function suggestedNameParts(displayName: string): { first: string; middle: string; last: string } {
  const parts = displayName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 1) return { first: parts[0] ?? '', middle: '', last: '' }
  return {
    first: parts[0] ?? '',
    middle: parts.length > 2 ? parts.slice(1, -1).join(' ') : '',
    last: parts.at(-1) ?? '',
  }
}

function MappingProgress({ label, complete, total }: { label: string; complete: number; total: number }) {
  const percent = total === 0 ? 0 : Math.round((complete / total) * 100)
  return (
    <article className={complete === total && total > 0 ? 'mapping-progress mapping-progress--complete' : 'mapping-progress'}>
      <div><span>{label}</span><strong>{complete} / {total}</strong></div>
      <div className="mapping-progress__track" aria-label={`${label}: ${percent}% complete`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={{ width: `${percent}%` }} />
      </div>
    </article>
  )
}

function VerifiedMappingSetup() {
  const baseline = verifiedCurrentScopeBaseline
  return (
    <>
      <section className="import-status-card" aria-labelledby="mapping-foundation-title">
        <div className="import-status-card__icon"><ListChecks aria-hidden="true" size={29} /></div>
        <div>
          <p className="eyebrow">Operational mapping foundation complete</p>
          <h2 id="mapping-foundation-title">The current schedule is reduced to a manageable review.</h2>
          <p>
            Reusable employees, sites, and schedule labels are mapped once. SygShift then derives each
            shift with source provenance and stops the transaction if qualifications or assignments conflict.
          </p>
        </div>
        <span className="import-state-pill"><CheckCircle2 aria-hidden="true" size={17} /> Guarded</span>
      </section>

      <section className="mapping-scope-card" aria-labelledby="verified-scope-title">
        <div>
          <p className="eyebrow">Verified current scope</p>
          <h2 id="verified-scope-title">June 28 through August 15, 2026</h2>
          <p>Seven unique workbook weeks covering the current and future schedule.</p>
        </div>
        <div className="mapping-scope-card__totals">
          <div><strong>{formatNumber(baseline.shifts)}</strong><span>shifts</span></div>
          <div><strong>{baseline.sourceOpenShifts}</strong><span>source openings</span></div>
          <div><strong>{baseline.scheduleWeeks}</strong><span>schedule weeks</span></div>
        </div>
      </section>

      <section className="mapping-setup-grid" aria-label="Operational mapping workload">
        <article><UsersRound aria-hidden="true" size={23} /><strong>{baseline.employeeCandidates}</strong><span>Directory records to confirm</span></article>
        <article><Building2 aria-hidden="true" size={23} /><strong>{baseline.siteKeys}</strong><span>Current site/post contexts</span></article>
        <article><UserRoundCheck aria-hidden="true" size={23} /><strong>{baseline.assigneeLabels}</strong><span>Reusable schedule labels</span></article>
        <article><BadgeCheck aria-hidden="true" size={23} /><strong>{baseline.conservativeAliasSuggestions}</strong><span>Conservative name suggestions</span></article>
      </section>

      <DataStatePanel icon={DatabaseZap} title="Ready to connect the protected mapping workspace" tone="setup">
        <p>
          Private names and schedule assignments remain unavailable in this browser until Supabase authentication
          is connected. The mapping forms and atomic promotion transaction are already built.
        </p>
        <ul>
          <li>Nothing reaches the Directory or Schedule until an Admin confirms the mappings.</li>
          <li>Overlapping assignments and unverified armed qualifications block promotion automatically.</li>
          <li>A failed validation rolls back the entire promotion—no partial schedule is left behind.</li>
        </ul>
      </DataStatePanel>
    </>
  )
}

function EmployeeEditor({ item, pending, onClose, onSave }: {
  item: EmployeeMappingQueueItem
  pending: boolean
  onClose: () => void
  onSave: (input: EmployeeMappingInput) => void
}) {
  const sourceName = payloadText(item.source_payload, 'name')
  const name = suggestedNameParts(sourceName)
  const sourceArmed = payloadBoolean(item.source_payload, 'armed')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const value = (key: string) => String(form.get(key) ?? '').trim() || null
    onSave({
      candidateId: item.candidate_id,
      firstName: String(form.get('firstName')).trim(),
      middleName: value('middleName'),
      lastName: String(form.get('lastName')).trim(),
      preferredName: value('preferredName'),
      role: String(form.get('role')) as EmployeeMappingInput['role'],
      employmentType: String(form.get('employmentType')) as EmployeeMappingInput['employmentType'],
      status: String(form.get('status')) as EmployeeMappingInput['status'],
      personalEmail: value('personalEmail'),
      companyEmail: value('companyEmail'),
      mobilePhone: value('mobilePhone'),
      guardLicenseNumber: value('guardLicenseNumber'),
      guardLicenseExpiresOn: value('guardLicenseExpiresOn'),
      armedStatus: String(form.get('armedStatus')) as EmployeeMappingInput['armedStatus'],
      armedCredentialNumber: value('armedCredentialNumber'),
      armedExpiresOn: value('armedExpiresOn'),
      note: String(form.get('note')).trim(),
    })
  }

  return (
    <ModalDialog description={`Workbook Directory record: ${sourceName}`} onClose={onClose} title="Confirm Directory mapping">
      <form className="request-form mapping-form" onSubmit={submit}>
        <div className="source-fact-grid">
          <div><span>Source phone</span><strong>{payloadText(item.source_payload, 'phone') || 'Not provided'}</strong></div>
          <div><span>Source email</span><strong>{payloadText(item.source_payload, 'email') || 'Not provided'}</strong></div>
          <div><span>Guard card source</span><strong>{payloadText(item.source_payload, 'guardCard') || 'Not provided'}</strong></div>
          <div><span>Armed convention</span><strong>{sourceArmed ? 'Bold / armed indicated' : 'Unarmed indicated'}</strong></div>
        </div>
        <div className="form-grid form-grid--three">
          <label><span>First name</span><input defaultValue={name.first} name="firstName" required /></label>
          <label><span>Middle name</span><input defaultValue={name.middle} name="middleName" /></label>
          <label><span>Last name</span><input defaultValue={name.last} name="lastName" required /></label>
        </div>
        <div className="form-grid form-grid--three">
          <label><span>Preferred name</span><input name="preferredName" /></label>
          <label><span>Role</span><select defaultValue={payloadText(item.source_payload, 'roleCandidate') || 'guard'} name="role"><option value="guard">Guard</option><option value="dispatcher">Dispatcher</option><option value="scheduler">Scheduler</option><option value="supervisor">Supervisor</option><option value="admin">Admin</option></select></label>
          <label><span>Employment</span><select defaultValue="hourly" name="employmentType"><option value="hourly">Hourly</option><option value="salary">Salary</option></select></label>
        </div>
        <div className="form-grid form-grid--three">
          <label><span>Status</span><select defaultValue={payloadText(item.source_payload, 'statusCandidate') || 'active'} name="status"><option value="active">Active</option><option value="leave">On leave</option><option value="inactive">Inactive</option><option value="separated">Separated</option></select></label>
          <label><span>Personal email</span><input defaultValue={payloadText(item.source_payload, 'email')} name="personalEmail" type="email" /></label>
          <label><span>Mobile phone</span><input defaultValue={payloadText(item.source_payload, 'phone')} name="mobilePhone" /></label>
        </div>
        <div className="form-grid form-grid--three">
          <label><span>Company email</span><input name="companyEmail" type="email" /></label>
          <label><span>Guard license number</span><input name="guardLicenseNumber" /></label>
          <label><span>Guard license expiration</span><input name="guardLicenseExpiresOn" type="date" /></label>
        </div>
        <div className="form-grid form-grid--three">
          <label><span>Armed credential</span><select defaultValue={sourceArmed ? 'pending_verification' : 'not_armed'} name="armedStatus"><option value="not_armed">Not armed</option><option value="pending_verification">Pending verification</option><option value="active">Verified active</option></select></label>
          <label><span>Armed credential number</span><input name="armedCredentialNumber" /></label>
          <label><span>Armed credential expiration</span><input name="armedExpiresOn" type="date" /></label>
        </div>
        <label className="field-stack"><span>Review note</span><textarea defaultValue="Confirmed against the workbook Directory source row." maxLength={4000} name="note" required rows={3} /></label>
        <p className="form-note">Active armed status requires both a credential number and a current expiration date.</p>
        <div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Cancel</button><button className="primary-action" disabled={pending} type="submit">{pending ? 'Saving…' : 'Save Directory mapping'}</button></div>
      </form>
    </ModalDialog>
  )
}

function SiteEditor({ item, pending, onClose, onSave }: {
  item: SiteMappingQueueItem
  pending: boolean
  onClose: () => void
  onSave: (input: Parameters<typeof saveSiteMapping>[0]) => void
}) {
  const labels = Array.isArray(item.source_payload.labelVariants) ? item.source_payload.labelVariants.filter((value): value is string => typeof value === 'string') : []
  const sourceLabel = labels[0] ?? item.candidate_key
  const qualification = payloadText(item.source_payload, 'qualificationCandidate')
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    onSave({
      candidateId: item.candidate_id,
      canonicalSiteKey: String(form.get('canonicalSiteKey')).trim(),
      siteCode: String(form.get('siteCode')).trim() || null,
      siteName: String(form.get('siteName')).trim(),
      postName: String(form.get('postName')).trim(),
      requiresArmed: String(form.get('requiresArmed')) === 'true',
      active: true,
      note: String(form.get('note')).trim(),
    })
  }
  return (
    <ModalDialog description={`${item.scope_shift_count} shifts use this workbook context.`} onClose={onClose} title="Confirm site and post mapping">
      <form className="request-form mapping-form" onSubmit={submit}>
        <div className="source-callout"><strong>Workbook label</strong><span>{labels.join(' · ') || sourceLabel}</span><small>Qualification evidence: {qualification || 'unknown'}</small></div>
        <div className="form-grid">
          <label><span>Canonical site key</span><input defaultValue={item.candidate_key} name="canonicalSiteKey" required /></label>
          <label><span>Site code</span><input name="siteCode" /></label>
        </div>
        <div className="form-grid">
          <label><span>Site name</span><input defaultValue={sourceLabel} name="siteName" required /></label>
          <label><span>Post name</span><input defaultValue="Primary Post" name="postName" required /></label>
        </div>
        <label className="field-stack"><span>Qualification</span><select defaultValue={qualification === 'armed' ? 'true' : 'false'} name="requiresArmed"><option value="false">Unarmed</option><option value="true">Armed</option></select></label>
        <label className="field-stack"><span>Review note</span><textarea defaultValue="Confirmed the workbook context, canonical site, post, and qualification requirement." maxLength={4000} name="note" required rows={3} /></label>
        <div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Cancel</button><button className="primary-action" disabled={pending} type="submit">{pending ? 'Saving…' : 'Save site mapping'}</button></div>
      </form>
    </ModalDialog>
  )
}

function AssignmentEditor({
  title,
  description,
  options,
  pending,
  onClose,
  onSave,
}: {
  title: string
  description: string
  options: EmployeeMappingOption[]
  pending: boolean
  onClose: () => void
  onSave: (disposition: 'employee' | 'open' | 'exclude', employeeKeys: string[], note: string) => void
}) {
  const [disposition, setDisposition] = useState<'employee' | 'open' | 'exclude'>('employee')
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const employeeKey = String(form.get('employeeKey') ?? '')
    onSave(disposition, disposition === 'employee' ? [employeeKey] : [], String(form.get('note')).trim())
  }
  return (
    <ModalDialog description={description} onClose={onClose} title={title}>
      <form className="request-form mapping-form" onSubmit={submit}>
        <label className="field-stack"><span>Resolution</span><select value={disposition} onChange={(event) => setDisposition(event.target.value as typeof disposition)}><option value="employee">Map to reviewed employee</option><option value="open">Treat as an open shift</option><option value="exclude">Exclude this source shift</option></select></label>
        {disposition === 'employee' ? <label className="field-stack"><span>Reviewed employee</span><select name="employeeKey" required><option value="">Select employee</option>{options.map((option) => <option key={option.mapping_key} value={option.mapping_key}>{option.display_name} · {option.employee_status}</option>)}</select></label> : null}
        <label className="field-stack"><span>Decision note</span><textarea maxLength={4000} name="note" required rows={4} /></label>
        <div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Cancel</button><button className="primary-action" disabled={pending || (disposition === 'employee' && options.length === 0)} type="submit">{pending ? 'Saving…' : 'Save resolution'}</button></div>
      </form>
    </ModalDialog>
  )
}

function SchedulePersonEditor({ item, pending, onClose, onSave }: {
  item: AssigneeAliasQueueItem
  pending: boolean
  onClose: () => void
  onSave: (input: Parameters<typeof saveScheduleOnlyEmployee>[0]) => void
}) {
  const sourceLabel = item.label_variants[0] ?? ''
  const name = suggestedNameParts(sourceLabel)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    onSave({
      importRunId: '',
      sourceLabel,
      firstName: String(form.get('firstName')).trim(),
      middleName: String(form.get('middleName')).trim() || null,
      lastName: String(form.get('lastName')).trim(),
      status: String(form.get('status')) as 'active' | 'inactive' | 'separated',
      note: String(form.get('note')).trim(),
    })
  }
  return (
    <ModalDialog description={`Schedule label: ${sourceLabel}`} onClose={onClose} title="Create a schedule-only employee">
      <form className="request-form mapping-form" onSubmit={submit}>
        <p className="modal-warning">Use this only when the schedule names a real employee who is absent from the workbook Directory.</p>
        <div className="form-grid form-grid--three"><label><span>First name</span><input defaultValue={name.first} name="firstName" required /></label><label><span>Middle name</span><input defaultValue={name.middle} name="middleName" /></label><label><span>Last name</span><input defaultValue={name.last} name="lastName" required /></label></div>
        <label className="field-stack"><span>Historical status</span><select defaultValue="separated" name="status"><option value="active">Active</option><option value="inactive">Inactive</option><option value="separated">Separated</option></select></label>
        <label className="field-stack"><span>Decision note</span><textarea defaultValue="Confirmed this schedule label represents a person missing from the workbook Directory." maxLength={4000} name="note" required rows={4} /></label>
        <div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Cancel</button><button className="primary-action" disabled={pending} type="submit">{pending ? 'Saving…' : 'Create employee and map label'}</button></div>
      </form>
    </ModalDialog>
  )
}

function ConfirmationEditor({ type, pending, onClose, onSave }: {
  type: 'accept-schedules' | 'promote'
  pending: boolean
  onClose: () => void
  onSave: (note: string, publish: boolean) => void
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    onSave(String(form.get('note')).trim(), form.get('publish') === 'on')
  }
  const promotion = type === 'promote'
  return (
    <ModalDialog description={promotion ? 'This transaction creates the reviewed operational records atomically.' : 'This records approval of seven unique weekly schedule structures.'} onClose={onClose} title={promotion ? 'Promote reviewed schedule scope' : 'Accept schedule weeks'}>
      <form className="request-form mapping-form" onSubmit={submit}>
        {promotion ? <label className="check-field"><input name="publish" type="checkbox" /><span>Publish immediately for guards after successful promotion</span></label> : null}
        <label className="field-stack"><span>Audit note</span><textarea defaultValue={promotion ? 'Promote the fully reviewed current and future schedule scope.' : 'Confirmed the seven unique current and future workbook schedule weeks.'} maxLength={4000} name="note" required rows={4} /></label>
        <p className="form-note">Any conflict rolls back the entire transaction. No partial Directory or schedule will remain.</p>
        <div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Cancel</button><button className="primary-action" disabled={pending} type="submit">{pending ? 'Working…' : promotion ? 'Promote reviewed scope' : 'Accept schedule weeks'}</button></div>
      </form>
    </ModalDialog>
  )
}

function ReadinessHeader({ readiness, onAcceptSchedules, onPromote }: { readiness: ImportReadiness; onAcceptSchedules: () => void; onPromote: () => void }) {
  return (
    <>
      <section className="mapping-scope-card" aria-labelledby="live-scope-title">
        <div><p className="eyebrow">Current operational scope</p><h2 id="live-scope-title">June 28 through August 15, 2026</h2><p>{formatNumber(readiness.shiftCandidateCount)} source shifts across {readiness.scheduleCandidateCount} unique weeks.</p></div>
        <div className="scope-actions">
          {readiness.acceptedScheduleCount < readiness.scheduleCandidateCount ? <button className="secondary-button" onClick={onAcceptSchedules} type="button"><CalendarCheck aria-hidden="true" size={18} /> Accept weeks</button> : null}
          <button className="primary-action" disabled={!readiness.scheduleReady} onClick={onPromote} type="button">Promote reviewed scope <ArrowRight aria-hidden="true" size={18} /></button>
        </div>
      </section>
      <section className="mapping-progress-grid" aria-label="Import mapping completion">
        <MappingProgress complete={readiness.directoryEmployeeMappingCount} label="Directory" total={readiness.employeeCandidateCount} />
        <MappingProgress complete={readiness.siteMappingCount} label="Sites & Posts" total={readiness.siteKeyCount} />
        <MappingProgress complete={readiness.aliasMappingCount} label="Schedule names" total={readiness.assigneeLabelCount} />
        <MappingProgress complete={readiness.acceptedScheduleCount} label="Schedule weeks" total={readiness.scheduleCandidateCount} />
      </section>
      {readiness.assignmentOverlapConflictCount + readiness.qualificationConflictCount + readiness.missingContextShiftCount > 0 ? (
        <div className="inline-alert" role="alert">
          Resolve {readiness.assignmentOverlapConflictCount} overlapping assignment pair{readiness.assignmentOverlapConflictCount === 1 ? '' : 's'}, {readiness.qualificationConflictCount} qualification conflict{readiness.qualificationConflictCount === 1 ? '' : 's'}, and {readiness.missingContextShiftCount} missing location context{readiness.missingContextShiftCount === 1 ? '' : 's'} before promotion.
        </div>
      ) : null}
    </>
  )
}

function LiveOperationalImport() {
  const queryClient = useQueryClient()
  const [workArea, setWorkArea] = useState<WorkArea>('employees')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const summaryQuery = useQuery({ queryKey: ['import-review-summary'], queryFn: getImportReviewSummary })
  const importRunId = summaryQuery.data?.importRunId
  const readinessQuery = useQuery({ queryKey: ['import-mapping-readiness', importRunId, scope], queryFn: () => getImportMappingReadiness(importRunId!, scope), enabled: Boolean(importRunId) })
  const employeesQuery = useQuery({ queryKey: ['import-employee-mappings', importRunId], queryFn: () => getEmployeeMappingQueue(importRunId!), enabled: Boolean(importRunId && workArea === 'employees') })
  const sitesQuery = useQuery({ queryKey: ['import-site-mappings', importRunId, scope], queryFn: () => getSiteMappingQueue(importRunId!, scope), enabled: Boolean(importRunId && workArea === 'sites') })
  const aliasesQuery = useQuery({ queryKey: ['import-alias-mappings', importRunId, scope], queryFn: () => getAssigneeAliasQueue(importRunId!, scope), enabled: Boolean(importRunId && workArea === 'aliases') })
  const exceptionsQuery = useQuery({ queryKey: ['import-shift-exceptions', importRunId, scope], queryFn: () => getShiftExceptionQueue(importRunId!, scope), enabled: Boolean(importRunId && workArea === 'exceptions') })
  const optionsQuery = useQuery({ queryKey: ['import-employee-options', importRunId], queryFn: () => getEmployeeMappingOptions(importRunId!), enabled: Boolean(importRunId && (workArea === 'aliases' || workArea === 'exceptions')) })

  const mutation = useMutation({
    mutationFn: async (action: MappingAction) => {
      if (action.type === 'employee') return saveEmployeeMapping(action.input)
      if (action.type === 'site') return saveSiteMapping(action.input)
      if (action.type === 'alias') return saveAssigneeAliasMapping(action.input)
      if (action.type === 'schedule-person') return saveScheduleOnlyEmployee(action.input)
      if (action.type === 'exception') return saveShiftOverride(action.input)
      if (action.type === 'accept-schedules') return acceptScheduleScope(action.importRunId, scope, action.note)
      return promoteImportScope({ importRunId: action.importRunId, scope, publish: action.publish, note: action.note })
    },
    onSuccess: async () => {
      setEditor(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['import-mapping-readiness'] }),
        queryClient.invalidateQueries({ queryKey: ['import-employee-mappings'] }),
        queryClient.invalidateQueries({ queryKey: ['import-site-mappings'] }),
        queryClient.invalidateQueries({ queryKey: ['import-alias-mappings'] }),
        queryClient.invalidateQueries({ queryKey: ['import-shift-exceptions'] }),
        queryClient.invalidateQueries({ queryKey: ['import-employee-options'] }),
        queryClient.invalidateQueries({ queryKey: ['employee-directory'] }),
        queryClient.invalidateQueries({ queryKey: ['weekly-schedule'] }),
      ])
    },
  })

  const activeQuery = workArea === 'employees' ? employeesQuery : workArea === 'sites' ? sitesQuery : workArea === 'aliases' ? aliasesQuery : exceptionsQuery
  const options = optionsQuery.data ?? []

  if (summaryQuery.isPending || readinessQuery.isPending) return <DataStatePanel icon={ListChecks} title="Loading operational mapping"><p>Verifying Admin access and calculating current-schedule readiness.</p></DataStatePanel>
  if (summaryQuery.isError || readinessQuery.isError) return <DataStatePanel icon={ShieldAlert} title="Operational mapping unavailable" tone="error"><p>{summaryQuery.error?.message ?? readinessQuery.error?.message}</p></DataStatePanel>
  if (!importRunId || !readinessQuery.data) return <DataStatePanel icon={DatabaseZap} title="No protected import is available"><p>Stage and reconcile the workbook before operational mapping.</p></DataStatePanel>

  const readiness = readinessQuery.data
  const tabs: Array<{ id: WorkArea; label: string; count: string }> = [
    { id: 'employees', label: 'Directory', count: `${readiness.directoryEmployeeMappingCount}/${readiness.employeeCandidateCount}` },
    { id: 'sites', label: 'Sites & Posts', count: `${readiness.siteMappingCount}/${readiness.siteKeyCount}` },
    { id: 'aliases', label: 'Schedule names', count: `${readiness.aliasMappingCount}/${readiness.assigneeLabelCount}` },
    { id: 'exceptions', label: 'Shift exceptions', count: String(readiness.assignmentOverlapConflictCount + readiness.qualificationConflictCount) },
  ]

  return (
    <>
      <ReadinessHeader readiness={readiness} onAcceptSchedules={() => setEditor({ type: 'accept-schedules' })} onPromote={() => setEditor({ type: 'promote' })} />
      {mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}
      <section className="mapping-workbench" aria-labelledby="mapping-workbench-title">
        <div className="mapping-workbench__heading"><div><p className="eyebrow">Admin mapping workspace</p><h2 id="mapping-workbench-title">Confirm reusable source meanings</h2></div><span className={readiness.scheduleReady ? 'import-state-pill' : 'import-state-pill import-state-pill--attention'}>{readiness.scheduleReady ? <CheckCircle2 aria-hidden="true" size={17} /> : <CircleAlert aria-hidden="true" size={17} />}{readiness.scheduleReady ? 'Ready to promote' : 'Review in progress'}</span></div>
        <div className="mapping-tabs" role="tablist" aria-label="Operational mapping areas">{tabs.map((tab) => <button aria-selected={workArea === tab.id} className={workArea === tab.id ? 'mapping-tab mapping-tab--active' : 'mapping-tab'} key={tab.id} onClick={() => setWorkArea(tab.id)} role="tab" type="button"><span>{tab.label}</span><strong>{tab.count}</strong></button>)}</div>
        {activeQuery.isPending ? <DataStatePanel icon={ListChecks} title="Loading mapping records"><p>Retrieving the selected protected review queue.</p></DataStatePanel> : activeQuery.isError ? <DataStatePanel icon={ShieldAlert} title="Mapping records unavailable" tone="error"><p>{activeQuery.error.message}</p></DataStatePanel> : null}

        {workArea === 'employees' && employeesQuery.data ? <div className="mapping-list">{employeesQuery.data.map((item) => <article className="mapping-row" key={item.candidate_id}><div className="mapping-row__main"><span className={item.current_mapping ? 'mapping-status mapping-status--done' : 'mapping-status'}>{item.current_mapping ? 'Mapped' : 'Needs review'}</span><h3>{payloadText(item.source_payload, 'name')}</h3><p>{payloadText(item.source_payload, 'section').replaceAll('_', ' ')} · {payloadBoolean(item.source_payload, 'armed') ? 'Armed indicated' : 'Unarmed indicated'}</p></div><div className="mapping-row__source"><span>{payloadText(item.source_payload, 'phone') || 'No phone'}</span><span>{payloadText(item.source_payload, 'email') || 'No email'}</span></div><button className={item.current_mapping ? 'secondary-button' : 'primary-action'} onClick={() => setEditor({ type: 'employee', item })} type="button">{item.current_mapping ? 'Review mapping' : 'Map employee'}</button></article>)}</div> : null}

        {workArea === 'sites' && sitesQuery.data ? <div className="mapping-list">{sitesQuery.data.map((item) => { const labels = Array.isArray(item.source_payload.labelVariants) ? item.source_payload.labelVariants.filter((value): value is string => typeof value === 'string') : []; return <article className="mapping-row" key={item.candidate_id}><div className="mapping-row__main"><span className={item.current_mapping ? 'mapping-status mapping-status--done' : 'mapping-status'}>{item.current_mapping ? 'Mapped' : 'Needs review'}</span><h3>{labels[0] ?? item.candidate_key}</h3><p>{payloadText(item.source_payload, 'qualificationCandidate')} qualification evidence</p></div><div className="mapping-row__source"><strong>{item.scope_shift_count}</strong><span>shifts in scope</span></div><button className={item.current_mapping ? 'secondary-button' : 'primary-action'} onClick={() => setEditor({ type: 'site', item })} type="button">{item.current_mapping ? 'Review mapping' : 'Map site & post'}</button></article> })}</div> : null}

        {workArea === 'aliases' && aliasesQuery.data ? <div className="mapping-list">{aliasesQuery.data.map((item) => { const sourceLabel = item.label_variants[0] ?? item.normalized_label; return <article className="mapping-row" key={item.normalized_label}><div className="mapping-row__main"><span className={item.current_mapping ? 'mapping-status mapping-status--done' : item.suggested_employee_name ? 'mapping-status mapping-status--suggested' : 'mapping-status'}>{item.current_mapping ? 'Mapped' : item.suggested_employee_name ? 'Suggestion available' : 'Needs review'}</span><h3>{item.label_variants.join(' · ')}</h3><p>{item.scope_shift_count} shifts · {item.first_shift_on} through {item.last_shift_on}</p>{item.suggested_employee_name ? <p className="mapping-suggestion">Suggested: {item.suggested_employee_name}</p> : null}</div><div className="mapping-row__actions">{!item.current_mapping && item.suggested_employee_mapping_key ? <button className="secondary-button" disabled={!item.suggestion_ready || mutation.isPending} onClick={() => mutation.mutate({ type: 'alias', input: { importRunId, sourceLabel, disposition: 'employee', employeeMappingKeys: [item.suggested_employee_mapping_key!], note: 'Confirmed the conservative workbook name match.' } })} type="button">Accept suggestion</button> : null}<button className={item.current_mapping ? 'secondary-button' : 'primary-action'} onClick={() => setEditor({ type: 'alias', item })} type="button">{item.current_mapping ? 'Review mapping' : 'Choose mapping'}</button>{!item.current_mapping && !item.suggested_employee_name ? <button className="text-button" onClick={() => setEditor({ type: 'schedule-person', item })} type="button">Create missing employee</button> : null}</div></article> })}</div> : null}

        {workArea === 'exceptions' && exceptionsQuery.data ? exceptionsQuery.data.length === 0 ? <DataStatePanel icon={CheckCircle2} title="No shift exceptions remain"><p>There are no unresolved overlap or qualification conflicts in this scope.</p></DataStatePanel> : <div className="mapping-list">{exceptionsQuery.data.map((item) => <article className="mapping-row mapping-row--exception" key={item.candidate_id}><div className="mapping-row__main"><span className="mapping-status mapping-status--attention">{item.overlap_conflict ? 'Overlapping assignment' : 'Qualification conflict'}</span><h3>{payloadText(item.source_payload, 'contextLabel')}</h3><p>{payloadText(item.source_payload, 'localDate')} · {payloadText(item.source_payload, 'startTime')}–{payloadText(item.source_payload, 'endTime')} · {payloadText(item.source_payload, 'assigneeLabel')}</p></div><button className="primary-action" onClick={() => setEditor({ type: 'exception', item })} type="button">Resolve exception</button></article>)}</div> : null}
      </section>

      {editor?.type === 'employee' ? <EmployeeEditor item={editor.item} onClose={() => setEditor(null)} onSave={(input) => mutation.mutate({ type: 'employee', input })} pending={mutation.isPending} /> : null}
      {editor?.type === 'site' ? <SiteEditor item={editor.item} onClose={() => setEditor(null)} onSave={(input) => mutation.mutate({ type: 'site', input })} pending={mutation.isPending} /> : null}
      {editor?.type === 'alias' ? <AssignmentEditor description={`Schedule label: ${editor.item.label_variants.join(' · ')}`} onClose={() => setEditor(null)} onSave={(disposition, keys, note) => mutation.mutate({ type: 'alias', input: { importRunId, sourceLabel: editor.item.label_variants[0] ?? editor.item.normalized_label, disposition, employeeMappingKeys: keys, note } })} options={options} pending={mutation.isPending} title="Map schedule name" /> : null}
      {editor?.type === 'schedule-person' ? <SchedulePersonEditor item={editor.item} onClose={() => setEditor(null)} onSave={(input) => mutation.mutate({ type: 'schedule-person', input: { ...input, importRunId } })} pending={mutation.isPending} /> : null}
      {editor?.type === 'exception' ? <AssignmentEditor description={`${payloadText(editor.item.source_payload, 'localDate')} · ${payloadText(editor.item.source_payload, 'contextLabel')}`} onClose={() => setEditor(null)} onSave={(disposition, keys, note) => mutation.mutate({ type: 'exception', input: { candidateId: editor.item.candidate_id, disposition, employeeMappingKeys: keys, note } })} options={options} pending={mutation.isPending} title="Resolve shift exception" /> : null}
      {editor?.type === 'accept-schedules' ? <ConfirmationEditor onClose={() => setEditor(null)} onSave={(note) => mutation.mutate({ type: 'accept-schedules', importRunId, note })} pending={mutation.isPending} type="accept-schedules" /> : null}
      {editor?.type === 'promote' ? <ConfirmationEditor onClose={() => setEditor(null)} onSave={(note, publish) => mutation.mutate({ type: 'promote', importRunId, publish, note })} pending={mutation.isPending} type="promote" /> : null}
    </>
  )
}

export function OperationalImportPage() {
  return (
    <div className="page page--operational-import">
      <section className="page-intro workforce-intro">
        <div><p className="eyebrow">Administration</p><h1>Operational import</h1><p className="page-summary">Confirm how workbook people, sites, and schedule labels map into the live Directory and Schedule—then promote them in one controlled, atomic transaction.</p></div>
        <div className="access-note"><ShieldAlert aria-hidden="true" size={19} /> Admin access and MFA required</div>
      </section>
      {isSupabaseConfigured ? <LiveOperationalImport /> : <VerifiedMappingSetup />}
    </div>
  )
}
