import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  formatPatrolDateTime, getFloatingPatrolScope, saveFloatingPatrolScope,
  type FloatingPatrolScope, type PatrolScheduleCandidate, type PatrolWorkspace,
} from '../data/patrol'
import { findPatrolScheduleCandidate, patrolScheduleCandidateValue } from '../patrolOperations'

function sameProperties(saved: string[], selected: string[]) {
  return saved.length === selected.length && selected.every((id) => saved.includes(id))
}

function PropertyEditor({
  actorId, target, options, setBusy,
}: {
  actorId: string; target: PatrolScheduleCandidate; options: PatrolWorkspace['locations']; setBusy: (busy: boolean) => void
}) {
  const queryClient = useQueryClient()
  const queryKey = ['floating-patrol-properties', actorId, target.shiftId, target.employeeId] as const
  const scopeQuery = useQuery({ queryKey, queryFn: () => getFloatingPatrolScope(target), retry: false, staleTime: 0, refetchOnWindowFocus: false })
  const [edit, setEdit] = useState<{ revision: number | null; ids: string[] } | null>(null)
  const [search, setSearch] = useState('')
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState('')
  const inFlight = useRef(false)
  const available = useMemo(() => [...new Map(options.filter((location) => location.clientId)
    .map((location) => [location.siteId, location])).values()]
    .sort((left, right) => left.siteName.localeCompare(right.siteName)), [options])
  const save = useMutation({
    retry: false,
    mutationFn: async ({ revision, ids, reason: submittedReason }: NonNullable<typeof edit> & { reason: string }) => {
      let saved: FloatingPatrolScope | undefined
      let writeError: unknown
      try {
        saved = await saveFloatingPatrolScope(target, ids, revision, submittedReason)
      } catch (error) {
        writeError = error
      }
      let verified: FloatingPatrolScope
      try {
        verified = await getFloatingPatrolScope(target)
      } catch {
        throw new Error('The result could not be verified. Reload the saved list before making another change.')
      }
      if ((saved ? saved.revision !== verified.revision : verified.revision !== (revision ?? 0) + 1)
          || verified.active !== Boolean(ids.length) || !sameProperties(verified.siteIds, ids)
          || !sameProperties(verified.approvedSiteIds, ids)) {
        throw writeError instanceof Error ? writeError : new Error('The saved list did not match this request. Reload and review the current list.')
      }
      return verified
    },
    onSuccess: (verified) => {
      queryClient.setQueryData(queryKey, verified)
      setEdit(null)
      setReason('')
      setNotice(verified.active
        ? 'Verified. Have the guard refresh assigned shifts in Sygilant and choose the property they are visiting.'
        : 'Verified. Floating patrol locations are now removed for this shift. Existing reports are unchanged.')
      void queryClient.invalidateQueries({ queryKey: ['patrol-workspace'] })
    },
    onSettled: () => { inFlight.current = false; setBusy(false) },
  })
  const current = scopeQuery.data
  if (scopeQuery.isPending) return <p role="status">Checking this assignment’s approved properties…</p>
  if (!current) return <div className="inline-alert" role="alert"><p>{scopeQuery.error?.message ?? 'The assigned shift could not be verified.'}</p><button className="secondary-button" disabled={scopeQuery.isFetching} onClick={() => void scopeQuery.refetch()} type="button">Retry lookup</button></div>

  if (!current.eligible) return <div className="inline-alert" role="status">{current.status === 'native_route'
    ? 'This assignment uses a scheduled patrol route. Manage its properties on the route instead.'
    : current.status === 'ended' ? 'This shift has ended. Its property approvals are read-only.'
      : 'This assignment is no longer eligible. Confirm the current published shift and employee before continuing.'}</div>

  const ids = edit?.ids ?? current.approvedSiteIds
  const term = search.trim().toLowerCase()
  const visible = available.filter((location) => `${location.siteName} ${location.siteCode ?? ''} ${location.clientName ?? ''} ${location.city ?? ''}`.toLowerCase().includes(term))
  const unavailable = ids.filter((id) => !available.some((location) => location.siteId === id))
  const stale = Boolean(edit && edit.revision !== current.revision)
  const changed = Boolean(edit && (!sameProperties(current.approvedSiteIds, ids) || !sameProperties(current.siteIds, ids)))
  const lock = save.isPending || scopeQuery.isFetching
  const canSave = Boolean(edit && !lock && !stale && changed && !unavailable.length && ids.length <= 100
    && reason.trim().length >= 8 && !save.isError && !scopeQuery.isError)
  const change = (next: string[]) => {
    setEdit({ revision: edit ? edit.revision : current.revision, ids: next })
    setNotice('')
  }
  const reload = async () => {
    const result = await scopeQuery.refetch()
    if (result.isSuccess) { setEdit(null); setReason(''); setNotice(''); save.reset() }
  }
  return <form className="patrol-form" onSubmit={(event) => {
    event.preventDefault()
    if (!edit || inFlight.current || !canSave) return
    inFlight.current = true
    setBusy(true)
    save.mutate({ ...edit, reason })
  }}>
    <fieldset className="patrol-form patrol-form--wide patrol-route-fields" disabled={lock || save.isError || stale || scopeQuery.isError}>
      <legend>Properties Dispatch can send this guard to</legend>
      <label className="patrol-form--wide"><span>Find a property</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <p className="patrol-form--wide" role="status">{ids.length} selected{current.active ? ` · ${current.siteIds.length} currently available to the guard` : ' · no active list'}</p>
      {visible.map((location) => <label key={location.siteId} className="patrol-check"><input type="checkbox" checked={ids.includes(location.siteId)} onChange={(event) => {
          change(event.target.checked ? [...ids, location.siteId] : ids.filter((id) => id !== location.siteId))
        }} /><span><strong>{location.siteName}</strong>{location.clientName && location.clientName !== location.siteName ? ` · ${location.clientName}` : ''} {location.siteCode ? `(${location.siteCode})` : ''}</span></label>)}
      {!visible.length ? <p className="patrol-form--wide">No matching properties.</p> : null}
      {ids.length > 100 ? <p className="patrol-form--wide" role="alert">Select no more than 100 properties for this shift.</p> : null}
      {unavailable.length ? <p className="patrol-form--wide" role="status">Some previously approved properties are no longer available in this catalog. <button className="secondary-button" type="button" onClick={() => change(ids.filter((id) => !unavailable.includes(id)))}>Remove unavailable properties from this selection</button></p> : null}
      {current.approvedSiteIds.length > current.siteIds.length ? <p className="patrol-form--wide" role="status">Some saved properties are blocked. Review their current client links before approving again.</p> : null}
      {changed ? <label className="patrol-form--wide"><span>Reason for changing this assignment</span><input value={reason} required minLength={8} maxLength={500} onChange={(event) => setReason(event.target.value)} /></label> : null}
    </fieldset>
    <div className="modal-actions patrol-form--wide">
      <button className="primary-action" type="submit" disabled={!canSave}>{save.isPending ? 'Saving and verifying…' : !ids.length && current.approvedSiteIds.length ? 'Remove floating patrol access' : 'Save approved properties'}</button>
      {save.isError || stale || scopeQuery.isError ? <button className="secondary-button" type="button" disabled={lock} onClick={() => void reload()}>Reload saved list</button> : null}
    </div>
    {save.isError || stale || scopeQuery.isError ? <p className="inline-alert patrol-form--wide" role="alert">{save.error?.message ?? scopeQuery.error?.message ?? 'This assignment changed. Reload the saved list before making another change.'}</p> : null}
    {notice ? <p className="form-feedback form-feedback--success patrol-form--wide" role="status">{notice}</p> : null}
  </form>
}

export function FloatingPatrolProperties({
  workspace, suggested,
}: {
  workspace: PatrolWorkspace; suggested?: PatrolScheduleCandidate
}) {
  const [selection, setSelection] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const selected = findPatrolScheduleCandidate(workspace.scheduleCandidates, selection ?? (suggested ? patrolScheduleCandidateValue(suggested) : ''))
  return <section className="operations-panel patrol-link-panel patrol-floating-panel">
    <div className="patrol-section-heading"><div><p className="eyebrow">Schedule integration</p><h2>Floating patrol properties</h2><p>Use this for a guard who can be sent to different properties during an assigned shift. This list does not send the guard to every site or change the schedule.</p></div>
      <button className="secondary-button" aria-expanded={open} type="button" disabled={busy} onClick={() => setOpen(!open)}>{open ? 'Close property setup' : 'Set up floating patrol'}</button>
    </div>
    {open ? <><div className="patrol-form"><label className="patrol-form--wide"><span>Floating patrol shift and employee</span><select disabled={busy} value={selected ? patrolScheduleCandidateValue(selected) : ''} onChange={(event) => setSelection(event.target.value)}>
      <option value="">Choose a published shift and employee</option>
      {workspace.scheduleCandidates.map((candidate) => {
        const value = patrolScheduleCandidateValue(candidate)
        return <option key={value} value={value}>{candidate.employeeName} · {candidate.siteName ?? candidate.postName ?? 'Scheduled shift'} · {formatPatrolDateTime(candidate.startsAt, candidate.timeZone)}</option>
      })}
    </select></label></div>
      {selected ? <PropertyEditor key={patrolScheduleCandidateValue(selected)} actorId={workspace.actor.employeeId} target={selected} options={workspace.locations} setBusy={setBusy} /> : null}
    </> : null}
  </section>
}
