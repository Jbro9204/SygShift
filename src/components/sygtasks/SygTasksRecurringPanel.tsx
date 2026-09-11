import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, CheckCircle2, CirclePause, CirclePlay, RefreshCw, SkipForward, StopCircle } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import {
  formatSygTaskPriority,
  getSygTaskRecurringSeries,
  manageSygTaskRecurringSeries,
  sygTaskPath,
  sygTaskPriorities,
  type SygTasksWorkspace,
} from '../../data/sygtasks'
import { formatTaskDue } from '../../lib/sygtasksPresentation'

const frequencyLabels = { daily: 'day', weekly: 'week', monthly: 'month' } as const

function ErrorNotice({ error }: { error: unknown }) {
  return error ? <p className="sygtasks-notice sygtasks-notice--error" role="alert"><span>{error instanceof Error ? error.message : 'The recurring task could not be updated.'}</span></p> : null
}

function scheduleDescription(frequency: keyof typeof frequencyLabels, interval: number) {
  const unit = frequencyLabels[frequency]
  return interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`
}

function reasonLabel(reason: string | null) {
  if (!reason) return null
  return ({
    board_archived: 'The board was archived.',
    canceled_by_user: 'Stopped by an authorized user.',
    owner_inactive: 'Paused because the series owner is inactive.',
    paused_by_user: 'Paused by an authorized user.',
    schedule_complete: 'The planned schedule is complete.',
  } as Record<string, string>)[reason] ?? reason.replaceAll('_', ' ')
}

export function SygTasksRecurringPanel({ taskId, workspace }: { taskId: string; workspace: SygTasksWorkspace }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const query = useQuery({
    queryKey: ['sygtasks', 'recurring-series', taskId],
    queryFn: () => getSygTaskRecurringSeries(taskId),
    refetchOnWindowFocus: true,
  })
  const series = query.data?.series ?? null
  const candidates = useMemo(() => {
    const values = workspace.permissions.manageShared ? workspace.availableMembers : workspace.members
    return [...new Map(values.map((member) => [member.employeeId, member])).values()]
  }, [workspace.availableMembers, workspace.members, workspace.permissions.manageShared])
  const mutation = useMutation({
    mutationFn: ({ action, payload = {} }: { action: 'pause' | 'resume' | 'cancel' | 'skip_next' | 'update_future'; payload?: Record<string, unknown> }) => {
      if (!series) throw new Error('The recurring series is not available.')
      return manageSygTaskRecurringSeries(series.id, action, payload, series.version)
    },
    onSuccess: async () => {
      setEditing(false)
      setConfirmStop(false)
      await queryClient.invalidateQueries({ queryKey: ['sygtasks'] })
    },
  })

  function saveFuture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    mutation.mutate({
      action: 'update_future',
      payload: {
        title: String(data.get('title') ?? '').trim(),
        description: String(data.get('description') ?? '').trim(),
        status: String(data.get('status') ?? 'backlog'),
        priority: String(data.get('priority') ?? 'routine'),
        assigneeId: String(data.get('assigneeId') ?? '') || null,
        reminderKind: String(data.get('reminderKind') ?? 'none'),
        reminderOffsetMinutes: String(data.get('reminderKind') ?? 'none') === 'none' ? null : Number(data.get('reminderOffsetMinutes') ?? 60),
        reminderEmailEnabled: data.get('reminderEmailEnabled') === 'on',
      },
    })
  }

  if (query.isPending) return <div className="sygtasks-recurring-state" role="status"><RefreshCw aria-hidden="true" className="spin" size={19} /><span>Checking this task’s schedule…</span></div>
  if (query.isError) return <><ErrorNotice error={query.error} /><button type="button" className="sygtasks-button sygtasks-button--secondary" onClick={() => void query.refetch()}>Try Again</button></>
  if (!series) return <section className="sygtasks-recurring-empty"><CalendarClock aria-hidden="true" size={30} /><h3>One-time task</h3><p>This task does not belong to a repeating series. Create a new task and choose <strong>Repeat this task</strong> when you need a recurring schedule.</p></section>

  return <div className="sygtasks-recurring">
    <section className="sygtasks-recurring-hero">
      <div><CalendarClock aria-hidden="true" size={24} /><span><small>Recurring series</small><strong>{scheduleDescription(series.frequency, series.intervalCount)}</strong></span></div>
      <span className={`sygtasks-series-status sygtasks-series-status--${series.status}`}>{series.status}</span>
      <dl><div><dt>Next occurrence</dt><dd>{series.status === 'active' ? series.nextOccurrenceOn : 'Not scheduled'}</dd></div><div><dt>Due time</dt><dd>{series.localDueTime} · {series.timeZone.replace('America/', '')}</dd></div><div><dt>Created</dt><dd>{series.generatedCount} task{series.generatedCount === 1 ? '' : 's'}</dd></div><div><dt>Assigned to</dt><dd>{series.assigneeName ?? 'Unassigned'}</dd></div></dl>
      {reasonLabel(series.statusReason) ? <p>{reasonLabel(series.statusReason)}</p> : null}
    </section>

    {series.canManage ? <section className="sygtasks-recurring-controls">
      <header><div><small>Series controls</small><h3>What do you want to do?</h3></div><span>Already-created tasks keep their own progress and history.</span></header>
      <div>
        {series.status === 'active' ? <button type="button" className="sygtasks-button sygtasks-button--secondary" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: 'pause' })}><CirclePause aria-hidden="true" size={17} />Pause future tasks</button> : null}
        {series.status === 'paused' ? <button type="button" className="sygtasks-button sygtasks-button--primary" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: 'resume' })}><CirclePlay aria-hidden="true" size={17} />Resume series</button> : null}
        {series.status === 'active' ? <button type="button" className="sygtasks-button sygtasks-button--secondary" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: 'skip_next' })}><SkipForward aria-hidden="true" size={17} />Skip next</button> : null}
        {series.status === 'active' || series.status === 'paused' ? <button type="button" className="sygtasks-button sygtasks-button--secondary" disabled={mutation.isPending} onClick={() => setEditing((value) => !value)}>Change future tasks</button> : null}
        {series.status === 'active' || series.status === 'paused' ? <button type="button" className="sygtasks-button sygtasks-button--danger" disabled={mutation.isPending} onClick={() => setConfirmStop(true)}><StopCircle aria-hidden="true" size={17} />Stop series</button> : null}
      </div>
    </section> : null}

    {confirmStop ? <section className="sygtasks-recurring-confirm" role="alertdialog" aria-labelledby="stop-series-title"><StopCircle aria-hidden="true" size={28} /><div><h3 id="stop-series-title">Stop all future occurrences?</h3><p>No existing task will be deleted or changed. This series cannot be resumed after it is stopped.</p></div><div><button type="button" className="sygtasks-button sygtasks-button--secondary" onClick={() => setConfirmStop(false)} disabled={mutation.isPending}>Keep Series</button><button type="button" className="sygtasks-button sygtasks-button--danger" onClick={() => mutation.mutate({ action: 'cancel' })} disabled={mutation.isPending}>Stop Future Tasks</button></div></section> : null}

    {editing ? <form className="sygtasks-recurring-edit" onSubmit={saveFuture}>
      <header><small>Future occurrences only</small><h3>Change the task template</h3><p>This occurrence and all previously created tasks stay exactly as they are.</p></header>
      <label><span>Task title</span><input name="title" defaultValue={series.title} required maxLength={240} /></label>
      <label><span>Description <small>Optional</small></span><textarea name="description" defaultValue={series.description} rows={4} maxLength={10000} /></label>
      <div className="sygtasks-form-grid sygtasks-form-grid--two"><label><span>Starting status</span><select name="status" defaultValue={series.initialStatus}><option value="backlog">Backlog</option><option value="ready">Ready</option><option value="in_progress">In progress</option></select></label><label><span>Priority</span><select name="priority" defaultValue={series.priority}>{sygTaskPriorities.map((priority) => <option key={priority} value={priority}>{formatSygTaskPriority(priority)}</option>)}</select></label><label><span>Assignee <small>Optional</small></span><select name="assigneeId" defaultValue={series.assigneeEmployeeId ?? ''}><option value="">Unassigned</option>{candidates.map((person) => <option key={person.employeeId} value={person.employeeId}>{person.name}</option>)}</select></label><label><span>Alert</span><select name="reminderKind" defaultValue={series.reminderKind ?? 'none'}><option value="none">No alert</option><option value="reminder">Reminder</option><option value="alarm">Repeating alarm</option></select></label><label><span>Alert lead time</span><select name="reminderOffsetMinutes" defaultValue={String(series.reminderOffsetMinutes ?? 60)}><option value="0">At due time</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="1440">1 day</option><option value="10080">1 week</option></select></label></div>
      <label className="sygtasks-recurrence-email"><input name="reminderEmailEnabled" type="checkbox" defaultChecked={series.reminderEmailEnabled} /><span><strong>Also send email</strong><small>Used only when Reminder or Alarm is selected.</small></span></label>
      <div className="sygtasks-inline-actions"><button type="button" className="sygtasks-button sygtasks-button--secondary" onClick={() => setEditing(false)} disabled={mutation.isPending}>Cancel</button><button type="submit" className="sygtasks-button sygtasks-button--primary" disabled={mutation.isPending}>Save Future Tasks</button></div>
    </form> : null}

    <ErrorNotice error={mutation.error} />
    {mutation.isSuccess ? <p className="sygtasks-notice sygtasks-notice--success" role="status"><CheckCircle2 aria-hidden="true" size={18} /><span>The recurring series is up to date.</span></p> : null}

    <section className="sygtasks-recurring-history"><header><div><small>Occurrence history</small><h3>Created and skipped dates</h3></div><span>{series.occurrenceCount} total</span></header>{series.occurrences.length ? <ol>{series.occurrences.map((occurrence) => <li key={occurrence.id}><span className={`sygtasks-occurrence-dot sygtasks-occurrence-dot--${occurrence.state}`} /><div><strong>{occurrence.occurrenceOn}</strong><small>{occurrence.state === 'generated' ? `Due ${formatTaskDue(occurrence.dueAt)}` : occurrence.skipReason}</small></div>{occurrence.taskId ? <a className="sygtasks-button sygtasks-button--secondary sygtasks-button--small" href={sygTaskPath(series.boardId, occurrence.taskId)}>Open task</a> : <span className="sygtasks-series-status">Skipped</span>}</li>)}</ol> : <p>No occurrences have been recorded yet.</p>}</section>

    <section className="sygtasks-recurring-history"><header><div><small>Series audit</small><h3>Recent schedule activity</h3></div></header><ol>{series.activity.map((event) => <li key={event.id}><span className="sygtasks-occurrence-dot" /><div><strong>{event.action.replaceAll('.', ' ')}</strong><small>{event.actorName} · {formatTaskDue(event.createdAt)}</small></div></li>)}</ol></section>
  </div>
}
