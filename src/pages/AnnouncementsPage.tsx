import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, DatabaseZap, Edit3, Eye, Megaphone, Plus, Send, ShieldAlert } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  ANNOUNCEMENT_BANNER_ROLE_OPTIONS,
  bannerAudienceLabel,
  emptyFields,
  getAnnouncementBannerManager,
  getAnnouncementComposer,
  previewAnnouncementTemplate,
  publishTemplatedAnnouncement,
  reviseTemplatedAnnouncement,
  recipientSummary,
  saveAnnouncementBanner,
  type AnnouncementField,
  type AnnouncementBanner,
  type AnnouncementBannerAudience,
  type AnnouncementBannerMutationInput,
  type AnnouncementBannerManager,
  type AnnouncementPreview,
  type AnnouncementTemplate,
  type RecentAnnouncement,
} from '../data/announcements'
import { processNotificationBatch } from '../data/operations'
import { isSupabaseConfigured } from '../lib/supabase'

function kindLabel(kind: AnnouncementTemplate['kind']): string {
  return kind.replace('_', ' ')
}

function toDateTimeLocal(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return adjusted.toISOString().slice(0, 16)
}

function fromDateTimeLocal(value: string): string | null {
  return value ? new Date(value).toISOString() : null
}

function defaultAnnouncementExpirationLocal(): string {
  const date = new Date()
  date.setDate(date.getDate() + 14)
  date.setHours(23, 59, 0, 0)
  return toDateTimeLocal(date.toISOString())
}

function bannerFormPayload(form: HTMLFormElement, bannerId?: string): AnnouncementBannerMutationInput {
  const data = new FormData(form)
  const value = (key: string) => String(data.get(key) ?? '').trim()
  return {
    active: data.get('active') === 'on',
    audience: value('audience') as AnnouncementBannerAudience,
    audienceRoles: value('audience') === 'roles'
      ? data.getAll('audienceRoles').map((role) => String(role)) as AnnouncementBannerMutationInput['audienceRoles']
      : [],
    bannerId,
    ctaHref: value('ctaHref') || null,
    ctaLabel: value('ctaLabel') || null,
    expiresAt: fromDateTimeLocal(value('expiresAt')),
    message: value('message'),
    startsAt: fromDateTimeLocal(value('startsAt')),
    title: value('title'),
    tone: value('tone') as AnnouncementBanner['tone'],
  }
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: AnnouncementField
  value: string
  onChange: (value: string) => void
}) {
  if (field.type === 'textarea') {
    return (
      <textarea
        id={`announcement-${field.key}`}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder}
        rows={4}
        value={value}
      />
    )
  }

  if (field.type === 'select') {
    return (
      <select id={`announcement-${field.key}`} onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">Choose one</option>
        {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    )
  }

  return (
    <input
      id={`announcement-${field.key}`}
      min={field.type === 'number' ? 1 : undefined}
      onChange={(event) => onChange(event.target.value)}
      placeholder={field.placeholder}
      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
      value={value}
    />
  )
}

function PreviewCard({ preview }: { preview: AnnouncementPreview | null }) {
  if (!preview) {
    return (
      <div className="announcement-preview announcement-preview--empty">
        <Eye aria-hidden="true" size={24} />
        <h2>Preview before sending</h2>
        <p>Complete the form and preview the approved message before it can be published.</p>
      </div>
    )
  }

  return (
    <article className="announcement-preview">
      <p className="eyebrow">Email preview</p>
      <h2>{preview.title}</h2>
      <p className="announcement-recipient-count">
        Sends to {recipientSummary(preview)}
      </p>
      <div className="announcement-email-shell" aria-label="Branded email layout preview">
        <div className="announcement-email-shell__header">
          <img alt="SygShift" src="/brand/sygshift-email-logo.png" />
          <span>Smart schedules. Stronger coverage.</span>
        </div>
        <div className="announcement-email-shell__body">
          <span>SygShift notification</span>
          <h3>{preview.title}</h3>
          {preview.body.split(/\n{2,}/).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          <button className="email-preview-button" type="button">Open SygShift</button>
        </div>
      </div>
    </article>
  )
}

function BannerPreview({ banner }: { banner: AnnouncementBanner | null }) {
  if (!banner) {
    return (
      <div className="announcement-banner-preview announcement-banner-preview--empty">
        <Megaphone aria-hidden="true" size={22} />
        <strong>No active banner</strong>
        <span>Create a banner to show a short message across the signed-in workspace.</span>
      </div>
    )
  }

  return (
    <article className={`announcement-banner-preview announcement-banner-preview--${banner.tone}`}>
      <Megaphone aria-hidden="true" size={22} />
      <div>
        <strong>{banner.title}</strong>
        <span>{banner.message}</span>
        {banner.ctaLabel && banner.ctaHref ? <small>{banner.ctaLabel} {'->'} {banner.ctaHref}</small> : null}
        <small>Audience: {bannerAudienceLabel(banner)}</small>
      </div>
    </article>
  )
}

function BannerEditorModal({
  banner,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  banner?: AnnouncementBanner
  busy: boolean
  error: Error | null
  onClose: () => void
  onSubmit: (payload: AnnouncementBannerMutationInput) => void
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSubmit(bannerFormPayload(event.currentTarget, banner?.id))
  }
  const [audience, setAudience] = useState<AnnouncementBannerAudience>(banner?.audience ?? 'all')

  return (
    <ModalDialog
      busy={busy}
      busyLabel="Saving announcement banner..."
      className="modal-dialog--announcement-banner"
      description="This banner appears near the top of the signed-in workspace while active."
      onClose={onClose}
      title={banner ? 'Edit announcement banner' : 'Create announcement banner'}
    >
      <form className="announcement-form announcement-banner-form" onSubmit={submit}>
        <label className="form-field">
          <span>Title</span>
          <input defaultValue={banner?.title ?? ''} maxLength={120} name="title" required />
        </label>
        <label className="form-field">
          <span>Tone</span>
          <select defaultValue={banner?.tone ?? 'info'} name="tone">
            <option value="info">Info</option>
            <option value="success">Success</option>
            <option value="warning">Warning</option>
            <option value="urgent">Urgent</option>
          </select>
        </label>
        <label className="form-field">
          <span>Audience</span>
          <select
            name="audience"
            onChange={(event) => setAudience(event.target.value as AnnouncementBannerAudience)}
            value={audience}
          >
            <option value="all">Everyone</option>
            <option value="supervisors">Finance / supervisors & admins</option>
            <option value="roles">Choose roles</option>
          </select>
        </label>
        <label className="form-field form-field--wide">
          <span>Message</span>
          <textarea defaultValue={banner?.message ?? ''} maxLength={420} name="message" required rows={4} />
        </label>
        {audience === 'roles' ? (
          <fieldset className="announcement-banner-audience">
            <legend>Roles</legend>
            {ANNOUNCEMENT_BANNER_ROLE_OPTIONS.map((option) => (
              <label className="check-field" key={option.role}>
                <input
                  defaultChecked={banner?.audienceRoles.includes(option.role) ?? false}
                  name="audienceRoles"
                  type="checkbox"
                  value={option.role}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
        ) : null}
        <label className="form-field">
          <span>Action label</span>
          <input defaultValue={banner?.ctaLabel ?? ''} maxLength={48} name="ctaLabel" placeholder="Optional" />
        </label>
        <label className="form-field">
          <span>Action link</span>
          <input defaultValue={banner?.ctaHref ?? ''} name="ctaHref" placeholder="/schedule" />
        </label>
        <label className="form-field">
          <span>Starts</span>
          <input defaultValue={toDateTimeLocal(banner?.startsAt)} name="startsAt" type="datetime-local" />
        </label>
        <label className="form-field">
          <span>Expires</span>
          <input defaultValue={toDateTimeLocal(banner?.expiresAt)} name="expiresAt" type="datetime-local" />
        </label>
        <label className="check-field announcement-banner-form__active">
          <input defaultChecked={banner?.active ?? true} name="active" type="checkbox" />
          Active banner
        </label>
        {error ? <div className="inline-alert" role="alert">{error.message}</div> : null}
        <div className="announcement-actions">
          <button className="secondary-button" onClick={onClose} type="button">Cancel</button>
          <button className="primary-action" disabled={busy} type="submit">{busy ? 'Saving...' : 'Save banner'}</button>
        </div>
      </form>
    </ModalDialog>
  )
}

function BannerManagementPanel({
  bannerManager,
  canManage,
  hasMfa,
  loading,
  onCreate,
  onEdit,
}: {
  bannerManager?: AnnouncementBannerManager
  canManage: boolean
  hasMfa: boolean
  loading: boolean
  onCreate: () => void
  onEdit: (banner: AnnouncementBanner) => void
}) {
  const activeBanner = bannerManager?.activeBanner ?? null
  const activeBanners = bannerManager?.activeBanners.length ? bannerManager.activeBanners : activeBanner ? [activeBanner] : []

  return (
    <section className="panel announcement-banner-panel" aria-labelledby="announcement-banner-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Announcement banner</p>
          <h2 id="announcement-banner-title">Workspace alert lane</h2>
        </div>
        {canManage && hasMfa ? (
          <button className="primary-action" onClick={onCreate} type="button">
            <Plus aria-hidden="true" size={18} />
            New alert
          </button>
        ) : null}
      </div>

      {!canManage ? (
        <p className="empty-note">Banner editing is controlled by the announcement banner permission.</p>
      ) : !hasMfa ? (
        <div className="inline-alert" role="alert">MFA is required before editing the announcement banner.</div>
      ) : loading ? (
        <p className="empty-note">Loading banner controls.</p>
      ) : (
        <>
          {activeBanners.length ? (
            <div className="announcement-banner-preview-list">
              {activeBanners.map((banner) => <BannerPreview banner={banner} key={banner.id} />)}
            </div>
          ) : (
            <BannerPreview banner={null} />
          )}
          <div className="announcement-banner-list">
            {bannerManager?.banners.length ? bannerManager.banners.map((banner) => (
              <article key={banner.id}>
                <div>
                  <strong>{banner.title}</strong>
                  <span>{banner.active ? 'Active' : 'Inactive'} - {bannerAudienceLabel(banner)} - {new Date(banner.startsAt).toLocaleString()}</span>
                </div>
                <button className="secondary-button secondary-button--small" onClick={() => onEdit(banner)} type="button">
                  <Edit3 aria-hidden="true" size={16} />
                  Edit
                </button>
              </article>
            )) : (
              <p className="empty-note">No banners have been created yet.</p>
            )}
          </div>
        </>
      )}
    </section>
  )
}

export function AnnouncementsPage() {
  const queryClient = useQueryClient()
  const composerQuery = useQuery({
    queryKey: ['announcement-composer'],
    queryFn: getAnnouncementComposer,
    enabled: isSupabaseConfigured,
  })
  const templates = useMemo(() => composerQuery.data?.templates ?? [], [composerQuery.data?.templates])
  const [selectedKey, setSelectedKey] = useState('')
  const selectedTemplate = useMemo(
    () => templates.find((template) => template.key === selectedKey) ?? templates[0],
    [selectedKey, templates],
  )
  const [fields, setFields] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<AnnouncementPreview | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [bannerEditor, setBannerEditor] = useState<AnnouncementBanner | 'new' | null>(null)
  const [announcementExpiresAt, setAnnouncementExpiresAt] = useState(() => defaultAnnouncementExpirationLocal())
  const [requiresAcknowledgment, setRequiresAcknowledgment] = useState(false)
  const [acknowledgmentDueAt, setAcknowledgmentDueAt] = useState(() => defaultAnnouncementExpirationLocal())
  const [revisionSource, setRevisionSource] = useState<RecentAnnouncement | null>(null)
  const hasMfa = Boolean(composerQuery.data?.hasMfa)
  const canSend = Boolean(composerQuery.data?.canSend)
  const canManageBanner = Boolean(composerQuery.data?.canManageBanner)

  const bannerManagerQuery = useQuery({
    enabled: isSupabaseConfigured && canManageBanner && hasMfa,
    queryFn: getAnnouncementBannerManager,
    queryKey: ['announcement-banner-manager'],
  })

  useEffect(() => {
    if (templates.length > 0 && !selectedKey) {
      setSelectedKey(templates[0].key)
    }
  }, [selectedKey, templates])

  useEffect(() => {
    if (selectedTemplate) {
      const revisingThisTemplate = revisionSource?.templateKey === selectedTemplate.key
      setFields(revisingThisTemplate
        ? Object.fromEntries(Object.entries(revisionSource.templateFields ?? {}).map(([key, value]) => [key, String(value ?? '')]))
        : emptyFields(selectedTemplate))
      setPreview(null)
      setAnnouncementExpiresAt(revisingThisTemplate ? toDateTimeLocal(revisionSource.expiresAt) : defaultAnnouncementExpirationLocal())
      setRequiresAcknowledgment(revisingThisTemplate ? revisionSource.acknowledgmentMode === 'required' : false)
      setAcknowledgmentDueAt(revisingThisTemplate ? toDateTimeLocal(revisionSource.acknowledgmentDueAt) : defaultAnnouncementExpirationLocal())
    }
  }, [revisionSource, selectedTemplate])

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTemplate) throw new Error('Choose an approved template first.')
      return previewAnnouncementTemplate(selectedTemplate.key, fields)
    },
    onSuccess: (result) => {
      setPreview(result)
      setMessage(null)
    },
  })

  const publishMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTemplate) throw new Error('Choose an approved template first.')
      if (revisionSource) {
        return reviseTemplatedAnnouncement(revisionSource.id, fields, {
          dueAt: fromDateTimeLocal(acknowledgmentDueAt),
          expiresAt: fromDateTimeLocal(announcementExpiresAt),
          required: requiresAcknowledgment,
        })
      }
      const result = await publishTemplatedAnnouncement(selectedTemplate.key, fields, {
        dueAt: fromDateTimeLocal(acknowledgmentDueAt),
        expiresAt: fromDateTimeLocal(announcementExpiresAt),
        required: requiresAcknowledgment,
      })
      return result
    },
    onSuccess: async (result) => {
      setPreview(result)
      const publishedMessage = `Published version ${result.contentVersion} of "${result.title}" to ${recipientSummary(result)}.`

      try {
        const delivery = await processNotificationBatch()
        const deliveredCount = delivery.delivered.length
        const failedCount = delivery.failed.length
        const deliveryMessage = delivery.processed === 0
          ? 'No queued emails were waiting to send.'
          : `Email delivery processed ${delivery.processed} queued message${delivery.processed === 1 ? '' : 's'} (${deliveredCount} delivered, ${failedCount} failed).`

        setMessage(`${publishedMessage} ${deliveryMessage}`)
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Queued email delivery could not be started.'
        setMessage(`${publishedMessage} Email delivery is queued, but sending needs attention: ${detail}`)
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['announcement-composer'] }),
        queryClient.invalidateQueries({ queryKey: ['notification-center'] }),
      ])
      setRevisionSource(null)
    },
  })

  const bannerMutation = useMutation({
    mutationFn: saveAnnouncementBanner,
    onSuccess: async (result) => {
      queryClient.setQueryData(['announcement-banner-manager'], result)
      setBannerEditor(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['active-announcement-banner'] }),
        queryClient.invalidateQueries({ queryKey: ['active-announcement-banners'] }),
        queryClient.invalidateQueries({ queryKey: ['announcement-banner-manager'], refetchType: 'active' }),
        queryClient.invalidateQueries({ queryKey: ['announcement-composer'], refetchType: 'active' }),
      ])
    },
  })

  const canPublish = Boolean(preview && hasMfa && canSend && !previewMutation.isPending && !publishMutation.isPending)
  const canPreview = Boolean(canSend && selectedTemplate && !previewMutation.isPending)

  return (
    <div className="page page--workforce">
      <section className="page-intro workforce-intro">
        <div>
          <p className="eyebrow">Communication</p>
          <h1>Announcements</h1>
          <p className="page-summary">
            Supervisors choose an approved message, fill in the details, preview the branded email,
            and publish only to the right qualified employees.
          </p>
        </div>
      </section>

      {!isSupabaseConfigured ? (
        <DataStatePanel icon={DatabaseZap} title="Announcement templates need the secure connection" tone="setup">
          <p>Approved templates, recipient counts, and send history appear after Supabase is connected.</p>
        </DataStatePanel>
      ) : composerQuery.isPending ? (
        <DataStatePanel icon={Megaphone} title="Loading approved templates">
          <p>Getting the current company-approved communication templates.</p>
        </DataStatePanel>
      ) : composerQuery.isError ? (
        <DataStatePanel icon={ShieldAlert} title="Announcements unavailable" tone="error">
          <p>{composerQuery.error.message}</p>
        </DataStatePanel>
      ) : (
        <>
        {(canSend || canManageBanner) && !hasMfa ? (
          <div className="inline-alert" role="alert">
            MFA is required before sending announcements or editing the workspace banner.
          </div>
        ) : null}

        <BannerManagementPanel
          bannerManager={bannerManagerQuery.data}
          canManage={canManageBanner}
          hasMfa={hasMfa}
          loading={bannerManagerQuery.isPending}
          onCreate={() => setBannerEditor('new')}
          onEdit={(banner) => setBannerEditor(banner)}
        />

        {bannerManagerQuery.isError ? (
          <div className="inline-alert" role="alert">{bannerManagerQuery.error.message}</div>
        ) : null}

        <div className={canSend ? 'announcement-workspace' : 'announcement-workspace announcement-workspace--history-only'}>
          {canSend ? (
          <section className="panel announcement-template-panel" aria-label="Approved templates">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Approved templates</p>
                <h2>Choose the message type</h2>
              </div>
            </div>
            <div className="announcement-template-list">
              {templates.map((template) => (
                <button
                  className={template.key === selectedTemplate?.key ? 'announcement-template-card is-selected' : 'announcement-template-card'}
                  key={template.key}
                  onClick={() => {
                    setRevisionSource(null)
                    setMessage(null)
                    setSelectedKey(template.key)
                  }}
                  type="button"
                >
                  <span>{kindLabel(template.kind)}</span>
                  <strong>{template.name}</strong>
                  <small>{template.description}</small>
                </button>
              ))}
            </div>
          </section>
          ) : null}

          {canSend && selectedTemplate ? (
            <section className="panel announcement-compose-panel" aria-label="Announcement details">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Fill in the details</p>
                  <h2>{revisionSource ? `Revise ${selectedTemplate.name}` : selectedTemplate.name}</h2>
                  {revisionSource ? <p>Publishing creates version {revisionSource.contentVersion + 1}; the prior receipt history is preserved.</p> : null}
                </div>
              </div>
              <form
                className="announcement-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  previewMutation.mutate()
                }}
              >
                {selectedTemplate.requiredFields.map((field) => (
                  <label className={field.type === 'textarea' ? 'form-field form-field--wide' : 'form-field'} key={field.key}>
                    <span>{field.label}</span>
                    <FieldInput
                      field={field}
                      onChange={(value) => {
                        setFields((current) => ({ ...current, [field.key]: value }))
                        setPreview(null)
                        setMessage(null)
                      }}
                      value={fields[field.key] ?? ''}
                    />
                  </label>
                ))}
                <section className="announcement-delivery-card" aria-label="Announcement visibility">
                  <div>
                    <p className="eyebrow">Employee visibility</p>
                    <strong>Show on the workspace banner and employee Home until this date.</strong>
                    <span>
                      Email sends immediately. The banner/front-page card expires automatically so guards do not see stale posts.
                    </span>
                  </div>
                  <label className="form-field">
                    <span>Visible until</span>
                    <input
                      min={toDateTimeLocal(new Date().toISOString())}
                      onChange={(event) => {
                        setAnnouncementExpiresAt(event.target.value)
                        setPreview(null)
                        setMessage(null)
                      }}
                      required
                      type="datetime-local"
                      value={announcementExpiresAt}
                    />
                  </label>
                </section>
                <section className="announcement-delivery-card" aria-label="Acknowledgment requirement">
                  <div>
                    <p className="eyebrow">Employee response</p>
                    <strong>{requiresAcknowledgment ? 'Required acknowledgment' : 'Informational only'}</strong>
                    <span>
                      Required acknowledgment records receipt and review. It is not an electronic signature or legal agreement.
                    </span>
                  </div>
                  <div className="announcement-ack-controls">
                    <label className="check-field">
                      <input
                        checked={requiresAcknowledgment}
                        onChange={(event) => {
                          setRequiresAcknowledgment(event.target.checked)
                          setPreview(null)
                          setMessage(null)
                        }}
                        type="checkbox"
                      />
                      Require acknowledgment
                    </label>
                    {requiresAcknowledgment ? (
                      <label className="form-field">
                        <span>Acknowledge by</span>
                        <input
                          min={toDateTimeLocal(new Date().toISOString())}
                          onChange={(event) => setAcknowledgmentDueAt(event.target.value)}
                          required
                          type="datetime-local"
                          value={acknowledgmentDueAt}
                        />
                      </label>
                    ) : null}
                  </div>
                </section>

                {previewMutation.isError ? <div className="inline-alert" role="alert">{previewMutation.error.message}</div> : null}
                {publishMutation.isError ? <div className="inline-alert" role="alert">{publishMutation.error.message}</div> : null}
                {message ? <div className="form-feedback form-feedback--success" role="status">{message}</div> : null}

                <div className="announcement-actions">
                  <button className="secondary-button" disabled={!canPreview} type="submit">
                    <Eye aria-hidden="true" size={18} />
                    {previewMutation.isPending ? 'Previewing...' : 'Preview message'}
                  </button>
                  <button
                    className="primary-action"
                    disabled={!canPublish}
                    onClick={() => publishMutation.mutate()}
                    type="button"
                  >
                    <Send aria-hidden="true" size={18} />
                    {publishMutation.isPending ? 'Publishing...' : revisionSource ? 'Publish revised version' : 'Publish approved message'}
                  </button>
                </div>
              </form>
            </section>
          ) : null}

          {canSend ? <PreviewCard preview={preview} /> : null}

          <section className="panel announcement-history-panel" aria-label="Recent announcements">
            <div className="section-heading">
              <div>
                <p className="eyebrow">History</p>
                <h2>Recent published messages</h2>
              </div>
            </div>
            {composerQuery.data.recentAnnouncements.length === 0 ? (
              <p className="empty-note">No announcements have been published yet.</p>
            ) : (
              <div className="announcement-history-list">
                {composerQuery.data.recentAnnouncements.map((announcement) => (
                  <article key={announcement.id}>
                    <BellRing aria-hidden="true" size={18} />
                    <div>
                      <strong>{announcement.title}</strong>
                      <span>
                        {kindLabel(announcement.kind)} · version {announcement.contentVersion} by {announcement.createdBy}
                        {announcement.requiresArmed ? ' · armed-qualified recipients only' : ''}
                      </span>
                    </div>
                    {canSend && announcement.templateKey ? (
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setMessage(null)
                          setRevisionSource(announcement)
                          setSelectedKey(announcement.templateKey ?? '')
                          window.scrollTo({ behavior: 'smooth', top: 0 })
                        }}
                        type="button"
                      >
                        <Edit3 aria-hidden="true" size={16} />
                        Revise
                      </button>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
        {bannerEditor ? (
          <BannerEditorModal
            banner={bannerEditor === 'new' ? undefined : bannerEditor}
            busy={bannerMutation.isPending}
            error={bannerMutation.isError ? bannerMutation.error : null}
            onClose={() => setBannerEditor(null)}
            onSubmit={(payload) => bannerMutation.mutate(payload)}
          />
        ) : null}
        </>
      )}
    </div>
  )
}
