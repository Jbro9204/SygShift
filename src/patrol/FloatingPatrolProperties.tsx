import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  formatPatrolDateTime, getFloatingPatrolPostScope, getFloatingPatrolScope, saveFloatingPatrolPostScope,
  saveFloatingPatrolScope, type FloatingPatrolPostScope, type FloatingPatrolScope,
  type PatrolScheduleCandidate, type PatrolWorkspace,
} from '../data/patrol'
import { findPatrolScheduleCandidate, patrolScheduleCandidateValue } from '../patrolOperations'

type PolicyPost = { id: string; label: string }
type PropertyTarget = { assignment: PatrolScheduleCandidate; post?: never } | { post: PolicyPost; assignment?: never }
type SavedProperties = FloatingPatrolScope | FloatingPatrolPostScope

function sameProperties(saved: string[], selected: string[]) {
  return saved.length === selected.length && selected.every((id) => saved.includes(id))
}

function PropertyEditor({
  actorId, target, options, setBusy,
}: {
  actorId: string; target: PropertyTarget; options: PatrolWorkspace['locations']; setBusy: (busy: boolean) => void
}) {
  const queryClient = useQueryClient()
  const postPolicy = Boolean(target.post)
  const queryKey = target.post
    ? ['floating-patrol-post-properties', actorId, target.post.id] as const
    : ['floating-patrol-properties', actorId, target.assignment.shiftId, target.assignment.employeeId] as const
  const loadScope = (): Promise<SavedProperties> => target.post ? getFloatingPatrolPostScope(target.post.id) : getFloatingPatrolScope(target.assignment)
  const scopeQuery = useQuery({ queryKey, queryFn: loadScope, retry: false, staleTime: 0, refetchOnWindowFocus: false })
  const [edit, setEdit] = useState<{ revision: number | null; ids: string[] } | null>(null)
  const [search, setSearch] = useState('')
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [notice, setNotice] = useState('')
  const inFlight = useRef(false)
  const available = useMemo(() => [...new Map(options.filter((location) => location.clientId)
    .map((location) => [location.siteId, location])).values()]
    .sort((left, right) => left.siteName.localeCompare(right.siteName)), [options])
  const save = useMutation({
    retry: false,
    mutationFn: async ({ revision, ids, reason: submittedReason }: NonNullable<typeof edit> & { reason: string }) => {
      let saved: SavedProperties | undefined
      let writeError: unknown
      try {
        saved = target.post
          ? await saveFloatingPatrolPostScope(target.post.id, ids, revision, submittedReason)
          : await saveFloatingPatrolScope(target.assignment, ids, revision, submittedReason)
      } catch (error) {
        writeError = error
      }
      let verified: SavedProperties
      try {
        verified = await loadScope()
      } catch {
        throw new Error('The result could not be verified. Reload the saved list before making another change.')
      }
      if (verified.revision !== (revision ?? 0) + 1 || (saved && saved.revision !== verified.revision)
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
      setConfirmed(false)
      setNotice(postPolicy
        ? verified.active ? 'Verified. This post now has a reusable list for eligible published assignments.' : 'Verified. This post no longer supplies a reusable list. Exact shift approvals and saved reports are unchanged.'
        : verified.active ? 'Verified. Have the guard refresh assigned shifts in Sygilant and choose the property they are visiting.'
          : 'Verified. Floating patrol locations are now removed for this shift. Existing reports are unchanged.')
      void queryClient.invalidateQueries({ queryKey: ['patrol-workspace'] })
      if (postPolicy) void queryClient.invalidateQueries({ queryKey: ['floating-patrol-properties', actorId] })
    },
    onSettled: () => { inFlight.current = false; setBusy(false) },
  })
  const current = scopeQuery.data
  if (scopeQuery.isPending) return <p role="status">{postPolicy ? 'Checking this post’s reusable list…' : 'Checking this assignment’s approved properties…'}</p>
  if (!current) return <div className="inline-alert" role="alert"><p>{scopeQuery.error?.message ?? 'The property list could not be verified.'}</p><button className="secondary-button" disabled={scopeQuery.isFetching} onClick={() => void scopeQuery.refetch()} type="button">Retry lookup</button></div>

  if ('eligible' in current && !current.eligible) return <div className="inline-alert" role="status">{current.status === 'native_route'
    ? 'This assignment uses a scheduled patrol route. Manage its properties on the route instead.'
    : current.status === 'ended' ? 'This shift has ended. Its property approvals are read-only.'
      : 'This assignment is no longer eligible. Confirm the current published shift and employee before continuing.'}</div>

  const inherited = !postPolicy && current.revision === null && current.active && current.siteIds.length > 0
  const baseline = inherited ? current.siteIds : current.approvedSiteIds
  const ids = edit?.ids ?? baseline
  const term = search.trim().toLowerCase()
  const visible = available.filter((location) => `${location.siteName} ${location.siteCode ?? ''} ${location.clientName ?? ''} ${location.city ?? ''}`.toLowerCase().includes(term))
  const unavailable = ids.filter((id) => !available.some((location) => location.siteId === id))
  const stale = Boolean(edit && edit.revision !== current.revision)
  const changed = Boolean(edit && (!sameProperties(baseline, ids) || !sameProperties(current.siteIds, ids)))
  const lock = save.isPending || scopeQuery.isFetching
  const canSave = Boolean(edit && !lock && !stale && changed && !unavailable.length && ids.length <= 100
    && reason.trim().length >= 8 && (!postPolicy || confirmed) && !save.isError && !scopeQuery.isError)
  const change = (next: string[]) => {
    setEdit({ revision: edit ? edit.revision : current.revision, ids: next })
    setNotice('')
    setConfirmed(false)
  }
  const reload = async () => {
    const result = await scopeQuery.refetch()
    if (result.isSuccess) { setEdit(null); setReason(''); setConfirmed(false); setNotice(''); save.reset() }
  }
  return <form className="patrol-form" onSubmit={(event) => {
    event.preventDefault()
    if (!edit || inFlight.current || !canSave) return
    inFlight.current = true
    setBusy(true)
    save.mutate({ ...edit, reason })
  }}>
    <fieldset className="patrol-form patrol-form--wide patrol-route-fields" disabled={lock || save.isError || stale || scopeQuery.isError}>
      <legend>{postPolicy ? 'Properties Dispatch can use for this post' : 'Properties Dispatch can send this guard to'}</legend>
      {inherited ? <div className="inline-alert patrol-form--wide" role="status"><p>This shift uses the post’s reusable property list. Saving here changes only this shift and employee.</p><button className="secondary-button" type="button" onClick={() => change([])}>Block inherited access for this shift</button></div> : null}
      <label className="patrol-form--wide"><span>Find a property</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <p className="patrol-form--wide" role="status">{ids.length} selected{current.active ? ` · ${current.siteIds.length} ${postPolicy ? 'approved for this post' : 'currently available to the guard'}` : ' · no active list'}</p>
      {visible.map((location) => <label key={location.siteId} className="patrol-check"><input type="checkbox" checked={ids.includes(location.siteId)} onChange={(event) => {
          change(event.target.checked ? [...ids, location.siteId] : ids.filter((id) => id !== location.siteId))
        }} /><span><strong>{location.siteName}</strong>{location.clientName && location.clientName !== location.siteName ? ` · ${location.clientName}` : ''} {location.siteCode ? `(${location.siteCode})` : ''}</span></label>)}
      {!visible.length ? <p className="patrol-form--wide">No matching properties.</p> : null}
      {ids.length > 100 ? <p className="patrol-form--wide" role="alert">Select no more than 100 properties.</p> : null}
      {unavailable.length ? <p className="patrol-form--wide" role="status">Some previously approved properties are no longer available in this catalog. <button className="secondary-button" type="button" onClick={() => change(ids.filter((id) => !unavailable.includes(id)))}>Remove unavailable properties from this selection</button></p> : null}
      {current.approvedSiteIds.length > current.siteIds.length ? <div className="patrol-form--wide" role="status"><p>Some saved properties are blocked. Review their current client links before approving again.</p>{!edit && !unavailable.length ? <button className="secondary-button" onClick={() => change(current.approvedSiteIds)} type="button">Review saved selection for reapproval</button> : null}</div> : null}
      {changed ? <label className="patrol-form--wide"><span>{postPolicy ? 'Reason for changing this post’s list' : 'Reason for changing this assignment'}</span><input value={reason} required minLength={8} maxLength={500} onChange={(event) => setReason(event.target.value)} /></label> : null}
      {postPolicy && changed ? <label className="patrol-form--wide patrol-check"><input type="checkbox" checked={confirmed} required onChange={(event) => setConfirmed(event.target.checked)} /><span>I confirm this change applies to eligible published shifts at this post, not just one employee.</span></label> : null}
    </fieldset>
    <div className="modal-actions patrol-form--wide">
      <button className="primary-action" type="submit" disabled={!canSave}>{save.isPending ? 'Saving and verifying…' : postPolicy ? ids.length ? 'Save reusable list' : 'Remove reusable list' : !ids.length && (current.approvedSiteIds.length || inherited) ? 'Remove floating patrol access' : 'Save approved properties'}</button>
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
  const [shiftSearch, setShiftSearch] = useState('')
  const [postId, setPostId] = useState('')
  const [postSearch, setPostSearch] = useState('')
  const section = useRef<HTMLElement>(null)
  const [mode, setMode] = useState<'closed' | 'shift' | 'post'>(() => window.location.hash === '#floating-patrol-properties' ? 'shift' : 'closed')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (window.location.hash === '#floating-patrol-properties') section.current?.scrollIntoView?.({ block: 'start' })
  }, [])
  const selected = findPatrolScheduleCandidate(workspace.scheduleCandidates, selection ?? (suggested ? patrolScheduleCandidateValue(suggested) : ''))
  const canManagePost = workspace.actor.canManageAssignments && workspace.actor.canManageRoutes
  const posts = [...new Map(workspace.locations.flatMap<[string, PolicyPost]>((location) => location.clientId && location.postId && location.postName
    ? [[location.postId, { id: location.postId, label: `${location.siteName} · ${location.postName}` }]] : [])).values()].sort((left, right) => left.label.localeCompare(right.label))
  const post = posts.find((option) => option.id === postId)
  const matchingPosts = posts.filter((option) => option.id === postId || option.label.toLowerCase().includes(postSearch.trim().toLowerCase()))
  const shiftLabel = (candidate: PatrolScheduleCandidate) => `${candidate.employeeName} · ${candidate.siteName ?? candidate.postName ?? 'Scheduled shift'} · ${formatPatrolDateTime(candidate.startsAt, candidate.timeZone)}`
  const matchingShifts = workspace.scheduleCandidates.filter((candidate) => candidate === selected || shiftLabel(candidate).toLowerCase().includes(shiftSearch.trim().toLowerCase()))
  return <section aria-labelledby="floating-patrol-properties-heading" className="operations-panel patrol-link-panel patrol-floating-panel" id="floating-patrol-properties" ref={section}>
    <div className="patrol-section-heading"><div><p className="eyebrow">Dispatch coverage</p><h2 id="floating-patrol-properties-heading">Floating patrol properties</h2><p>Use this when Dispatch may send a guard to different properties. Publishing a shift does not approve reporting locations. For a scheduled patrol route with assigned stops, use the separate route connection below.</p></div></div>
    <div className="modal-actions">
      <button className="secondary-button" aria-expanded={mode === 'shift'} type="button" disabled={busy} onClick={() => setMode(mode === 'shift' ? 'closed' : 'shift')}>{mode === 'shift' ? 'Close shift setup' : 'Set up floating patrol'}</button>
      {canManagePost ? <button className="secondary-button" aria-expanded={mode === 'post'} type="button" disabled={busy} onClick={() => setMode(mode === 'post' ? 'closed' : 'post')}>{mode === 'post' ? 'Close reusable setup' : 'Manage reusable post lists'}</button> : null}
    </div>
    {mode === 'shift' ? <><p>Choose the current published assignment, select only approved reporting properties, then save. Wait for the Verified message before testing in Sygilant.</p>
      <div className="patrol-form">
        <label className="patrol-form--wide"><span>Find an assigned shift</span><input type="search" value={shiftSearch} disabled={busy} onChange={(event) => setShiftSearch(event.target.value)} /></label>
        <label className="patrol-form--wide"><span>Floating patrol shift and employee</span><select disabled={busy} value={selected ? patrolScheduleCandidateValue(selected) : ''} onChange={(event) => setSelection(event.target.value)}>
          <option value="">Choose a published shift and employee</option>
          {matchingShifts.map((candidate) => { const value = patrolScheduleCandidateValue(candidate); return <option key={value} value={value}>{shiftLabel(candidate)}</option> })}
        </select></label>
        {!matchingShifts.length ? <p className="patrol-form--wide" role="status">No matching published assignments. Verify the intended employee is assigned on the current published schedule.</p> : null}
      </div>
      {selected ? <PropertyEditor key={patrolScheduleCandidateValue(selected)} actorId={workspace.actor.employeeId} target={{ assignment: selected }} options={workspace.locations} setBusy={setBusy} /> : null}
    </> : null}
    {mode === 'post' && canManagePost ? <><p>Approve a list once for a scheduling post that regularly floats. It applies to eligible current and upcoming published assignments at the selected post. Exact shift settings and connected patrol routes take precedence.</p>
      <div className="patrol-form">
        <label className="patrol-form--wide"><span>Find a scheduling post</span><input type="search" value={postSearch} disabled={busy} onChange={(event) => setPostSearch(event.target.value)} /></label>
        <label className="patrol-form--wide"><span>Scheduling post</span><select disabled={busy} value={postId} onChange={(event) => setPostId(event.target.value)}><option value="">Choose a post</option>{matchingPosts.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        {!matchingPosts.length ? <p className="patrol-form--wide" role="status">No matching active scheduling posts.</p> : null}
      </div>
      {post ? <PropertyEditor key={post.id} actorId={workspace.actor.employeeId} target={{ post }} options={workspace.locations} setBusy={setBusy} /> : null}
    </> : null}
  </section>
}
