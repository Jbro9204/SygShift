import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, CalendarClock, CircleStop, DatabaseZap, Eye, Megaphone, Plus, Search, Send, ShieldAlert, Trash2, XCircle } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  ANNOUNCEMENT_BANNER_ROLE_OPTIONS,
  cancelAnnouncementWorkItem,
  changeAnnouncementBannerLifecycle,
  emptyFields,
  getAnnouncementBannerManager,
  getAnnouncementHistory,
  getAnnouncementWorkItems,
  getCommunicationWorkspace,
  previewAnnouncementWorkItem,
  publishAnnouncementWorkItem,
  saveAnnouncementBanner,
  saveAnnouncementWorkItem,
  type AnnouncementAudienceMode,
  type AnnouncementBanner,
  type AnnouncementBannerAudience,
  type AnnouncementBannerMutationInput,
  type AnnouncementDeliveryChannel,
  type AnnouncementField,
  type AnnouncementHistoryItem,
  type AnnouncementPreview,
  type AnnouncementTemplate,
  type AnnouncementWorkItem,
  type AnnouncementWorkItemInput,
  type CommunicationWorkspace,
} from '../data/announcements'
import type { AppRole } from '../data/session'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'

type WorkspaceTab = 'overview' | 'banners' | 'history'
type WorkStatus = 'all' | 'draft' | 'scheduled' | 'failed'

const titleCase = (value: string) => value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
const bannerStatusClass = (status: AnnouncementBanner['lifecycleStatus']) => status === 'active'
  ? 'status-badge status-badge--active'
  : status === 'scheduled'
    ? 'status-badge status-badge--leave'
    : status === 'expired' || status === 'canceled'
      ? 'status-badge status-badge--separated'
      : 'status-badge'
const toLocalInput = (value?: string | null) => {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
const toIso = (value: string) => value ? new Date(value).toISOString() : null
const defaultAnnouncementExpirationLocal = () => {
  const date = new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
const pageSizeOptions = [5, 10, 20] as const

function FieldInput({ field, value, onChange }: { field: AnnouncementField, value: string, onChange: (value: string) => void }) {
  if (field.type === 'textarea') return <textarea onChange={(event) => onChange(event.target.value)} placeholder={field.placeholder} required value={value} />
  if (field.type === 'select') return <select onChange={(event) => onChange(event.target.value)} required value={value}><option value="">Choose one</option>{field.options?.map((option) => <option key={option}>{option}</option>)}</select>
  return <input onChange={(event) => onChange(event.target.value)} placeholder={field.placeholder} required type={field.type} value={value} />
}

function ComposerModal({ workspace, item, onClose }: { workspace: CommunicationWorkspace, item?: AnnouncementWorkItem, onClose: () => void }) {
  const queryClient = useQueryClient()
  const initialTemplate = workspace.templates.find((template) => template.key === item?.templateKey) ?? workspace.templates[0]
  const [step, setStep] = useState(1)
  const [templateKey, setTemplateKey] = useState(initialTemplate?.key ?? '')
  const template = workspace.templates.find((entry) => entry.key === templateKey) ?? initialTemplate
  const [fields, setFields] = useState<Record<string, string>>(() => item ? Object.fromEntries(Object.entries(item.templateFields).map(([key, value]) => [key, String(value ?? '')])) : template ? emptyFields(template) : {})
  const [audienceMode, setAudienceMode] = useState<AnnouncementAudienceMode>(item?.audienceMode ?? 'everyone')
  const [audienceRoles, setAudienceRoles] = useState<AppRole[]>(item?.audienceRoles ?? [])
  const [audiencePostIds, setAudiencePostIds] = useState<string[]>(item?.audiencePostIds ?? [])
  const [channels, setChannels] = useState<AnnouncementDeliveryChannel[]>(item?.deliveryChannels ?? ['email', 'employee_home'])
  const [expiresAt, setExpiresAt] = useState(item ? toLocalInput(item.expiresAt) : defaultAnnouncementExpirationLocal())
  const [scheduledFor, setScheduledFor] = useState(toLocalInput(item?.scheduledFor))
  const [acknowledgmentRequired, setAcknowledgmentRequired] = useState(item?.acknowledgmentRequired ?? false)
  const [acknowledgmentDueAt, setAcknowledgmentDueAt] = useState(toLocalInput(item?.acknowledgmentDueAt))
  const [postSearch, setPostSearch] = useState('')
  const [preview, setPreview] = useState<AnnouncementPreview | null>(null)
  const visiblePosts = workspace.posts.filter((post) => post.label.toLowerCase().includes(postSearch.toLowerCase())).slice(0, 5)
  const refresh = async () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['communications-workspace'] }),
    queryClient.invalidateQueries({ queryKey: ['announcement-work-items'] }),
    queryClient.invalidateQueries({ queryKey: ['announcement-history'] }),
    queryClient.invalidateQueries({ queryKey: ['notification-center'] }),
  ])
  const payload = (status: 'draft' | 'scheduled'): AnnouncementWorkItemInput => ({
    acknowledgmentDueAt: toIso(acknowledgmentDueAt), acknowledgmentRequired, audienceMode, audiencePostIds, audienceRoles,
    deliveryChannels: channels, expiresAt: toIso(expiresAt), fields, id: item?.id, scheduledFor: toIso(scheduledFor), status, templateKey,
  })
  const previewMutation = useMutation({ mutationFn: () => previewAnnouncementWorkItem(payload('draft')), onSuccess: (result) => { setPreview(result); setStep(4) } })
  const saveMutation = useMutation({ mutationFn: (status: 'draft' | 'scheduled') => saveAnnouncementWorkItem(payload(status)), onSuccess: async () => { await refresh(); onClose() } })
  const publishMutation = useMutation({ mutationFn: async () => { const saved = await saveAnnouncementWorkItem(payload('draft')); return publishAnnouncementWorkItem(saved.id) }, onSuccess: async () => { await refresh(); onClose() } })
  const busy = previewMutation.isPending || saveMutation.isPending || publishMutation.isPending
  const error = previewMutation.error ?? saveMutation.error ?? publishMutation.error
  const selectTemplate = (selected: AnnouncementTemplate) => { setTemplateKey(selected.key); setFields(emptyFields(selected)); setPreview(null); setStep(2) }
  const toggleRole = (role: AppRole) => setAudienceRoles((current) => current.includes(role) ? current.filter((entry) => entry !== role) : [...current, role])
  const togglePost = (id: string) => setAudiencePostIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id])
  const toggleChannel = (channel: AnnouncementDeliveryChannel) => setChannels((current) => current.includes(channel) ? current.filter((entry) => entry !== channel) : [...current, channel])
  return <ModalDialog busy={busy} busyLabel="Saving communication…" className="communications-modal communications-modal--composer" description="Create, target, preview, and publish one approved communication." onClose={onClose} title={item ? 'Edit communication' : 'New announcement'}>
    <nav aria-label="Composer steps" className="communications-stepper">{['Template', 'Message', 'Audience', 'Preview'].map((label, index) => <button className={step === index + 1 ? 'is-active' : ''} key={label} onClick={() => setStep(index + 1)} type="button"><span>{index + 1}</span>{label}</button>)}</nav>
    <div className="communications-composer__body">
      {step === 1 ? <section><p className="eyebrow">Approved templates</p><h3>Choose the message type</h3><div className="communications-template-grid">{workspace.templates.map((entry) => <button className={entry.key === templateKey ? 'communications-template is-selected' : 'communications-template'} key={entry.key} onClick={() => selectTemplate(entry)} type="button"><strong>{entry.name}</strong><span>{entry.description}</span></button>)}</div></section> : null}
      {step === 2 && template ? <section><p className="eyebrow">Message details</p><h3>{template.name}</h3><div className="communications-form-grid">{template.requiredFields.map((field) => <label className={field.type === 'textarea' ? 'span-2' : ''} key={field.key}><span>{field.label}</span><FieldInput field={field} onChange={(value) => { setFields((current) => ({ ...current, [field.key]: value })); setPreview(null) }} value={fields[field.key] ?? ''} /></label>)}<label><span>Visible until (optional)</span><input onChange={(event) => setExpiresAt(event.target.value)} type="datetime-local" value={expiresAt} /></label><label><span>Schedule for (optional)</span><input onChange={(event) => setScheduledFor(event.target.value)} type="datetime-local" value={scheduledFor} /></label><label className="communications-check span-2"><input checked={acknowledgmentRequired} onChange={(event) => setAcknowledgmentRequired(event.target.checked)} type="checkbox" />Require employee acknowledgment</label>{acknowledgmentRequired ? <label><span>Acknowledgment due</span><input onChange={(event) => setAcknowledgmentDueAt(event.target.value)} required type="datetime-local" value={acknowledgmentDueAt} /></label> : null}</div></section> : null}
      {step === 3 ? <section><p className="eyebrow">Employee visibility and delivery</p><h3>Send only to the right people</h3><div className="communications-form-grid"><label><span>Audience</span><select onChange={(event) => setAudienceMode(event.target.value as AnnouncementAudienceMode)} value={audienceMode}><option value="everyone">Everyone</option><option value="roles">Selected roles</option><option value="sites">Selected sites/posts</option><option value="qualified">Qualified employees</option><option value="shift_eligible">Shift-eligible employees</option></select></label><fieldset className="communications-choice-panel"><legend>Delivery channels</legend>{([['email', 'Email'], ['employee_home', 'Employee Home'], ['workspace_alert', 'Workspace alert']] as const).map(([value, label]) => <label className="communications-check" key={value}><input checked={channels.includes(value)} onChange={() => toggleChannel(value)} type="checkbox" />{label}</label>)}</fieldset>{audienceMode === 'roles' ? <fieldset className="communications-choice-panel span-2"><legend>Roles</legend><div className="communications-inline-choices">{ANNOUNCEMENT_BANNER_ROLE_OPTIONS.map(({ role, label }) => <label className="communications-check" key={role}><input checked={audienceRoles.includes(role)} onChange={() => toggleRole(role)} type="checkbox" />{label}</label>)}</div></fieldset> : null}{audienceMode === 'sites' || audienceMode === 'shift_eligible' ? <fieldset className="communications-choice-panel span-2"><legend>Sites/posts</legend><input onChange={(event) => setPostSearch(event.target.value)} placeholder="Search site or post" value={postSearch} /><div className="communications-choice-list">{visiblePosts.map((post) => <label className="communications-check" key={post.id}><input checked={audiencePostIds.includes(post.id)} onChange={() => togglePost(post.id)} type="checkbox" />{post.label}</label>)}</div><small>Showing up to five matches. Refine the search to find another post.</small></fieldset> : null}</div></section> : null}
      {step === 4 ? <section><p className="eyebrow">Final review</p><h3>Preview before publishing</h3>{preview ? <article className="communications-preview"><strong>{preview.title}</strong><p>{preview.body}</p><span>{preview.recipientCount} recipients · {channels.map(titleCase).join(', ')}</span></article> : <DataStatePanel icon={Eye} title="Generate the final preview"><p>Preview calculates the exact audience before anything is sent.</p></DataStatePanel>}</section> : null}
      {error ? <div className="inline-alert" role="alert">{error.message}</div> : null}
    </div>
    <div className="communications-modal__actions"><button className="secondary-button" disabled={busy || step === 1} onClick={() => setStep((value) => Math.max(1, value - 1))} type="button">Back</button><span className="communications-modal__spacer" />{step < 4 ? <button className="primary-action" onClick={() => step === 3 ? previewMutation.mutate() : setStep((value) => value + 1)} type="button">{step === 3 ? 'Preview audience' : 'Continue'}</button> : <><button className="secondary-button" onClick={() => saveMutation.mutate('draft')} type="button">Save draft</button>{scheduledFor ? <button className="secondary-button" onClick={() => saveMutation.mutate('scheduled')} type="button"><CalendarClock size={18} />Schedule</button> : null}<button className="primary-action" disabled={!preview} onClick={() => publishMutation.mutate()} type="button"><Send size={18} />Publish now</button></>}</div>
  </ModalDialog>
}

function BannerModal({ banner, onClose }: { banner?: AnnouncementBanner, onClose: () => void }) {
  const queryClient = useQueryClient()
  const [title, setTitle] = useState(banner?.title ?? '')
  const [message, setMessage] = useState(banner?.message ?? '')
  const [tone, setTone] = useState<AnnouncementBanner['tone']>(banner?.tone ?? 'info')
  const [audience, setAudience] = useState<AnnouncementBannerAudience>(banner?.audience ?? 'all')
  const [roles, setRoles] = useState<AppRole[]>(banner?.audienceRoles ?? [])
  const [expiresAt, setExpiresAt] = useState(toLocalInput(banner?.expiresAt))
  const mutation = useMutation({ mutationFn: (input: AnnouncementBannerMutationInput) => saveAnnouncementBanner(input), onSuccess: async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ['announcement-banner-manager'] }), queryClient.invalidateQueries({ queryKey: ['communications-workspace'] }), queryClient.invalidateQueries({ queryKey: ['active-announcement-banners'] })]); onClose() } })
  return <ModalDialog busy={mutation.isPending} busyLabel="Saving banner alert…" className="communications-modal communications-modal--banner" description="Set the message, audience, urgency, and expiration in one controlled alert." onClose={onClose} title={banner ? 'Edit banner alert' : 'New banner alert'}>
    <form className="communications-banner-editor" onSubmit={(event) => {
      event.preventDefault()
      mutation.mutate({ active: true, audience, audienceRoles: roles, bannerId: banner?.id, expiresAt: toIso(expiresAt), message, title, tone })
    }}>
      <section className="communications-banner-editor__section">
        <div className="communications-banner-editor__heading"><p className="eyebrow">Alert content</p><h3>What employees will see</h3><p>Use a short title and a clear, action-focused message.</p></div>
        <div className="communications-form-grid communications-form-grid--banner">
          <label className="span-2"><span>Title</span><input maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="Example: Schedule published" required value={title} /></label>
          <label className="span-2"><span>Message</span><textarea maxLength={420} onChange={(event) => setMessage(event.target.value)} placeholder="Write the complete notice employees need to read." required rows={5} value={message} /></label>
          <label><span>Tone</span><select onChange={(event) => setTone(event.target.value as AnnouncementBanner['tone'])} value={tone}><option value="info">Information</option><option value="success">Success</option><option value="warning">Warning</option><option value="urgent">Urgent</option></select><small>Controls the alert color and emphasis.</small></label>
          <label><span>Expires (optional)</span><input onChange={(event) => setExpiresAt(event.target.value)} type="datetime-local" value={expiresAt} /><small>The alert is removed automatically at this time.</small></label>
        </div>
      </section>
      <section className="communications-banner-editor__section">
        <div className="communications-banner-editor__heading"><p className="eyebrow">Visibility</p><h3>Choose the audience</h3><p>Only the selected employees will receive this alert.</p></div>
        <div className="communications-form-grid communications-form-grid--banner">
          <label className="span-2"><span>Audience</span><select onChange={(event) => setAudience(event.target.value as AnnouncementBannerAudience)} value={audience}><option value="all">Everyone</option><option value="supervisors">Supervisors and admins</option><option value="roles">Selected roles</option></select></label>
          {audience === 'roles' ? <fieldset className="communications-choice-panel span-2"><legend>Selected roles</legend><div className="communications-inline-choices">{ANNOUNCEMENT_BANNER_ROLE_OPTIONS.map(({ role, label }) => <label className="communications-check" key={role}><input checked={roles.includes(role)} onChange={() => setRoles((current) => current.includes(role) ? current.filter((entry) => entry !== role) : [...current, role])} type="checkbox" />{label}</label>)}</div></fieldset> : null}
        </div>
      </section>
      {mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}
      <div className="communications-modal__actions communications-banner-editor__actions"><button className="secondary-button" onClick={onClose} type="button">Cancel</button><button className="primary-action" type="submit">Save banner</button></div>
    </form>
  </ModalDialog>
}

function BannerLifecycleModal({ banner, action, onClose }: { banner: AnnouncementBanner, action: 'cancel' | 'delete', onClose: () => void }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => changeAnnouncementBannerLifecycle(banner.id, action),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['announcement-banner-manager'] }),
        queryClient.invalidateQueries({ queryKey: ['communications-workspace'] }),
        queryClient.invalidateQueries({ queryKey: ['active-announcement-banners'] }),
        queryClient.invalidateQueries({ queryKey: ['notification-center'] }),
      ])
      onClose()
    },
  })
  const isDelete = action === 'delete'
  return <ModalDialog busy={mutation.isPending} busyLabel={isDelete ? 'Removing alert…' : 'Canceling alert…'} className="communications-modal communications-modal--confirm" description={isDelete ? 'The alert will disappear from the manager while its audit history remains protected.' : 'Employees will stop seeing this alert immediately.'} onClose={onClose} title={isDelete ? 'Delete banner alert?' : 'Cancel banner alert?'}>
    <div className="communications-confirm-card"><span className={isDelete ? 'communications-confirm-card__icon communications-confirm-card__icon--danger' : 'communications-confirm-card__icon'}>{isDelete ? <Trash2 size={22} /> : <CircleStop size={22} />}</span><div><strong>{banner.title}</strong><p>{banner.message}</p></div></div>
    {mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}
    <div className="communications-modal__actions"><button className="secondary-button" onClick={onClose} type="button">Keep alert</button><button className={isDelete ? 'danger-button' : 'primary-action'} onClick={() => mutation.mutate()} type="button">{isDelete ? 'Delete alert' : 'Cancel alert'}</button></div>
  </ModalDialog>
}

function HistoryDetails({ item, onClose }: { item: AnnouncementHistoryItem, onClose: () => void }) {
  return <ModalDialog className="communications-modal communications-modal--details" onClose={onClose} title="Announcement details"><div className="communications-detail-grid"><article><span>Title</span><strong>{item.title}</strong></article><article><span>Published</span><strong>{formatOperationalDateTime(item.publishedAt, { includeTimeZoneName: true })}</strong></article><article><span>Recipients</span><strong>{item.recipientCount}</strong></article><article><span>Acknowledged</span><strong>{item.acknowledgedCount}</strong></article></div><div className="communications-message-copy">{item.body}</div><div className="communications-modal__actions"><button className="secondary-button" onClick={onClose} type="button">Close</button></div></ModalDialog>
}

function BannerAlertRow({ banner, archived = false, onEdit, onLifecycle }: { banner: AnnouncementBanner, archived?: boolean, onEdit: (banner: AnnouncementBanner) => void, onLifecycle: (banner: AnnouncementBanner, action: 'cancel' | 'delete') => void }) {
  return <article className="communications-list__row communications-list__row--banner">
    <div className="communications-banner-row__message"><strong>{banner.title}</strong><span>{banner.message}</span></div>
    <span className={bannerStatusClass(banner.lifecycleStatus)}>{titleCase(banner.lifecycleStatus)}</span>
    <div className="communications-banner-row__timing"><span>{banner.lifecycleStatus === 'scheduled' ? 'Starts' : 'Expires'}</span><strong>{banner.lifecycleStatus === 'scheduled' ? formatOperationalDateTime(banner.startsAt) : banner.expiresAt ? formatOperationalDateTime(banner.expiresAt) : 'No expiration'}</strong></div>
    <div className="communications-banner-row__actions">
      {!archived ? <><button className="secondary-button" onClick={() => onEdit(banner)} type="button">Edit</button><button className="secondary-button communications-cancel-button" onClick={() => onLifecycle(banner, 'cancel')} type="button"><CircleStop size={17} />Cancel</button></> : null}
      <button aria-label={`Delete ${banner.title}`} className="icon-button communications-delete-button" onClick={() => onLifecycle(banner, 'delete')} title="Delete alert" type="button"><Trash2 size={18} /></button>
    </div>
  </article>
}

export function AnnouncementsPage() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<WorkspaceTab>('overview')
  const [composerItem, setComposerItem] = useState<AnnouncementWorkItem | 'new' | null>(null)
  const [bannerItem, setBannerItem] = useState<AnnouncementBanner | 'new' | null>(null)
  const [bannerLifecycle, setBannerLifecycle] = useState<{ banner: AnnouncementBanner, action: 'cancel' | 'delete' } | null>(null)
  const [showArchivedBanners, setShowArchivedBanners] = useState(false)
  const [historyItem, setHistoryItem] = useState<AnnouncementHistoryItem | null>(null)
  const [status, setStatus] = useState<WorkStatus>('all'); const [workSearch, setWorkSearch] = useState(''); const [workPage, setWorkPage] = useState(1); const [workPageSize, setWorkPageSize] = useState<5 | 10 | 20>(5)
  const [historySearch, setHistorySearch] = useState(''); const [historyPage, setHistoryPage] = useState(1); const [historyPageSize, setHistoryPageSize] = useState<5 | 10 | 20>(10)
  const workspaceQuery = useQuery({ queryKey: ['communications-workspace'], queryFn: getCommunicationWorkspace, enabled: isSupabaseConfigured })
  const workspace = workspaceQuery.data
  const workQuery = useQuery({ queryKey: ['announcement-work-items', workPage, workPageSize, workSearch, status], queryFn: () => getAnnouncementWorkItems({ page: workPage, pageSize: workPageSize, search: workSearch, status }), enabled: Boolean(workspace?.permissions.canSend) })
  const historyQuery = useQuery({ queryKey: ['announcement-history', historyPage, historyPageSize, historySearch], queryFn: () => getAnnouncementHistory({ page: historyPage, pageSize: historyPageSize, search: historySearch }), enabled: Boolean(workspace) })
  const bannersQuery = useQuery({ queryKey: ['announcement-banner-manager'], queryFn: getAnnouncementBannerManager, enabled: Boolean(workspace?.permissions.canManageBanners && workspace.permissions.hasMfa) })
  const cancelMutation = useMutation({ mutationFn: cancelAnnouncementWorkItem, onSuccess: async () => Promise.all([queryClient.invalidateQueries({ queryKey: ['announcement-work-items'] }), queryClient.invalidateQueries({ queryKey: ['communications-workspace'] })]) })
  const updateFilter = (callback: () => void, target: 'work' | 'history') => {
    callback()
    if (target === 'work') setWorkPage(1)
    else setHistoryPage(1)
  }
  const statusClass = (value: string) => value === 'failed' ? 'status-badge status-badge--separated' : value === 'scheduled' ? 'status-badge status-badge--leave' : 'status-badge status-badge--active'
  return <div className="page page--announcements communications-workspace"><section className="page-intro communications-hero"><div><p className="eyebrow">Communication Center</p><h1>Announcements</h1><p className="page-summary">Create approved messages, target the right employees, and review delivery without long operational lists.</p></div><div className="communications-hero__actions">{workspace?.permissions.canManageBanners ? <button className="secondary-button" onClick={() => setBannerItem('new')} type="button"><BellRing size={18} />New banner alert</button> : null}{workspace?.permissions.canSend ? <button className="primary-action" onClick={() => setComposerItem('new')} type="button"><Plus size={19} />New announcement</button> : null}</div></section>
    {!isSupabaseConfigured ? <DataStatePanel icon={DatabaseZap} title="Communication tools need the secure connection" tone="setup"><p>Connect the protected data service before managing announcements.</p></DataStatePanel> : workspaceQuery.isPending ? <DataStatePanel icon={Megaphone} title="Loading communication center"><p>Getting approved templates, active messages, and work in progress.</p></DataStatePanel> : workspaceQuery.isError ? <DataStatePanel icon={ShieldAlert} title="Announcements unavailable" tone="error"><p>{workspaceQuery.error.message}</p></DataStatePanel> : workspace ? <>
      {!workspace.permissions.hasMfa && (workspace.permissions.canSend || workspace.permissions.canManageBanners) ? <div className="inline-alert" role="alert">MFA is required before publishing announcements or changing banner alerts.</div> : null}
      <section className="communications-summary"><article><span>Active messages</span><strong>{workspace.overview.active.length}</strong><small>Currently visible</small></article><article><span>Drafts & scheduled</span><strong>{workspace.summary.draftsScheduled}</strong><small>Work in progress</small></article><article className={workspace.summary.awaitingAcknowledgment ? 'communications-summary--attention' : ''}><span>Awaiting acknowledgment</span><strong>{workspace.summary.awaitingAcknowledgment}</strong><small>Employee receipts pending</small></article></section>
      <nav className="communications-tabs" aria-label="Announcement views"><button className={tab === 'overview' ? 'is-active' : ''} onClick={() => setTab('overview')} type="button">Overview</button><button className={tab === 'banners' ? 'is-active' : ''} onClick={() => setTab('banners')} type="button">Banner Alerts</button><button className={tab === 'history' ? 'is-active' : ''} onClick={() => setTab('history')} type="button">History & Acknowledgments</button></nav>
      {tab === 'overview' ? <div className="communications-overview-grid"><section className="operations-panel communications-panel"><div className="section-heading"><div><p className="eyebrow">Working Items</p><h2>Drafts and scheduled messages</h2><p>Five items at a time by default. Increase only when needed.</p></div></div><div className="communications-filters communications-filters--compact"><label className="communications-search"><span>Search</span><div><Search size={18} /><input onChange={(event) => updateFilter(() => setWorkSearch(event.target.value), 'work')} placeholder="Template or status" value={workSearch} /></div></label><label><span>Status</span><select onChange={(event) => updateFilter(() => setStatus(event.target.value as WorkStatus), 'work')} value={status}><option value="all">All</option><option value="draft">Draft</option><option value="scheduled">Scheduled</option><option value="failed">Failed</option></select></label></div>{workQuery.isError ? <div className="inline-alert">{workQuery.error.message}</div> : workQuery.data?.items.length ? <div className="communications-list">{workQuery.data.items.map((item) => <article className="communications-list__row communications-list__row--work" key={item.id}><div><strong>{item.templateName}</strong><span>Updated {formatOperationalDateTime(item.updatedAt)}</span></div><span className={statusClass(item.status)}>{titleCase(item.status)}</span><div><span>Audience</span><strong>{titleCase(item.audienceMode)}</strong></div><button className="secondary-button" onClick={() => setComposerItem(item)} type="button">Open</button>{item.status !== 'canceled' ? <button aria-label={`Cancel ${item.templateName}`} className="icon-button" disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate(item.id)} type="button"><XCircle size={18} /></button> : null}</article>)}</div> : <p className="empty-note">No work items match these filters.</p>}<Pagination page={workQuery.data?.page.number ?? workPage} pageSize={workPageSize} total={workQuery.data?.page.total ?? 0} totalPages={workQuery.data?.page.totalPages ?? 1} onPage={setWorkPage} onPageSize={setWorkPageSize} /></section><aside className="communications-overview-side"><MiniList title="Active now" items={workspace.overview.active.slice(0, 3).map((entry) => ({ id: entry.id, primary: entry.title, secondary: entry.expiresAt ? `Until ${formatOperationalDateTime(entry.expiresAt)}` : 'No expiration' }))} /><MiniList title="Recently published" items={workspace.overview.recent.slice(0, 3).map((entry) => ({ id: entry.id, primary: entry.title, secondary: formatOperationalDateTime(entry.publishedAt) }))} /></aside></div> : null}
      {tab === 'banners' ? <div className="communications-banner-workspace">
        <section className="operations-panel communications-panel">
          <div className="section-heading"><div><p className="eyebrow">Workspace Alerts</p><h2>Current & scheduled alerts</h2><p>Only alerts that are visible now or scheduled for later appear here.</p></div>{workspace.permissions.canManageBanners ? <button className="primary-action" onClick={() => setBannerItem('new')} type="button"><Plus size={18} />New banner</button> : null}</div>
          {bannersQuery.isError ? <div className="inline-alert">{bannersQuery.error.message}</div> : bannersQuery.data?.banners.length ? <div className="communications-list">{bannersQuery.data.banners.map((banner) => <BannerAlertRow banner={banner} key={banner.id} onEdit={setBannerItem} onLifecycle={(target, action) => setBannerLifecycle({ banner: target, action })} />)}</div> : <div className="communications-empty-state"><BellRing size={24} /><strong>No current banner alerts</strong><span>Create one when employees need a short, visible notice.</span></div>}
        </section>
        <section className="operations-panel communications-panel communications-panel--archive">
          <div className="section-heading"><div><p className="eyebrow">Alert Archive</p><h2>Past & canceled alerts</h2><p>Expired and canceled notices stay available for review without appearing to employees.</p></div></div>
          {bannersQuery.data?.archivedBanners.length ? <><div className="communications-list">{bannersQuery.data.archivedBanners.slice(0, showArchivedBanners ? 10 : 5).map((banner) => <BannerAlertRow archived banner={banner} key={banner.id} onEdit={setBannerItem} onLifecycle={(target, action) => setBannerLifecycle({ banner: target, action })} />)}</div>{bannersQuery.data.archivedBanners.length > 5 ? <div className="communications-compact-toggle"><span>Showing {showArchivedBanners ? Math.min(10, bannersQuery.data.archivedBanners.length) : 5} of {bannersQuery.data.archivedBanners.length}</span><button className="secondary-button" onClick={() => setShowArchivedBanners((current) => !current)} type="button">{showArchivedBanners ? 'Show fewer' : 'View more'}</button></div> : null}</> : <p className="empty-note">No past or canceled banner alerts.</p>}
        </section>
      </div> : null}
      {tab === 'history' ? <section className="operations-panel communications-panel"><div className="section-heading"><div><p className="eyebrow">Audit History</p><h2>Published communications</h2><p>Recipient and acknowledgment totals stay grouped by announcement.</p></div></div><div className="communications-filters communications-filters--compact"><label className="communications-search"><span>Search history</span><div><Search size={18} /><input onChange={(event) => updateFilter(() => setHistorySearch(event.target.value), 'history')} placeholder="Title or message" value={historySearch} /></div></label></div>{historyQuery.isError ? <div className="inline-alert">{historyQuery.error.message}</div> : historyQuery.data?.items.length ? <div className="communications-list">{historyQuery.data.items.map((item) => <article className="communications-list__row" key={item.id}><div><strong>{item.title}</strong><span>{formatOperationalDateTime(item.publishedAt, { includeTimeZoneName: true })}</span></div><div><span>Recipients</span><strong>{item.recipientCount}</strong></div><div><span>Acknowledged</span><strong>{item.acknowledgedCount} / {item.recipientCount}</strong></div><button className="secondary-button" onClick={() => setHistoryItem(item)} type="button">View details</button></article>)}</div> : <p className="empty-note">No published announcements match this search.</p>}<Pagination page={historyQuery.data?.page.number ?? historyPage} pageSize={historyPageSize} total={historyQuery.data?.page.total ?? 0} totalPages={historyQuery.data?.page.totalPages ?? 1} onPage={setHistoryPage} onPageSize={setHistoryPageSize} /></section> : null}
    </> : null}
    {composerItem && workspace ? <ComposerModal item={composerItem === 'new' ? undefined : composerItem} onClose={() => setComposerItem(null)} workspace={workspace} /> : null}{bannerItem ? <BannerModal banner={bannerItem === 'new' ? undefined : bannerItem} onClose={() => setBannerItem(null)} /> : null}{bannerLifecycle ? <BannerLifecycleModal action={bannerLifecycle.action} banner={bannerLifecycle.banner} onClose={() => setBannerLifecycle(null)} /> : null}{historyItem ? <HistoryDetails item={historyItem} onClose={() => setHistoryItem(null)} /> : null}
  </div>
}

function MiniList({ title, items }: { title: string, items: Array<{ id: string, primary: string, secondary: string }> }) {
  return <section className="operations-panel communications-panel"><div className="section-heading"><div><h2>{title}</h2></div></div>{items.length ? <div className="communications-mini-list">{items.map((item) => <article key={item.id}><strong>{item.primary}</strong><span>{item.secondary}</span></article>)}</div> : <p className="empty-note">Nothing to show.</p>}</section>
}

function Pagination({ page, pageSize, total, totalPages, onPage, onPageSize }: { page: number, pageSize: 5 | 10 | 20, total: number, totalPages: number, onPage: (page: number) => void, onPageSize: (size: 5 | 10 | 20) => void }) {
  return <div className="communications-pagination"><span>Page {page} of {totalPages} · {total} items</span><label><span>Rows</span><select onChange={(event) => { onPageSize(Number(event.target.value) as 5 | 10 | 20); onPage(1) }} value={pageSize}>{pageSizeOptions.map((size) => <option key={size} value={size}>{size}</option>)}</select></label><button className="secondary-button" disabled={page <= 1} onClick={() => onPage(page - 1)} type="button">Previous</button><button className="secondary-button" disabled={page >= totalPages} onClick={() => onPage(page + 1)} type="button">Next</button></div>
}
