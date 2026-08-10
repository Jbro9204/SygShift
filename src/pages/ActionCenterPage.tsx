import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  BookOpenCheck,
  CalendarCheck2,
  CheckCircle2,
  Download,
  ExternalLink,
  FileCheck2,
  Megaphone,
  Plus,
} from 'lucide-react'
import { getSessionContext } from '../data/auth'
import {
  completeEmployeeAction,
  getEmployeeActionCenter,
  getEmployeeActionComplianceReport,
  getTrainingCatalog,
  markEmployeeActionViewed,
  publishTrainingVersion,
  trainingComplianceCsv,
  type EmployeeActionCenter,
  type TrainingAction,
} from '../data/actionCenter'
import { getScheduleBuilderOptions } from '../data/schedule'
import { getSites } from '../data/workforce'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { isSupabaseConfigured } from '../lib/supabase'

function formatDate(value: string | null | undefined): string {
  if (!value) return 'No due date'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(value))
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'Not yet'
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(value))
}

function downloadText(content: string, name: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

function ActionStatus({ status }: { status: string }) {
  return <span className={`action-status action-status--${status}`}>{status.replaceAll('_', ' ')}</span>
}

function TrainingMaterial({ item }: { item: TrainingAction }) {
  if (!item.contentUrl) return null
  return (
    <a className="secondary-button secondary-button--small" href={item.contentUrl} rel="noreferrer" target="_blank">
      <ExternalLink aria-hidden="true" size={16} />
      Open {item.contentType.replace('_', ' ')}
    </a>
  )
}

function EmployeeActions({ data, busyId, onOpen, onComplete }: {
  data: EmployeeActionCenter
  busyId: string | null
  onOpen: (type: 'announcement' | 'training' | 'schedule', id: string) => void
  onComplete: (type: 'announcement' | 'training' | 'schedule', id: string, attestation?: string) => void
}) {
  const empty = data.summary.announcementCount + data.summary.trainingCount + data.summary.scheduleCount === 0
  if (empty) {
    return (
      <section className="panel action-center-empty">
        <CheckCircle2 aria-hidden="true" size={34} />
        <h2>You are up to date</h2>
        <p>New required announcements, training, and published schedules will appear here.</p>
      </section>
    )
  }

  return (
    <div className="action-center-sections">
      {data.announcements.length ? (
        <section className="panel action-section">
          <div className="section-heading"><div><p className="eyebrow">Announcements</p><h2>Required reading</h2></div></div>
          <div className="action-item-list">
            {data.announcements.map((item) => (
              <article className="action-item" key={item.id} onClick={() => onOpen('announcement', item.id)}>
                <div className="action-item__icon"><Megaphone aria-hidden="true" size={22} /></div>
                <div className="action-item__body">
                  <div className="action-item__title"><h3>{item.title}</h3><ActionStatus status={item.status} /></div>
                  <p>{item.body}</p>
                  <small>Version {item.version} · Due {formatDate(item.dueAt)} · Viewed {formatDateTime(item.viewedAt)}</small>
                </div>
                <button className="primary-action" disabled={busyId === item.id} onClick={(event) => {
                  event.stopPropagation()
                  onComplete('announcement', item.id)
                }} type="button">
                  {busyId === item.id ? 'Saving…' : 'I acknowledge that I have received and reviewed this announcement.'}
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {data.training.length ? (
        <section className="panel action-section">
          <div className="section-heading"><div><p className="eyebrow">Training</p><h2>Assigned training</h2></div></div>
          <div className="action-item-list">
            {data.training.map((item) => (
              <article className="action-item" key={item.id} onClick={() => onOpen('training', item.id)}>
                <div className="action-item__icon"><BookOpenCheck aria-hidden="true" size={22} /></div>
                <div className="action-item__body">
                  <div className="action-item__title"><h3>{item.title}</h3><ActionStatus status={item.status} /></div>
                  {item.description ? <p>{item.description}</p> : null}
                  {item.instructions ? <div className="action-instructions">{item.instructions}</div> : null}
                  <small>Version {item.version} · Effective {formatDate(item.effectiveOn)} · Due {formatDate(item.dueAt)}</small>
                  <TrainingMaterial item={item} />
                </div>
                <button className="primary-action" disabled={busyId === item.id} onClick={(event) => {
                  event.stopPropagation()
                  onComplete('training', item.id, 'I completed and reviewed this training.')
                }} type="button">
                  {busyId === item.id ? 'Saving…' : 'I completed and reviewed this training.'}
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {data.schedules.length ? (
        <section className="panel action-section">
          <div className="section-heading"><div><p className="eyebrow">Schedules</p><h2>Published schedules to review</h2></div></div>
          <div className="action-item-list">
            {data.schedules.map((item) => (
              <article className="action-item" key={item.id} onClick={() => onOpen('schedule', item.id)}>
                <div className="action-item__icon"><CalendarCheck2 aria-hidden="true" size={22} /></div>
                <div className="action-item__body">
                  <div className="action-item__title"><h3>Week of {formatDate(item.weekStartsOn)}</h3><ActionStatus status={item.status} /></div>
                  <p>Published revision {item.scheduleRevision} on {formatDateTime(item.publishedAt)}.</p>
                  <div className="schedule-ack-shifts">
                    {item.shifts.map((shift) => (
                      <div key={shift.shiftId}>
                        <strong>{formatDateTime(shift.startsAt)} – {formatDateTime(shift.endsAt)}</strong>
                        <span>{shift.siteName ?? shift.eventName ?? 'Assigned location'}{shift.postName ? ` · ${shift.postName}` : ''}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <button className="primary-action" disabled={busyId === item.id} onClick={(event) => {
                  event.stopPropagation()
                  onComplete('schedule', item.id)
                }} type="button">
                  {busyId === item.id ? 'Saving…' : 'Acknowledge Schedule'}
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function TrainingEditor({ onClose, onPublished }: { onClose: () => void; onPublished: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const catalogQuery = useQuery({ queryKey: ['training-catalog'], queryFn: getTrainingCatalog })
  const optionsQuery = useQuery({ queryKey: ['schedule-builder-options'], queryFn: getScheduleBuilderOptions })
  const sitesQuery = useQuery({ queryKey: ['sites'], queryFn: getSites })
  const mutation = useMutation({
    mutationFn: publishTrainingVersion,
    onSuccess: onPublished,
    onError: (nextError: Error) => setError(nextError.message),
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const selected = String(form.get('courseId') ?? '')
    mutation.mutate({
      courseId: selected || null,
      code: String(form.get('code') ?? ''),
      title: String(form.get('title') ?? ''),
      description: String(form.get('description') ?? ''),
      contentType: String(form.get('contentType') ?? 'written') as TrainingAction['contentType'],
      contentUrl: String(form.get('contentUrl') ?? ''),
      instructions: String(form.get('instructions') ?? ''),
      effectiveOn: String(form.get('effectiveOn') ?? ''),
      dueAt: String(form.get('dueAt') ?? '') || null,
      employeeIds: form.getAll('employeeIds').map(String),
      roles: form.getAll('roles').map(String) as never,
      siteIds: form.getAll('siteIds').map(String),
      states: String(form.get('states') ?? '').split(',').map((value) => value.trim().toUpperCase()).filter(Boolean),
    })
  }

  return (
    <ModalDialog busy={mutation.isPending} busyLabel="Publishing training…" className="modal-dialog--training" description="Create a new course or publish a new immutable version of an existing course." onClose={onClose} title="Publish training">
      <form className="training-editor" onSubmit={submit}>
        <label className="form-field form-field--wide"><span>Training record</span><select name="courseId"><option value="">New training item</option>{catalogQuery.data?.map((item) => <option key={item.courseId} value={item.courseId}>{item.title} · version {item.currentVersion}</option>)}</select></label>
        <label className="form-field"><span>Code</span><input name="code" placeholder="Example: CA-BATON-01" required /></label>
        <label className="form-field"><span>Title</span><input name="title" required /></label>
        <label className="form-field"><span>Material type</span><select name="contentType"><option value="written">Written instructions</option><option value="document">Document</option><option value="video">Video</option><option value="external_link">External link</option></select></label>
        <label className="form-field"><span>Material link</span><input name="contentUrl" placeholder="https://…" type="url" /></label>
        <label className="form-field"><span>Effective date</span><input name="effectiveOn" required type="date" /></label>
        <label className="form-field"><span>Due date and time</span><input name="dueAt" type="datetime-local" /></label>
        <label className="form-field form-field--wide"><span>Description</span><textarea name="description" rows={3} /></label>
        <label className="form-field form-field--wide"><span>Completion instructions</span><textarea name="instructions" required rows={4} /></label>
        <fieldset className="training-audience"><legend>Assign by role</legend>{['guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin'].map((role) => <label className="check-field" key={role}><input name="roles" type="checkbox" value={role} />{role.replace('_', ' ')}</label>)}</fieldset>
        <label className="form-field"><span>Assign specific employees</span><select multiple name="employeeIds" size={6}>{optionsQuery.data?.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.preferred_name || employee.first_name} {employee.last_name}</option>)}</select></label>
        <label className="form-field"><span>Assign scheduled sites</span><select multiple name="siteIds" size={6}>{sitesQuery.data?.filter((site) => site.active).map((site) => <option key={site.id} value={site.id}>{site.code ? `${site.code} · ` : ''}{site.name}</option>)}</select></label>
        <label className="form-field form-field--wide"><span>Assign employee states</span><input name="states" placeholder="CA, CO" /></label>
        <p className="form-help form-field--wide">At least one employee, role, site, or state audience is required. Publishing an existing training item creates a new version and supersedes incomplete prior assignments.</p>
        {error ? <div className="inline-alert form-field--wide" role="alert">{error}</div> : null}
        <div className="modal-actions form-field--wide"><button className="secondary-button" onClick={onClose} type="button">Cancel</button><button className="primary-action" type="submit"><Plus aria-hidden="true" size={17} />Publish training</button></div>
      </form>
    </ModalDialog>
  )
}

export function ActionCenterPage() {
  const queryClient = useQueryClient()
  const [trainingOpen, setTrainingOpen] = useState(false)
  const sessionQuery = useQuery({ queryKey: ['session-context'], queryFn: getSessionContext, enabled: isSupabaseConfigured })
  const actionQuery = useQuery({ queryKey: ['employee-action-center'], queryFn: getEmployeeActionCenter, enabled: isSupabaseConfigured && sessionQuery.isSuccess })
  const canManage = sessionQuery.data?.role === 'admin' || Boolean(sessionQuery.data?.permissions.includes('training.manage'))
  const canReport = sessionQuery.data?.role === 'admin' || Boolean(sessionQuery.data?.permissions.some((permission) => ['training.export', 'schedule.acknowledgments.manage', 'announcements.acknowledgments.manage'].includes(permission)))
  const reportQuery = useQuery({ queryKey: ['employee-action-report'], queryFn: getEmployeeActionComplianceReport, enabled: isSupabaseConfigured && canReport })
  const [busyId, setBusyId] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: ({ type, id, attestation, viewed }: { type: 'announcement' | 'training' | 'schedule'; id: string; attestation?: string; viewed?: boolean }) => viewed ? markEmployeeActionViewed(type, id) : completeEmployeeAction(type, id, attestation),
    onMutate: ({ id }) => setBusyId(id),
    onSuccess: (data) => queryClient.setQueryData(['employee-action-center'], data),
    onSettled: () => setBusyId(null),
  })

  const summary = useMemo(() => actionQuery.data?.summary, [actionQuery.data])

  if (!isSupabaseConfigured) return <DataStatePanel icon={AlertTriangle} title="Action Center needs the secure connection" tone="setup"><p>Connect Supabase to load employee actions.</p></DataStatePanel>
  if (sessionQuery.isPending || actionQuery.isPending) return <DataStatePanel icon={FileCheck2} title="Loading Action Center"><p>Checking required employee actions.</p></DataStatePanel>
  if (sessionQuery.isError || actionQuery.isError) return <DataStatePanel icon={AlertTriangle} title="Action Center unavailable" tone="error"><p>{sessionQuery.error?.message ?? actionQuery.error?.message}</p></DataStatePanel>

  return (
    <div className="page page--action-center">
      <section className="page-intro workforce-intro"><div><p className="eyebrow">Employee actions</p><h1>Action Center</h1><p className="page-summary">Review required announcements, assigned training, and published schedule updates in one clear workspace.</p></div>{canManage ? <button className="primary-action" onClick={() => setTrainingOpen(true)} type="button"><Plus aria-hidden="true" size={18} />Publish training</button> : null}</section>
      <section className="action-summary" aria-label="Pending actions"><article><Megaphone aria-hidden="true" size={20} /><span>Announcements</span><strong>{summary?.announcementCount ?? 0}</strong></article><article><BookOpenCheck aria-hidden="true" size={20} /><span>Training</span><strong>{summary?.trainingCount ?? 0}</strong></article><article><CalendarCheck2 aria-hidden="true" size={20} /><span>Schedules</span><strong>{summary?.scheduleCount ?? 0}</strong></article></section>
      {mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}
      <EmployeeActions data={actionQuery.data!} busyId={busyId} onOpen={(type, id) => mutation.mutate({ type, id, viewed: true })} onComplete={(type, id, attestation) => mutation.mutate({ type, id, attestation })} />
      {canReport ? <section className="panel action-report"><div className="section-heading"><div><p className="eyebrow">Compliance</p><h2>Completion reporting</h2></div><button className="secondary-button" disabled={!reportQuery.data} onClick={() => reportQuery.data && downloadText(trainingComplianceCsv(reportQuery.data), `sygshift-training-completion-${new Date().toISOString().slice(0, 10)}.csv`)} type="button"><Download aria-hidden="true" size={17} />Export training</button></div><div className="action-report-grid"><article><span>Announcement records</span><strong>{reportQuery.data?.announcements.length ?? 0}</strong></article><article><span>Training records</span><strong>{reportQuery.data?.training.length ?? 0}</strong></article><article><span>Schedule records</span><strong>{reportQuery.data?.schedules.length ?? 0}</strong></article></div></section> : null}
      {trainingOpen ? <TrainingEditor onClose={() => setTrainingOpen(false)} onPublished={async () => { setTrainingOpen(false); await Promise.all([queryClient.invalidateQueries({ queryKey: ['training-catalog'] }), queryClient.invalidateQueries({ queryKey: ['employee-action-center'] }), queryClient.invalidateQueries({ queryKey: ['employee-action-report'] })]) }} /> : null}
    </div>
  )
}
