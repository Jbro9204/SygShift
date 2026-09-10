import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, BellRing, Clock3, Mail, Trash2 } from 'lucide-react'
import {
  cancelSygTaskReminder,
  createSygTaskReminder,
  getSygTaskReminders,
  type SygTaskReminder,
} from '../../data/sygtasks'
import { fromOperationalDateTimeInput } from '../../lib/operationalDateTime'
import { enableAudio, getSoundPreferences, saveSoundPreferences } from '../../lib/notificationSounds'
import { formatTaskDue } from '../../lib/sygtasksPresentation'

const offsetOptions = [
  { value: 0, label: 'At the due time' },
  { value: 15, label: '15 minutes before' },
  { value: 60, label: '1 hour before' },
  { value: 1440, label: '1 day before' },
  { value: 10080, label: '1 week before' },
] as const

function reminderTiming(reminder: SygTaskReminder) {
  if (reminder.timingKind === 'absolute') return reminder.absoluteAt ? formatTaskDue(reminder.absoluteAt) : 'Scheduled time unavailable'
  return offsetOptions.find((option) => option.value === reminder.offsetMinutes)?.label
    ?? `${reminder.offsetMinutes ?? 0} minutes before the due time`
}

function stateLabel(state: SygTaskReminder['occurrences'][number]['state']) {
  return ({ scheduled: 'Scheduled', triggered: 'Active', snoozed: 'Snoozed', acknowledged: 'Stopped', cancelled: 'Canceled' } as const)[state]
}

function ErrorNotice({ error }: { error: unknown }) {
  return error ? <p className="sygtasks-notice sygtasks-notice--error" role="alert">{error instanceof Error ? error.message : 'The reminder could not be updated.'}</p> : null
}

export function SygTasksRemindersPanel({ taskId, taskHasDueDate }: { taskId: string; taskHasDueDate: boolean }) {
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<'reminder' | 'alarm'>('reminder')
  const [recipientScope, setRecipientScope] = useState<'self' | 'assignees'>('self')
  const [timingKind, setTimingKind] = useState<'relative' | 'absolute'>(taskHasDueDate ? 'relative' : 'absolute')
  const [success, setSuccess] = useState<string | null>(null)
  const [validation, setValidation] = useState<string | null>(null)
  const [soundWarning, setSoundWarning] = useState<string | null>(null)
  const [alarmVolume, setAlarmVolume] = useState(() => getSoundPreferences().alarmVolume)
  const reminders = useQuery({
    queryKey: ['sygtasks', 'reminders', taskId],
    queryFn: () => getSygTaskReminders(taskId),
  })
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['sygtasks'] }),
      queryClient.invalidateQueries({ queryKey: ['sygtasks-badge'] }),
      queryClient.invalidateQueries({ queryKey: ['sygtasks-alarms'] }),
      queryClient.invalidateQueries({ queryKey: ['my-notifications'] }),
    ])
  }
  const create = useMutation({
    mutationFn: (input: Parameters<typeof createSygTaskReminder>[0]) => createSygTaskReminder(input),
    onSuccess: async () => {
      setValidation(null)
      setSuccess(kind === 'alarm' ? 'Alarm scheduled.' : 'Reminder scheduled.')
      await refresh()
    },
  })
  const cancel = useMutation({
    mutationFn: (reminderId: string) => cancelSygTaskReminder(reminderId),
    onSuccess: async () => {
      setSuccess('Reminder canceled. Its history remains available in task activity.')
      await refresh()
    },
  })
  const busy = create.isPending || cancel.isPending

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const data = new FormData(event.currentTarget)
    let absoluteAt: string | null = null
    const offsetMinutes = timingKind === 'relative' ? Number(data.get('offsetMinutes')) : null
    if (timingKind === 'absolute') {
      const localValue = String(data.get('absoluteAt') ?? '')
      if (!localValue) { setValidation('Choose the Mountain Time date and time.'); return }
      try { absoluteAt = fromOperationalDateTimeInput(localValue) }
      catch (reason) { setValidation(reason instanceof Error ? reason.message : 'Choose a valid Mountain Time date and time.'); return }
      if (Date.parse(absoluteAt) <= Date.now()) { setValidation('Choose a reminder time in the future.'); return }
    }
    if (timingKind === 'relative' && !taskHasDueDate) { setValidation('Add a task due date before using a relative reminder.'); return }
    if (kind === 'alarm') {
      const preferences = getSoundPreferences()
      const nextVolume = alarmVolume > 0 ? alarmVolume : 1
      saveSoundPreferences({ ...preferences, alarm: true, muted: false, alarmVolume: nextVolume })
      setAlarmVolume(nextVolume)
      setSoundWarning(null)
      void enableAudio().then((enabled) => {
        if (!enabled) setSoundWarning('The alarm is scheduled, but this browser blocked audio. Use Enable alarm sound when it appears, and allow sound for SygShift in your browser settings.')
      })
    }
    setValidation(null)
    setSuccess(null)
    create.mutate({
      taskId,
      kind,
      recipientScope,
      timingKind,
      offsetMinutes,
      absoluteAt,
      emailEnabled: data.get('emailEnabled') === 'on',
    })
  }

  return <div className="sygtasks-reminders">
    <section className="sygtasks-reminder-intro">
      <div><AlarmClock aria-hidden="true" size={24} /><div><h3>Reminders &amp; alarms</h3><p>Reminders notify once. Alarms repeat while SygShift is open until the recipient stops, snoozes, completes, or cancels the alarm.</p></div></div>
      <p className="sygtasks-muted">Background device alerts use browser and device notification settings. Custom repeating audio is available while SygShift is open.</p>
    </section>

    <form className="sygtasks-reminder-form" onSubmit={submit}>
      <div className="sygtasks-form-grid sygtasks-form-grid--two">
        <label className="sygtasks-field"><span>Alert type<small>Required</small></span><span className="sygtasks-field__control"><select value={kind} onChange={(event) => setKind(event.target.value as 'reminder' | 'alarm')}><option value="reminder">Reminder — notify once</option><option value="alarm">Alarm — repeat until stopped</option></select></span></label>
        <label className="sygtasks-field"><span>Recipients<small>Required</small></span><span className="sygtasks-field__control"><select value={recipientScope} onChange={(event) => setRecipientScope(event.target.value as 'self' | 'assignees')}><option value="self">My private reminder</option>{reminders.data?.canCreateForAssignees ? <option value="assignees">Current task assignees</option> : null}</select></span></label>
        <label className="sygtasks-field"><span>When<small>Required</small></span><span className="sygtasks-field__control"><select value={timingKind} onChange={(event) => { setValidation(null); setTimingKind(event.target.value as 'relative' | 'absolute') }}><option value="relative" disabled={!taskHasDueDate}>Relative to task due time</option><option value="absolute">Specific Mountain Time</option></select></span></label>
        {timingKind === 'relative'
          ? <label className="sygtasks-field"><span>Lead time<small>Required</small></span><span className="sygtasks-field__control"><select name="offsetMinutes" defaultValue="60">{offsetOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></span></label>
          : <label className={`sygtasks-field${validation ? ' sygtasks-field--error' : ''}`}><span>Date and time (Mountain Time)<small>Required</small></span><span className="sygtasks-field__control"><input name="absoluteAt" type="datetime-local" aria-invalid={Boolean(validation)} onChange={() => setValidation(null)} /></span>{validation ? <small className="sygtasks-field__error">{validation}</small> : null}</label>}
      </div>
      <label className="sygtasks-reminder-email"><input name="emailEnabled" type="checkbox" /><Mail aria-hidden="true" size={18} /><span><strong>Also send email</strong><small>Uses the approved personal-first SygShift delivery route.</small></span></label>
      {kind === 'alarm' ? <div className="sygtasks-reminder-alarm-settings"><p className="sygtasks-reminder-alarm-note"><BellRing aria-hidden="true" size={18} />Scheduling automatically enables alarm audio on this device. It repeats three seconds after each play finishes until stopped, snoozed, completed, or canceled; opening the task does not silence it.</p><label><span>Alarm volume · {Math.round(alarmVolume * 100)}%</span><input aria-label="New task alarm volume" max="100" min="10" onChange={(event) => setAlarmVolume(Number(event.target.value) / 100)} type="range" value={Math.round(alarmVolume * 100)} /></label></div> : null}
      {validation ? <p className="sygtasks-notice sygtasks-notice--error" role="alert">{validation}</p> : null}
      <ErrorNotice error={create.error || cancel.error || reminders.error} />
      {success ? <p className="sygtasks-notice sygtasks-notice--success" role="status">{success}</p> : null}
      {soundWarning ? <p className="sygtasks-notice sygtasks-notice--error" role="alert">{soundWarning}</p> : null}
      <div className="sygtasks-inline-actions"><button className="sygtasks-button sygtasks-button--primary" type="submit" disabled={busy || reminders.isPending}>{create.isPending ? 'Scheduling…' : kind === 'alarm' ? 'Schedule Alarm' : 'Schedule Reminder'}</button></div>
    </form>

    <section className="sygtasks-reminder-list" aria-busy={reminders.isPending}>
      <h3><Clock3 aria-hidden="true" size={18} />Scheduled for this task</h3>
      {reminders.isPending ? <p className="sygtasks-muted">Loading reminders…</p> : reminders.data?.reminders.length ? <ol>{reminders.data.reminders.map((reminder) => <li key={reminder.id}>
        <div className="sygtasks-reminder-list__icon">{reminder.kind === 'alarm' ? <AlarmClock aria-hidden="true" /> : <BellRing aria-hidden="true" />}</div>
        <div className="sygtasks-reminder-list__content"><header><strong>{reminder.kind === 'alarm' ? 'Repeating alarm' : 'One-time reminder'}</strong><span>{reminderTiming(reminder)}</span></header><p>{reminder.recipientScope === 'self' ? `Private reminder for ${reminder.createdByName}` : 'For current task assignees'}{reminder.emailEnabled ? ' · Email included' : ''}</p><div>{reminder.occurrences.map((occurrence) => <span className={`sygtasks-reminder-state sygtasks-reminder-state--${occurrence.state}`} key={occurrence.id}>{occurrence.recipientName} · {stateLabel(occurrence.state)} · {formatTaskDue(occurrence.snoozedUntil ?? occurrence.scheduledFor)}</span>)}</div></div>
        {reminder.canCancel ? <button className="sygtasks-icon-button sygtasks-reminder-list__cancel" aria-label={`Cancel ${reminder.kind}`} type="button" disabled={busy} onClick={() => { setSuccess(null); cancel.mutate(reminder.id) }}><Trash2 aria-hidden="true" size={17} /></button> : null}
      </li>)}</ol> : <p className="sygtasks-muted">No reminders are scheduled for this task.</p>}
    </section>
  </div>
}
