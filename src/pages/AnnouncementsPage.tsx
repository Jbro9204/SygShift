import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, DatabaseZap, Eye, Megaphone, Send, ShieldAlert } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import {
  emptyFields,
  getAnnouncementComposer,
  previewAnnouncementTemplate,
  publishTemplatedAnnouncement,
  recipientSummary,
  type AnnouncementField,
  type AnnouncementPreview,
  type AnnouncementTemplate,
} from '../data/announcements'
import { processNotificationBatch } from '../data/operations'
import { isSupabaseConfigured } from '../lib/supabase'

function kindLabel(kind: AnnouncementTemplate['kind']): string {
  return kind.replace('_', ' ')
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

  useEffect(() => {
    if (templates.length > 0 && !selectedKey) {
      setSelectedKey(templates[0].key)
    }
  }, [selectedKey, templates])

  useEffect(() => {
    if (selectedTemplate) {
      setFields(emptyFields(selectedTemplate))
      setPreview(null)
      setMessage(null)
    }
  }, [selectedTemplate])

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
      return publishTemplatedAnnouncement(selectedTemplate.key, fields)
    },
    onSuccess: async (result) => {
      setPreview(result)
      const publishedMessage = `Published "${result.title}" to ${recipientSummary(result)}.`

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
    },
  })

  const canPublish = Boolean(preview && !previewMutation.isPending && !publishMutation.isPending)

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
      ) : !composerQuery.data?.hasMfa ? (
        <DataStatePanel icon={ShieldAlert} title="MFA required before publishing" tone="setup">
          <p>Supervisors and admins must verify MFA before announcement tools can send employee communications.</p>
        </DataStatePanel>
      ) : (
        <div className="announcement-workspace">
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
                  onClick={() => setSelectedKey(template.key)}
                  type="button"
                >
                  <span>{kindLabel(template.kind)}</span>
                  <strong>{template.name}</strong>
                  <small>{template.description}</small>
                </button>
              ))}
            </div>
          </section>

          {selectedTemplate ? (
            <section className="panel announcement-compose-panel" aria-label="Announcement details">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Fill in the details</p>
                  <h2>{selectedTemplate.name}</h2>
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

                {previewMutation.isError ? <div className="inline-alert" role="alert">{previewMutation.error.message}</div> : null}
                {publishMutation.isError ? <div className="inline-alert" role="alert">{publishMutation.error.message}</div> : null}
                {message ? <div className="form-feedback form-feedback--success" role="status">{message}</div> : null}

                <div className="announcement-actions">
                  <button className="secondary-button" disabled={previewMutation.isPending} type="submit">
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
                    {publishMutation.isPending ? 'Publishing...' : 'Publish approved message'}
                  </button>
                </div>
              </form>
            </section>
          ) : null}

          <PreviewCard preview={preview} />

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
                        {kindLabel(announcement.kind)} by {announcement.createdBy}
                        {announcement.requiresArmed ? ' · armed-qualified recipients only' : ''}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
