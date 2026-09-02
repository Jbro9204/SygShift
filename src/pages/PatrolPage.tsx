import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, BadgeCheck, Camera, CheckCircle2, ChevronLeft, ChevronRight, ClipboardCheck,
  DatabaseZap, Download, FileBarChart, MapPin, MapPinned, Plus, Route as RouteIcon, Search,
  Shield, ShieldAlert, UploadCloud, Video,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  assignPatrolMakeup, formatPatrolDateTime, getPatrolWorkspace, linkPatrolRouteShift,
  openPatrolEvidence, savePatrolHit, savePatrolRoute, uploadPatrolEvidence,
  type PatrolAssignment, type PatrolMakeupObligation, type PatrolObligation, type PatrolRoute, type PatrolRouteInput,
  type PatrolWorkspace,
} from '../data/patrol'
import { isSupabaseConfigured } from '../lib/supabase'

type PatrolTab = 'overview' | 'my-patrol' | 'operations' | 'routes'
type Outcome = 'secure' | 'attention_needed' | 'incident' | 'unable_to_access' | 'other'

const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pageSizes = [5, 10, 20] as const

function statusLabel(status: string): string {
  return status.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function percentComplete(assignment: PatrolAssignment): number {
  if (!assignment.obligations.length) return 0
  return Math.round((assignment.obligations.filter((item) => item.status === 'completed').length / assignment.obligations.length) * 100)
}

function emptyRoute(): PatrolRouteInput {
  return {
    changeReason: 'Initial route configuration', code: '', effectiveFrom: null, effectiveThrough: null,
    id: null, name: '', requiresArmed: false, status: 'draft', timeZone: 'America/Denver',
    stops: [{
      addressLine1: null, allowPhotos: true, allowVideos: true, city: null,
      evidenceInstructions: null, geofenceRadiusMeters: null, incidentVideoLimitSeconds: 900,
      instructions: null, latitude: null, locationLabel: '', longitude: null, postalCode: null,
      postId: null, region: null, requireEvidence: false, siteId: null,
      stableKey: crypto.randomUUID(), standardVideoLimitSeconds: 180, requirements: [],
    }],
  }
}

function routeToInput(route: PatrolRoute): PatrolRouteInput {
  return {
    changeReason: '', code: route.code, effectiveFrom: route.effectiveFrom, effectiveThrough: route.effectiveThrough,
    id: route.id, name: route.name, requiresArmed: route.requiresArmed, status: route.status, timeZone: route.timeZone,
    stops: route.stops.map((stop) => ({
      addressLine1: stop.addressLine1, allowPhotos: stop.allowPhotos, allowVideos: stop.allowVideos,
      city: stop.city, evidenceInstructions: stop.evidenceInstructions, geofenceRadiusMeters: stop.geofenceRadiusMeters,
      incidentVideoLimitSeconds: stop.incidentVideoLimitSeconds, instructions: stop.instructions,
      latitude: stop.latitude, locationLabel: stop.locationLabel, longitude: stop.longitude,
      postalCode: stop.postalCode, postId: stop.postId, region: stop.region, requireEvidence: stop.requireEvidence,
      siteId: stop.siteId, stableKey: stop.stableKey, standardVideoLimitSeconds: stop.standardVideoLimitSeconds,
      requirements: stop.requirements.map((requirement) => ({
        dayOfWeek: requirement.dayOfWeek, label: requirement.label,
        minimumSpacingMinutes: requirement.minimumSpacingMinutes, requiredHits: requirement.requiredHits,
        sequenceRequired: requirement.sequenceRequired, status: requirement.status,
        windowEnd: requirement.windowEnd, windowStart: requirement.windowStart,
      })),
    })),
  }
}

function HitDialog({ assignment, obligation, onClose }: {
  assignment: PatrolAssignment
  obligation: PatrolObligation | PatrolMakeupObligation | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [stopId, setStopId] = useState(obligation?.stopId ?? assignment.obligations[0]?.stopId ?? '')
  const [outcome, setOutcome] = useState<Outcome>('secure')
  const [note, setNote] = useState('')
  const [extraReason, setExtraReason] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [location, setLocation] = useState<{ accuracy: number, latitude: number, longitude: number } | null>(null)
  const [locationState, setLocationState] = useState<'not_configured' | 'unavailable' | 'declined'>('not_configured')
  const selectedObligation = obligation ?? assignment.obligations.find((item) => item.stopId === stopId) ?? null
  const isExtra = obligation === null
  const isMakeup = obligation !== null && 'makeupAssignmentId' in obligation

  const mutation = useMutation({
    mutationFn: async () => {
      const idempotencyKey = crypto.randomUUID()
      const draftId = await savePatrolHit({
        accuracyMeters: location?.accuracy ?? null,
        assignmentId: assignment.id,
        classification: isExtra ? 'extra' : isMakeup ? 'makeup' : 'required',
        clientRecordedAt: new Date().toISOString(),
        extraReason: isExtra ? extraReason : null,
        idempotencyKey,
        latitude: location?.latitude ?? null,
        locationStatus: selectedObligation?.locationConfigured ? locationState : 'not_configured',
        longitude: location?.longitude ?? null,
        note,
        makeupAssignmentId: isMakeup ? obligation.makeupAssignmentId : null,
        obligationId: obligation?.id ?? null,
        outcome,
        stopId,
        submit: false,
      })
      for (const file of files) {
        await uploadPatrolEvidence(draftId, file, (value) => setProgress((current) => ({ ...current, [file.name]: value })))
      }
      await savePatrolHit({
        accuracyMeters: location?.accuracy ?? null,
        assignmentId: assignment.id,
        classification: isExtra ? 'extra' : isMakeup ? 'makeup' : 'required',
        clientRecordedAt: new Date().toISOString(),
        extraReason: isExtra ? extraReason : null,
        hitId: draftId,
        idempotencyKey,
        latitude: location?.latitude ?? null,
        locationStatus: selectedObligation?.locationConfigured ? locationState : 'not_configured',
        longitude: location?.longitude ?? null,
        note,
        makeupAssignmentId: isMakeup ? obligation.makeupAssignmentId : null,
        obligationId: obligation?.id ?? null,
        outcome,
        stopId,
        submit: true,
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['patrol-workspace'] })
      onClose()
    },
  })

  const verifyLocation = () => {
    if (!navigator.geolocation) { setLocationState('unavailable'); return }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation({ accuracy: position.coords.accuracy, latitude: position.coords.latitude, longitude: position.coords.longitude })
        setLocationState('unavailable')
      },
      (error) => setLocationState(error.code === error.PERMISSION_DENIED ? 'declined' : 'unavailable'),
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 15_000 },
    )
  }

  const allowedPhotos = selectedObligation?.allowPhotos ?? true
  const allowedVideos = selectedObligation?.allowVideos ?? true
  const accept = [allowedPhotos ? 'image/jpeg,image/png,image/webp' : '', allowedVideos ? 'video/mp4,video/webm,video/quicktime' : ''].filter(Boolean).join(',')

  return <ModalDialog busy={mutation.isPending} busyLabel="Submitting patrol hit and protecting evidence..." className="patrol-hit-dialog" description="Every submitted hit is time-stamped, tied to the assigned shift, and retained in Patrol reporting." onClose={onClose} title={isExtra ? 'Record extra patrol hit' : `${isMakeup ? 'Makeup · ' : ''}${obligation.locationLabel} · Hit ${obligation.hitNumber}`}>
    <form className="patrol-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate() }}>
      {isExtra ? <label><span>Patrol stop</span><select onChange={(event) => setStopId(event.target.value)} required value={stopId}>{Array.from(new Map(assignment.obligations.map((item) => [item.stopId, item])).values()).map((item) => <option key={item.stopId} value={item.stopId}>{item.locationLabel}</option>)}</select></label> : null}
      <label><span>Outcome</span><select onChange={(event) => setOutcome(event.target.value as Outcome)} value={outcome}><option value="secure">Secure / no issue</option><option value="attention_needed">Attention needed</option><option value="incident">Incident</option><option value="unable_to_access">Unable to access</option><option value="other">Other</option></select></label>
      {isExtra ? <label className="patrol-form--wide"><span>Reason for extra hit</span><input minLength={5} onChange={(event) => setExtraReason(event.target.value)} placeholder="Why this additional hit was completed" required value={extraReason} /></label> : null}
      <label className="patrol-form--wide"><span>Patrol note</span><textarea minLength={20} onChange={(event) => setNote(event.target.value)} placeholder="Describe what you observed and the action taken. At least 20 characters and four words." required rows={4} value={note} /><small>Meaningful notes are required for every hit.</small></label>

      {selectedObligation?.locationConfigured ? <section className="patrol-verification-card">
        <div><MapPin aria-hidden="true" size={20} /><div><strong>Location verification configured</strong><span>{location ? `Location captured within ${Math.round(location.accuracy)} meters.` : 'Capture your current location before submission.'}</span></div></div>
        <button className="secondary-button" onClick={verifyLocation} type="button">{location ? 'Refresh location' : 'Verify location'}</button>
      </section> : <section className="patrol-verification-card patrol-verification-card--neutral"><MapPin aria-hidden="true" size={20} /><div><strong>Location verification not configured</strong><span>This hit remains valid. Management can add an address and geofence in a future route version.</span></div></section>}

      {(allowedPhotos || allowedVideos) ? <label className="patrol-upload-box">
        <UploadCloud aria-hidden="true" size={24} />
        <span>{selectedObligation?.requireEvidence ? 'Add required evidence' : 'Add optional evidence'}</span>
        <small>{allowedPhotos && allowedVideos ? 'Photos or videos' : allowedPhotos ? 'Photos' : 'Videos'} · videos upload resumably · maximum 500 MB</small>
        <input accept={accept} multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} required={selectedObligation?.requireEvidence} type="file" />
      </label> : <div className="patrol-verification-card patrol-verification-card--neutral"><Shield aria-hidden="true" size={20} /><div><strong>Evidence disabled for this stop</strong><span>The patrol note and outcome are still required.</span></div></div>}

      {files.length ? <div className="patrol-upload-list">{files.map((file) => <div key={`${file.name}-${file.size}`}><span>{file.type.startsWith('video/') ? <Video aria-hidden="true" size={17} /> : <Camera aria-hidden="true" size={17} />}{file.name}</span><strong>{progress[file.name] ? `${progress[file.name]}%` : `${(file.size / 1_048_576).toFixed(1)} MB`}</strong></div>)}</div> : null}
      {mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}
      <div className="modal-actions"><button className="primary-action" disabled={mutation.isPending || !stopId} type="submit"><ClipboardCheck aria-hidden="true" size={18} />Submit patrol hit</button><button className="secondary-button" disabled={mutation.isPending} onClick={onClose} type="button">Cancel</button></div>
    </form>
  </ModalDialog>
}

function RouteEditor({ locations, onClose, route }: { locations: PatrolWorkspace['locations'], onClose: () => void, route: PatrolRoute | null }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<PatrolRouteInput>(() => route ? routeToInput(route) : emptyRoute())
  const mutation = useMutation({
    mutationFn: () => savePatrolRoute(draft),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['patrol-workspace'] }); onClose() },
  })
  const updateStop = (index: number, changes: Partial<PatrolRouteInput['stops'][number]>) => setDraft((current) => ({ ...current, stops: current.stops.map((stop, stopIndex) => stopIndex === index ? { ...stop, ...changes } : stop) }))
  const addStop = () => setDraft((current) => ({ ...current, stops: [...current.stops, emptyRoute().stops[0]] }))
  const addRequirement = (stopIndex: number) => updateStop(stopIndex, { requirements: [...draft.stops[stopIndex].requirements, { dayOfWeek: 1, label: 'Night patrol', minimumSpacingMinutes: null, requiredHits: 1, sequenceRequired: false, status: 'active', windowEnd: null, windowStart: null }] })
  const updateRequirement = (stopIndex: number, requirementIndex: number, changes: Partial<PatrolRouteInput['stops'][number]['requirements'][number]>) => updateStop(stopIndex, { requirements: draft.stops[stopIndex].requirements.map((requirement, index) => index === requirementIndex ? { ...requirement, ...changes } : requirement) })

  return <ModalDialog busy={mutation.isPending} busyLabel="Saving a new audited route version..." className="patrol-route-dialog" description="Saving creates a new route version. Existing assignments and historical patrol records remain unchanged." onClose={onClose} title={route ? `Edit ${route.name}` : 'Build patrol route'}>
    <form className="patrol-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate() }}>
      <label><span>Route name</span><input onChange={(event) => setDraft({ ...draft, name: event.target.value })} required value={draft.name} /></label>
      <label><span>Route code</span><input onChange={(event) => setDraft({ ...draft, code: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} pattern="[a-z0-9][a-z0-9-]{1,62}" required value={draft.code} /></label>
      <label><span>Route status</span><select onChange={(event) => setDraft({ ...draft, status: event.target.value as PatrolRouteInput['status'] })} value={draft.status}><option value="draft">Draft</option><option value="active">Active</option><option value="paused">Paused</option><option value="archived">Archived</option></select></label>
      <label><span>Operational time zone</span><select onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })} value={draft.timeZone}><option value="America/New_York">Eastern</option><option value="America/Chicago">Central</option><option value="America/Denver">Mountain</option><option value="America/Los_Angeles">Pacific</option></select></label>
      <label><span>Effective from (optional)</span><input onChange={(event) => setDraft({ ...draft, effectiveFrom: event.target.value || null })} type="date" value={draft.effectiveFrom ?? ''} /></label>
      <label><span>Effective through (optional)</span><input onChange={(event) => setDraft({ ...draft, effectiveThrough: event.target.value || null })} type="date" value={draft.effectiveThrough ?? ''} /></label>
      <label className="patrol-check"><input checked={draft.requiresArmed} onChange={(event) => setDraft({ ...draft, requiresArmed: event.target.checked })} type="checkbox" /><span>Armed route</span></label>
      <label className="patrol-form--wide"><span>Change reason</span><input minLength={5} onChange={(event) => setDraft({ ...draft, changeReason: event.target.value })} placeholder="Why this route version is being created" required value={draft.changeReason} /></label>

      <section className="patrol-route-stops patrol-form--wide">
        <div className="patrol-section-heading"><div><p className="eyebrow">Stops & requirements</p><h3>{draft.stops.length} route stop{draft.stops.length === 1 ? '' : 's'}</h3></div><button className="secondary-button" onClick={addStop} type="button"><Plus aria-hidden="true" size={17} />Add stop</button></div>
        {draft.stops.map((stop, stopIndex) => <details className="patrol-stop-editor" key={stop.stableKey}>
          <summary><span>Stop {stopIndex + 1}</span><strong>{stop.locationLabel || 'New patrol stop'}</strong></summary>
          <div className="patrol-stop-editor-body"><header>{draft.stops.length > 1 ? <button className="text-button text-button--danger" onClick={() => setDraft({ ...draft, stops: draft.stops.filter((_, index) => index !== stopIndex) })} type="button">Remove this stop</button> : <span />}</header>
          <div className="patrol-stop-grid">
            <label className="patrol-stop-location-link"><span>Existing Site / Post (optional)</span><select onChange={(event) => {
              const location = locations.find((item) => item.postId === event.target.value)
              updateStop(stopIndex, location ? {
                addressLine1: location.addressLine1, city: location.city, locationLabel: `${location.siteName} · ${location.postName}`,
                postId: location.postId, postalCode: location.postalCode, region: location.region, siteId: location.siteId,
              } : { postId: null, siteId: null })
            }} value={stop.postId ?? ''}><option value="">Not linked / enter manually</option>{locations.map((location) => <option key={location.postId} value={location.postId}>{location.siteName} · {location.postName}</option>)}</select></label>
            <label><span>Location name</span><input onChange={(event) => updateStop(stopIndex, { locationLabel: event.target.value })} required value={stop.locationLabel} /></label>
            <label><span>Address (optional)</span><input onChange={(event) => updateStop(stopIndex, { addressLine1: event.target.value || null })} placeholder="Add later if unknown" value={stop.addressLine1 ?? ''} /></label>
            <label><span>City</span><input onChange={(event) => updateStop(stopIndex, { city: event.target.value || null })} value={stop.city ?? ''} /></label>
            <label><span>State</span><input maxLength={2} onChange={(event) => updateStop(stopIndex, { region: event.target.value.toUpperCase() || null })} value={stop.region ?? ''} /></label>
            <label><span>Standard video limit</span><select onChange={(event) => updateStop(stopIndex, { standardVideoLimitSeconds: Number(event.target.value) })} value={stop.standardVideoLimitSeconds}><option value={180}>3 minutes</option><option value={300}>5 minutes</option><option value={600}>10 minutes</option><option value={900}>15 minutes</option></select></label>
            <label><span>Incident video limit</span><select onChange={(event) => updateStop(stopIndex, { incidentVideoLimitSeconds: Number(event.target.value) })} value={stop.incidentVideoLimitSeconds}><option value={300}>5 minutes</option><option value={900}>15 minutes</option><option value={1800}>30 minutes</option><option value={3600}>60 minutes</option></select></label>
          </div>
          <div className="patrol-evidence-options"><label className="patrol-check"><input checked={stop.allowPhotos} onChange={(event) => updateStop(stopIndex, { allowPhotos: event.target.checked })} type="checkbox" /><span>Allow photos</span></label><label className="patrol-check"><input checked={stop.allowVideos} onChange={(event) => updateStop(stopIndex, { allowVideos: event.target.checked })} type="checkbox" /><span>Allow videos</span></label><label className="patrol-check"><input checked={stop.requireEvidence} onChange={(event) => updateStop(stopIndex, { requireEvidence: event.target.checked })} type="checkbox" /><span>Require evidence</span></label></div>
          {stop.requireEvidence ? <label><span>Evidence instructions</span><textarea onChange={(event) => updateStop(stopIndex, { evidenceInstructions: event.target.value || null })} placeholder="Tell the guard exactly what must be shown." rows={2} value={stop.evidenceInstructions ?? ''} /></label> : null}
          <label><span>Guard instructions (optional)</span><textarea onChange={(event) => updateStop(stopIndex, { instructions: event.target.value || null })} rows={2} value={stop.instructions ?? ''} /></label>
          <details className="patrol-advanced-controls"><summary>Optional address and location verification</summary><div className="patrol-stop-grid"><label><span>Postal code</span><input onChange={(event) => updateStop(stopIndex, { postalCode: event.target.value || null })} value={stop.postalCode ?? ''} /></label><label><span>Latitude</span><input max={90} min={-90} onChange={(event) => updateStop(stopIndex, { latitude: event.target.value === '' ? null : Number(event.target.value) })} step="any" type="number" value={stop.latitude ?? ''} /></label><label><span>Longitude</span><input max={180} min={-180} onChange={(event) => updateStop(stopIndex, { longitude: event.target.value === '' ? null : Number(event.target.value) })} step="any" type="number" value={stop.longitude ?? ''} /></label><label><span>Geofence radius</span><input max={5000} min={25} onChange={(event) => updateStop(stopIndex, { geofenceRadiusMeters: event.target.value === '' ? null : Number(event.target.value) })} placeholder="250 meters by default" type="number" value={stop.geofenceRadiusMeters ?? ''} /></label></div></details>
          <div className="patrol-requirement-heading"><strong>Weekly hit requirements</strong><button className="secondary-button secondary-button--compact" onClick={() => addRequirement(stopIndex)} type="button"><Plus aria-hidden="true" size={15} />Add requirement</button></div>
          {stop.requirements.length === 0 ? <p className="patrol-empty-inline">No days configured yet. This stop will not generate required hits.</p> : <div className="patrol-requirement-list">{stop.requirements.map((requirement, requirementIndex) => <article className="patrol-requirement-item" key={`${stop.stableKey}-${requirementIndex}`}><div className="patrol-requirement-row">
            <select aria-label="Day" onChange={(event) => updateRequirement(stopIndex, requirementIndex, { dayOfWeek: Number(event.target.value) })} value={requirement.dayOfWeek}>{dayLabels.map((day, dayIndex) => <option key={day} value={dayIndex}>{day}</option>)}</select>
            <input aria-label="Requirement name" onChange={(event) => updateRequirement(stopIndex, requirementIndex, { label: event.target.value })} value={requirement.label} />
            <input aria-label="Required hits" max={50} min={1} onChange={(event) => updateRequirement(stopIndex, requirementIndex, { requiredHits: Number(event.target.value) })} type="number" value={requirement.requiredHits} />
            <select aria-label="Requirement status" onChange={(event) => updateRequirement(stopIndex, requirementIndex, { status: event.target.value as 'active' | 'paused' })} value={requirement.status}><option value="active">Active</option><option value="paused">On hold</option></select>
            <button aria-label="Remove requirement" className="text-button text-button--danger" onClick={() => updateStop(stopIndex, { requirements: stop.requirements.filter((_, index) => index !== requirementIndex) })} type="button">Remove</button>
          </div><details className="patrol-requirement-advanced"><summary>Optional time window, spacing, and sequence</summary><div><label><span>Start time</span><input onChange={(event) => updateRequirement(stopIndex, requirementIndex, { windowStart: event.target.value || null })} type="time" value={requirement.windowStart ?? ''} /></label><label><span>End time</span><input onChange={(event) => updateRequirement(stopIndex, requirementIndex, { windowEnd: event.target.value || null })} type="time" value={requirement.windowEnd ?? ''} /></label><label><span>Minimum spacing (minutes)</span><input max={720} min={1} onChange={(event) => updateRequirement(stopIndex, requirementIndex, { minimumSpacingMinutes: event.target.value === '' ? null : Number(event.target.value) })} type="number" value={requirement.minimumSpacingMinutes ?? ''} /></label><label className="patrol-check"><input checked={requirement.sequenceRequired} onChange={(event) => updateRequirement(stopIndex, requirementIndex, { sequenceRequired: event.target.checked })} type="checkbox" /><span>Require route sequence</span></label></div></details></article>)}</div>}
        </div></details>)}
      </section>
      {mutation.isError ? <div className="inline-alert patrol-form--wide" role="alert">{mutation.error.message}</div> : null}
      <div className="modal-actions patrol-form--wide"><button className="primary-action" disabled={mutation.isPending} type="submit"><BadgeCheck aria-hidden="true" size={18} />Save route version</button><button className="secondary-button" disabled={mutation.isPending} onClick={onClose} type="button">Cancel</button></div>
    </form>
  </ModalDialog>
}

function Pagination({ page, pageSize, setPage, total }: { page: number, pageSize: number, setPage: (page: number) => void, total: number }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  if (total <= pageSize) return null
  return <div className="reports-pagination"><button className="secondary-button" disabled={page <= 1} onClick={() => setPage(page - 1)} type="button"><ChevronLeft aria-hidden="true" size={17} />Previous</button><span>Page {page} of {totalPages}</span><button className="secondary-button" disabled={page >= totalPages} onClick={() => setPage(page + 1)} type="button">Next<ChevronRight aria-hidden="true" size={17} /></button></div>
}

export function PatrolPage() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<PatrolTab>('overview')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<(typeof pageSizes)[number]>(10)
  const [hitTarget, setHitTarget] = useState<{ assignment: PatrolAssignment, obligation: PatrolObligation | PatrolMakeupObligation | null } | null>(null)
  const [routeTarget, setRouteTarget] = useState<PatrolRoute | null | undefined>(undefined)
  const [linkRouteId, setLinkRouteId] = useState('')
  const [linkCandidate, setLinkCandidate] = useState('')
  const [makeupAssignment, setMakeupAssignment] = useState('')
  const [makeupTarget, setMakeupTarget] = useState<string | null>(null)
  const [makeupReason, setMakeupReason] = useState('Missed patrol hit assigned for documented makeup completion.')

  const workspaceQuery = useQuery({ queryKey: ['patrol-workspace'], queryFn: getPatrolWorkspace, enabled: isSupabaseConfigured })
  const linkMutation = useMutation({
    mutationFn: async () => {
      const candidate = workspaceQuery.data?.scheduleCandidates.find((item) => item.shiftId === linkCandidate)
      if (!candidate) throw new Error('Choose an assigned published shift.')
      return linkPatrolRouteShift(linkRouteId, candidate.shiftId, candidate.employeeId)
    },
    onSuccess: async () => { setLinkCandidate(''); await queryClient.invalidateQueries({ queryKey: ['patrol-workspace'] }) },
  })
  const makeupMutation = useMutation({
    mutationFn: () => assignPatrolMakeup(makeupTarget ?? '', makeupAssignment, makeupReason),
    onSuccess: async () => { setMakeupTarget(null); await queryClient.invalidateQueries({ queryKey: ['patrol-workspace'] }) },
  })
  const evidenceMutation = useMutation({
    mutationFn: ({ action, id }: { action: 'preview' | 'download', id: string }) => openPatrolEvidence(id, action),
  })

  const workspace = workspaceQuery.data
  const term = search.trim().toLowerCase()
  const filteredAssignments = useMemo(() => (workspace?.assignments ?? []).filter((assignment) => !term || `${assignment.routeName} ${assignment.employeeName} ${assignment.serviceDate}`.toLowerCase().includes(term)), [term, workspace?.assignments])
  const ownAssignments = filteredAssignments.filter((assignment) => assignment.employeeId === workspace?.actor.employeeId)
  const operationsAssignments = filteredAssignments.filter((assignment) => assignment.employeeId !== workspace?.actor.employeeId || workspace?.actor.canViewOperations)
  const filteredRoutes = (workspace?.routes ?? []).filter((route) => !term || `${route.name} ${route.code} ${route.status} ${route.stops.map((stop) => stop.locationLabel).join(' ')}`.toLowerCase().includes(term))
  const currentItems = tab === 'routes' ? filteredRoutes : tab === 'my-patrol' ? ownAssignments : operationsAssignments
  const visibleItems = currentItems.slice((page - 1) * pageSize, page * pageSize)

  if (!isSupabaseConfigured) return <div className="page page--patrol"><DataStatePanel icon={DatabaseZap} title="Patrol needs the secure connection" tone="setup"><p>Patrol becomes available after the protected data connection is restored.</p></DataStatePanel></div>
  if (workspaceQuery.isPending) return <div className="page page--patrol"><DataStatePanel icon={MapPinned} title="Loading Patrol operations"><p>Checking route versions, assigned shifts, hit requirements, and protected evidence.</p></DataStatePanel></div>
  if (workspaceQuery.isError) return <div className="page page--patrol"><DataStatePanel icon={ShieldAlert} title="Patrol unavailable" tone="error"><p>{workspaceQuery.error.message}</p></DataStatePanel></div>
  if (!workspace) return null

  const makeupSourceAssignment = workspace.assignments.find((assignment) => assignment.id === workspace.makeupQueue.find((item) => item.obligationId === makeupTarget)?.assignmentId)
  const makeupEligibleAssignments = workspace.assignments.filter((assignment) => assignment.status === 'active'
    && assignment.routeVersionId === makeupSourceAssignment?.routeVersionId
    && new Date(assignment.endsAt).getTime() >= Date.now())

  const allObligations = workspace.assignments.flatMap((assignment) => assignment.obligations)
  const required = allObligations.length
  const completed = allObligations.filter((item) => item.status === 'completed').length
  const missed = allObligations.filter((item) => item.status === 'missed').length
  const activeAssignments = workspace.assignments.filter((assignment) => assignment.status === 'active').length

  const changeTab = (next: PatrolTab) => { setTab(next); setPage(1); setSearch('') }
  return <div className="page page--patrol patrol-workspace">
    <section className="page-intro patrol-intro">
      <div><p className="eyebrow">Operations</p><h1>Patrol Command Center</h1><p className="page-summary">Run assigned patrols, document every hit, manage versioned routes, and report from one protected workspace.</p></div>
      <div className="access-note"><Shield aria-hidden="true" size={19} /><span>Protected Patrol workspace<br /><small>Schedule-linked · audited · private evidence</small></span></div>
    </section>

    <section className="patrol-metrics" aria-label="Patrol status">
      <article><RouteIcon aria-hidden="true" /><div><span>Active assignments</span><strong>{activeAssignments}</strong><small>Schedule-linked patrols</small></div></article>
      <article><ClipboardCheck aria-hidden="true" /><div><span>Required hits</span><strong>{required}</strong><small>In the current workspace window</small></div></article>
      <article className="patrol-metric--success"><CheckCircle2 aria-hidden="true" /><div><span>Completed</span><strong>{completed}</strong><small>Submitted with required notes</small></div></article>
      <article className={missed ? 'patrol-metric--danger' : ''}><AlertTriangle aria-hidden="true" /><div><span>Missed</span><strong>{missed}</strong><small>Available for makeup review</small></div></article>
    </section>

    <nav className="patrol-tabs" aria-label="Patrol workspace">
      <button className={tab === 'overview' ? 'is-active' : ''} onClick={() => changeTab('overview')} type="button">Overview</button>
      <button className={tab === 'my-patrol' ? 'is-active' : ''} onClick={() => changeTab('my-patrol')} type="button">My Patrol</button>
      {workspace.actor.canViewOperations ? <button className={tab === 'operations' ? 'is-active' : ''} onClick={() => changeTab('operations')} type="button">Operations</button> : null}
      {workspace.actor.canManageRoutes ? <button className={tab === 'routes' ? 'is-active' : ''} onClick={() => changeTab('routes')} type="button">Routes & Requirements</button> : null}
    </nav>

    {tab === 'overview' ? <>
      <section className="patrol-overview-grid">
        <article className="operations-panel patrol-priority-panel"><div className="patrol-section-heading"><div><p className="eyebrow">Assigned work</p><h2>My active patrols</h2></div><button className="secondary-button" onClick={() => changeTab('my-patrol')} type="button">Open My Patrol</button></div>
          {ownAssignments.length === 0 ? <p className="patrol-empty-inline">No patrol route is currently connected to one of your published shifts.</p> : ownAssignments.slice(0, 5).map((assignment) => <button className="patrol-overview-row" key={assignment.id} onClick={() => changeTab('my-patrol')} type="button"><span><strong>{assignment.routeName}</strong><small>{formatPatrolDateTime(assignment.startsAt, assignment.timeZone)}</small></span><span>{percentComplete(assignment)}% complete</span></button>)}
        </article>
        <article className="operations-panel patrol-priority-panel"><div className="patrol-section-heading"><div><p className="eyebrow">Attention</p><h2>Missed & makeup work</h2></div>{workspace.actor.canViewOperations ? <button className="secondary-button" onClick={() => changeTab('operations')} type="button">Review queue</button> : null}</div>
          {workspace.makeupQueue.length === 0 ? <p className="patrol-empty-inline">No missed patrol hits are waiting for management review.</p> : workspace.makeupQueue.slice(0, 5).map((item) => <div className="patrol-overview-row" key={item.obligationId}><span><strong>{item.locationLabel}</strong><small>{item.routeName} · {item.employeeName}</small></span><span className="patrol-status patrol-status--missed">Missed</span></div>)}
        </article>
      </section>
      <section className="operations-panel patrol-report-callout"><FileBarChart aria-hidden="true" size={26} /><div><p className="eyebrow">Reporting</p><h2>Patrol Activity report</h2><p>Filter required, completed, missed, extra, incident, location, and evidence records. Export uses a separately audited permission.</p></div><Link className="primary-action" to="/reports/patrolActivity">Open report</Link></section>
    </> : null}

    {tab !== 'overview' ? <section className="workforce-toolbar patrol-toolbar" aria-label="Patrol list controls">
      <label className="search-field search-field--wide"><Search aria-hidden="true" size={19} /><span className="visually-hidden">Search Patrol</span><input onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder={tab === 'routes' ? 'Search route, stop, status, or code' : 'Search route, guard, or service date'} type="search" value={search} /></label>
      <label className="patrol-row-count"><span>Rows</span><select onChange={(event) => { setPageSize(Number(event.target.value) as (typeof pageSizes)[number]); setPage(1) }} value={pageSize}>{pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
      {tab === 'routes' ? <button className="primary-action" onClick={() => setRouteTarget(null)} type="button"><Plus aria-hidden="true" size={18} />Build route</button> : null}
    </section> : null}

    {tab === 'my-patrol' ? <section className="patrol-assignment-list">
      {visibleItems.length === 0 ? <DataStatePanel icon={MapPinned} title="No assigned patrols"><p>Published shifts become workable here after management connects the appropriate patrol route.</p></DataStatePanel> : (visibleItems as PatrolAssignment[]).map((assignment) => <article className="operations-panel patrol-assignment-card" key={assignment.id}>
        <header><div><p className="eyebrow">{assignment.requiresArmed ? 'Armed patrol' : 'Unarmed patrol'}</p><h2>{assignment.routeName}</h2><span>{formatPatrolDateTime(assignment.startsAt, assignment.timeZone)} – {formatPatrolDateTime(assignment.endsAt, assignment.timeZone)}</span></div><div className="patrol-progress"><strong>{percentComplete(assignment)}%</strong><span>complete</span></div></header>
        <div className="patrol-obligation-list">{assignment.obligations.map((obligation) => <div className="patrol-obligation-row" key={obligation.id}><div><strong>{obligation.locationLabel}</strong><span>{obligation.requirementLabel} · Hit {obligation.hitNumber}</span><small>{obligation.status === 'completed' ? 'Completed and recorded' : `Due ${formatPatrolDateTime(obligation.dueEndAt, assignment.timeZone)}`}</small></div><span className={`patrol-status patrol-status--${obligation.status}`}>{statusLabel(obligation.status)}</span>{obligation.status === 'completed' ? <CheckCircle2 aria-label="Completed" className="patrol-complete-icon" size={22} /> : <button className="primary-action primary-action--compact" onClick={() => setHitTarget({ assignment, obligation })} type="button">Complete hit</button>}</div>)}</div>
        {assignment.makeupObligations.length ? <section className="patrol-makeup-work"><strong>Assigned makeup work</strong>{assignment.makeupObligations.map((obligation) => <div className="patrol-obligation-row" key={obligation.makeupAssignmentId}><div><strong>{obligation.locationLabel}</strong><span>{obligation.requirementLabel} · Original hit {obligation.hitNumber}</span><small>{obligation.reason} · Missed {obligation.originalServiceDate} by {obligation.originalEmployeeName}</small></div><span className="patrol-status patrol-status--late">Makeup</span><button className="primary-action primary-action--compact" onClick={() => setHitTarget({ assignment, obligation })} type="button">Complete makeup</button></div>)}</section> : null}
        {assignment.hits.some((hit) => hit.evidence.some((evidence) => evidence.status === 'stored')) ? <div className="patrol-evidence-library"><strong>Recent protected evidence</strong>{assignment.hits.flatMap((hit) => hit.evidence.filter((evidence) => evidence.status === 'stored').map((evidence) => ({ evidence, hit }))).slice(0, 5).map(({ evidence, hit }) => <div key={evidence.id}><span>{evidence.kind === 'video' ? <Video aria-hidden="true" size={16} /> : <Camera aria-hidden="true" size={16} />}<span>{hit.locationLabel} · {evidence.filename}</span></span><div><button className="text-button" disabled={evidenceMutation.isPending} onClick={() => evidenceMutation.mutate({ action: 'preview', id: evidence.id })} type="button">View</button><button className="text-button" disabled={evidenceMutation.isPending} onClick={() => evidenceMutation.mutate({ action: 'download', id: evidence.id })} type="button"><Download aria-hidden="true" size={14} />Download</button></div></div>)}</div> : null}
        {evidenceMutation.isError ? <div className="inline-alert" role="alert">{evidenceMutation.error.message}</div> : null}
        <footer><button className="secondary-button" onClick={() => setHitTarget({ assignment, obligation: null })} type="button"><Plus aria-hidden="true" size={17} />Record extra hit</button></footer>
      </article>)}
      <Pagination page={page} pageSize={pageSize} setPage={setPage} total={ownAssignments.length} />
    </section> : null}

    {tab === 'operations' && workspace.actor.canViewOperations ? <>
      <section className="operations-panel patrol-link-panel"><div className="patrol-section-heading"><div><p className="eyebrow">Schedule integration</p><h2>Connect route to published shift</h2><p>Patrol assignments reuse the employee and times already approved in Schedule.</p></div></div>
        <form className="patrol-link-form" onSubmit={(event) => { event.preventDefault(); linkMutation.mutate() }}><label><span>Active route</span><select onChange={(event) => setLinkRouteId(event.target.value)} required value={linkRouteId}><option value="">Choose route</option>{workspace.routes.filter((route) => route.status === 'active').map((route) => <option key={route.id} value={route.id}>{route.name}</option>)}</select></label><label><span>Published assigned shift</span><select onChange={(event) => setLinkCandidate(event.target.value)} required value={linkCandidate}><option value="">Choose shift and employee</option>{workspace.scheduleCandidates.map((candidate) => <option key={`${candidate.shiftId}-${candidate.employeeId}`} value={candidate.shiftId}>{candidate.employeeName} · {candidate.siteName ?? candidate.postName ?? 'Scheduled shift'} · {formatPatrolDateTime(candidate.startsAt, candidate.timeZone)}</option>)}</select></label><button className="primary-action" disabled={linkMutation.isPending} type="submit">{linkMutation.isPending ? 'Connecting...' : 'Connect patrol'}</button></form>
        {linkMutation.isError ? <div className="inline-alert" role="alert">{linkMutation.error.message}</div> : null}{linkMutation.isSuccess ? <div className="form-feedback form-feedback--success" role="status">Patrol requirements were generated from the active route version.</div> : null}
      </section>
      <section className="operations-panel patrol-operations-panel"><div className="patrol-section-heading"><div><p className="eyebrow">Live operations</p><h2>Patrol assignments</h2></div></div>{(visibleItems as PatrolAssignment[]).length === 0 ? <p className="patrol-empty-inline">No patrol assignments match the current search.</p> : (visibleItems as PatrolAssignment[]).map((assignment) => <div className="patrol-operation-row" key={assignment.id}><div><strong>{assignment.employeeName}</strong><span>{assignment.routeName} · {assignment.serviceDate}</span></div><div><strong>{assignment.obligations.filter((item) => item.status === 'completed').length}/{assignment.obligations.length}</strong><span>required hits</span></div><span className={assignment.obligations.some((item) => item.status === 'missed') ? 'patrol-status patrol-status--missed' : 'patrol-status patrol-status--active'}>{assignment.obligations.some((item) => item.status === 'missed') ? 'Needs review' : 'In progress'}</span></div>)}<Pagination page={page} pageSize={pageSize} setPage={setPage} total={operationsAssignments.length} /></section>
      <section className="operations-panel patrol-makeup-panel"><div className="patrol-section-heading"><div><p className="eyebrow">Exception queue</p><h2>Missed hits awaiting makeup</h2></div><span className="patrol-count">{workspace.makeupQueue.length}</span></div>{workspace.makeupQueue.slice(0, 10).map((item) => <div className="patrol-operation-row" key={item.obligationId}><div><strong>{item.locationLabel}</strong><span>{item.routeName} · {item.employeeName} · {item.serviceDate}</span></div><button className="secondary-button" onClick={() => { setMakeupTarget(item.obligationId); setMakeupAssignment('') }} type="button">Assign makeup</button></div>)}{workspace.makeupQueue.length === 0 ? <p className="patrol-empty-inline">The makeup queue is clear.</p> : null}</section>
    </> : null}

    {tab === 'routes' && workspace.actor.canManageRoutes ? <section className="operations-panel patrol-route-library"><div className="patrol-section-heading"><div><p className="eyebrow">Versioned configuration</p><h2>Routes & requirements</h2><p>Only the current version is editable. Prior versions remain attached to historical assignments.</p></div></div>{(visibleItems as PatrolRoute[]).map((route) => <article className="patrol-route-row" key={route.id}><div><strong>{route.name}</strong><span>{route.code} · Version {route.versionNumber} · {route.timeZone.replace('America/', '')}</span></div><span className={`patrol-status patrol-status--${route.status}`}>{statusLabel(route.status)}</span><div><strong>{route.stops.length}</strong><span>stops</span></div><div><strong>{route.stops.reduce((total, stop) => total + stop.requirements.filter((item) => item.status === 'active').reduce((sum, item) => sum + item.requiredHits, 0), 0)}</strong><span>weekly configured hits</span></div><button className="secondary-button" onClick={() => setRouteTarget(route)} type="button">Edit route</button></article>)}{visibleItems.length === 0 ? <p className="patrol-empty-inline">No routes match this search.</p> : null}<Pagination page={page} pageSize={pageSize} setPage={setPage} total={filteredRoutes.length} /></section> : null}

    {hitTarget ? <HitDialog assignment={hitTarget.assignment} obligation={hitTarget.obligation} onClose={() => setHitTarget(null)} /> : null}
    {routeTarget !== undefined ? <RouteEditor locations={workspace.locations} onClose={() => setRouteTarget(undefined)} route={routeTarget} /> : null}
    {makeupTarget ? <ModalDialog busy={makeupMutation.isPending} description="Makeup work remains separate from the original missed requirement and does not rewrite compliance history." onClose={() => setMakeupTarget(null)} title="Assign makeup patrol hit"><form className="patrol-form" onSubmit={(event: FormEvent) => { event.preventDefault(); makeupMutation.mutate() }}><label className="patrol-form--wide"><span>Current or upcoming assignment on the same route</span><select onChange={(event) => setMakeupAssignment(event.target.value)} required value={makeupAssignment}><option value="">Choose assignment</option>{makeupEligibleAssignments.map((assignment) => <option key={assignment.id} value={assignment.id}>{assignment.employeeName} · {assignment.routeName} · {assignment.serviceDate}</option>)}</select><small>{makeupEligibleAssignments.length ? 'The guard will see a Complete Makeup action in My Patrol.' : 'Connect this route to a current or upcoming assigned shift before assigning makeup work.'}</small></label><label className="patrol-form--wide"><span>Reason</span><textarea minLength={5} onChange={(event) => setMakeupReason(event.target.value)} required rows={3} value={makeupReason} /></label>{makeupMutation.isError ? <div className="inline-alert patrol-form--wide" role="alert">{makeupMutation.error.message}</div> : null}<div className="modal-actions patrol-form--wide"><button className="primary-action" disabled={makeupMutation.isPending || makeupEligibleAssignments.length === 0} type="submit">Assign makeup</button><button className="secondary-button" onClick={() => setMakeupTarget(null)} type="button">Cancel</button></div></form></ModalDialog> : null}
  </div>
}
