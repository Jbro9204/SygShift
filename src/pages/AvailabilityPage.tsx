import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addDays, format } from 'date-fns'
import { CalendarCheck2, DatabaseZap, ShieldAlert } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import {
  decideAvailability,
  getAvailabilityWorkspace,
  submitAvailability,
  type AvailabilityRecord,
} from '../data/availability'
import { isSupabaseConfigured } from '../lib/supabase'
import { operationalToday } from '../lib/time'

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  }).format(new Date(`${value}T12:00:00`))
}

function formatTime(value: string | null): string {
  if (!value) return 'All day'
  const [hoursText, minutesText] = value.split(':')
  const hours = Number(hoursText)
  const suffix = hours >= 12 ? 'PM' : 'AM'
  return `${hours % 12 || 12}:${minutesText} ${suffix}`
}

function dateRange(record: Pick<AvailabilityRecord, 'startsOn' | 'endsOn'>): string {
  const start = formatDate(record.startsOn)
  const end = formatDate(record.endsOn)
  return start === end ? start : `${start} - ${end}`
}

function AvailabilityCard({
  record,
  onDecision,
  pending,
}: {
  record: AvailabilityRecord
  onDecision?: (record: AvailabilityRecord, decision: 'approved' | 'declined') => void
  pending?: boolean
}) {
  return (
    <article className="availability-card">
      <div>
        <span className={`status-badge status-badge--${record.approvalStatus}`}>{record.approvalStatus}</span>
        <h3>{record.employeeName}</h3>
        <p>
          {record.availabilityStatus === 'available' ? 'Available' : 'Unavailable'} · {dateRange(record)}
          {record.dayOfWeek !== null ? ` · ${dayNames[record.dayOfWeek]}` : ''}
        </p>
        <small>{formatTime(record.startTime)}{record.endTime ? ` - ${formatTime(record.endTime)}` : ''}</small>
        {record.note ? <blockquote>{record.note}</blockquote> : null}
        {record.decisionNote ? <small>Decision note: {record.decisionNote}</small> : null}
      </div>
      {record.approvalStatus === 'pending' && onDecision ? (
        <div className="approval-actions">
          <button className="secondary-button" disabled={pending} onClick={() => onDecision(record, 'declined')} type="button">
            Decline
          </button>
          <button className="primary-action" disabled={pending} onClick={() => onDecision(record, 'approved')} type="button">
            Approve
          </button>
        </div>
      ) : null}
    </article>
  )
}

export function AvailabilityPage() {
  const queryClient = useQueryClient()
  const todayKey = format(operationalToday(), 'yyyy-MM-dd')
  const throughKey = format(addDays(operationalToday(), 42), 'yyyy-MM-dd')
  const [message, setMessage] = useState<string | null>(null)
  const availabilityQuery = useQuery({
    queryKey: ['availability-workspace', todayKey, throughKey],
    queryFn: () => getAvailabilityWorkspace(todayKey, throughKey),
    enabled: isSupabaseConfigured,
  })
  const privileged = availabilityQuery.data
    ? ['dispatcher', 'scheduler', 'supervisor', 'admin'].includes(availabilityQuery.data.role)
    : false
  const pendingRecords = useMemo(
    () => (availabilityQuery.data?.availability ?? []).filter((record) => record.approvalStatus === 'pending'),
    [availabilityQuery.data?.availability],
  )
  const approvedRecords = useMemo(
    () => (availabilityQuery.data?.availability ?? []).filter((record) => record.approvalStatus === 'approved'),
    [availabilityQuery.data?.availability],
  )
  const submitMutation = useMutation({
    mutationFn: submitAvailability,
    onSuccess: async () => {
      setMessage(privileged ? 'Availability saved and approved.' : 'Availability submitted for review.')
      await queryClient.invalidateQueries({ queryKey: ['availability-workspace'] })
      await queryClient.invalidateQueries({ queryKey: ['schedule-staffing-suggestions'] })
    },
  })
  const decisionMutation = useMutation({
    mutationFn: (input: { requestId: string; decision: 'approved' | 'declined'; note: string | null }) =>
      decideAvailability(input.requestId, input.decision, input.note),
    onSuccess: async (_result, input) => {
      setMessage(`Availability ${input.decision}.`)
      await queryClient.invalidateQueries({ queryKey: ['availability-workspace'] })
      await queryClient.invalidateQueries({ queryKey: ['schedule-staffing-suggestions'] })
    },
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    submitMutation.mutate({
      employeeId: String(form.get('employeeId') || '') || null,
      startsOn: String(form.get('startsOn')),
      endsOn: String(form.get('endsOn')),
      dayOfWeek: String(form.get('dayOfWeek') || '') === '' ? null : Number(form.get('dayOfWeek')),
      startTime: String(form.get('startTime') || '') || null,
      endTime: String(form.get('endTime') || '') || null,
      availabilityStatus: String(form.get('availabilityStatus')) === 'available' ? 'available' : 'unavailable',
      note: String(form.get('note') || '').trim() || null,
    }, {
      onSuccess: () => formElement.reset(),
    })
  }

  return (
    <div className="page page--workforce">
      <section className="page-intro workforce-intro">
        <div>
          <p className="eyebrow">Workforce</p>
          <h1>Availability</h1>
          <p className="page-summary">
            Employees can record when they are available or unavailable, and schedulers can approve it before building coverage.
          </p>
        </div>
      </section>

      {!isSupabaseConfigured ? (
        <DataStatePanel icon={DatabaseZap} title="Availability needs the secure database" tone="setup">
          <p>Availability requests activate after Supabase is connected.</p>
        </DataStatePanel>
      ) : availabilityQuery.isPending ? (
        <DataStatePanel icon={CalendarCheck2} title="Loading availability">
          <p>Checking availability and pending review items.</p>
        </DataStatePanel>
      ) : availabilityQuery.isError ? (
        <DataStatePanel icon={ShieldAlert} title="Availability unavailable" tone="error">
          <p>{availabilityQuery.error.message}</p>
        </DataStatePanel>
      ) : (
        <>
          {message ? <div className="form-feedback form-feedback--success" role="status">{message}</div> : null}
          {submitMutation.isError ? <div className="inline-alert" role="alert">{submitMutation.error.message}</div> : null}
          {decisionMutation.isError ? <div className="inline-alert" role="alert">{decisionMutation.error.message}</div> : null}

          <div className="availability-layout">
            <section className="request-form-card" aria-labelledby="availability-form-title">
              <div className="request-card-heading">
                <CalendarCheck2 aria-hidden="true" size={24} />
                <div>
                  <h2 id="availability-form-title">Add availability</h2>
                  <p>{privileged ? 'Add approved availability for any active employee.' : 'Tell scheduling when you can or cannot work.'}</p>
                </div>
              </div>
              <form className="request-form" onSubmit={submit}>
                {privileged ? (
                  <label className="field-stack">
                    <span>Employee</span>
                    <select name="employeeId" required>
                      <option value="">Choose employee</option>
                      {availabilityQuery.data.employees.map((employee) => (
                        <option key={employee.id} value={employee.id}>{employee.name}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <div className="form-grid">
                  <label>
                    <span>Start date</span>
                    <input min={todayKey} name="startsOn" required type="date" />
                  </label>
                  <label>
                    <span>End date</span>
                    <input min={todayKey} name="endsOn" required type="date" />
                  </label>
                </div>
                <div className="form-grid">
                  <label>
                    <span>Type</span>
                    <select name="availabilityStatus" required>
                      <option value="unavailable">Unavailable</option>
                      <option value="available">Available</option>
                    </select>
                  </label>
                  <label>
                    <span>Repeats on <small>Optional</small></span>
                    <select name="dayOfWeek">
                      <option value="">All selected dates</option>
                      {dayNames.map((day, index) => <option key={day} value={index}>{day}</option>)}
                    </select>
                  </label>
                </div>
                <div className="form-grid">
                  <label>
                    <span>Start time <small>Optional</small></span>
                    <input name="startTime" type="time" />
                  </label>
                  <label>
                    <span>End time <small>Optional</small></span>
                    <input name="endTime" type="time" />
                  </label>
                </div>
                <label className="field-stack">
                  <span>Note <small>Optional</small></span>
                  <textarea maxLength={2000} name="note" rows={3} />
                </label>
                <button className="primary-action" disabled={submitMutation.isPending} type="submit">
                  {submitMutation.isPending ? 'Saving...' : 'Save availability'}
                </button>
              </form>
            </section>

            {privileged ? (
              <section className="panel availability-panel" aria-labelledby="availability-review-title">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Review</p>
                    <h2 id="availability-review-title">Pending availability</h2>
                  </div>
                </div>
                {pendingRecords.length ? pendingRecords.map((record) => (
                  <AvailabilityCard
                    key={record.id}
                    onDecision={(target, decision) => {
                      const note = decision === 'declined' ? window.prompt('Decline note required')?.trim() ?? '' : null
                      if (decision === 'declined' && !note) return
                      decisionMutation.mutate({ requestId: target.id, decision, note })
                    }}
                    pending={decisionMutation.isPending}
                    record={record}
                  />
                )) : <p className="empty-note">No availability requests are waiting.</p>}
              </section>
            ) : null}

            <section className="panel availability-panel" aria-labelledby="approved-availability-title">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">{privileged ? 'Planning' : 'My records'}</p>
                  <h2 id="approved-availability-title">Approved availability</h2>
                </div>
              </div>
              {approvedRecords.length ? approvedRecords.map((record) => (
                <AvailabilityCard key={record.id} record={record} />
              )) : <p className="empty-note">No approved availability is on file for the next six weeks.</p>}
            </section>
          </div>
        </>
      )}
    </div>
  )
}
