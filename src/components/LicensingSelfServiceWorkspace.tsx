import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  Clock3,
  Download,
  Eye,
  FileCheck2,
  FileText,
  History,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Upload,
  XCircle,
} from 'lucide-react'
import { DataStatePanel } from './DataStatePanel'
import { ModalDialog } from './ModalDialog'
import { SecurePdfViewer } from './SecurePdfViewer'
import {
  getLicensingDocumentBlob,
  getLicensingCredentialDocuments,
  getLicensingSubmissionWorklist,
  getMyLicensingProfile,
  reviewLicensingSubmission,
  removeLicensingSubmissionDocument,
  saveMyLicensingSubmission,
  submitMyLicensingSubmission,
  uploadLicensingSubmissionDocument,
  withdrawMyLicensingSubmission,
  type LicensingCredential,
  type LicensingReviewItem,
  type LicensingSubmission,
  type LicensingSubmissionInput,
  type LicensingSubmissionStatus,
  type MyCredentialType,
  type MyLicensingProfile,
} from '../data/licensing'
import { formatOperationalDateTime } from '../lib/time'

type ReviewFilter = Extract<LicensingSubmissionStatus, 'pending_review' | 'correction_required' | 'approved' | 'rejected'> | 'all'

const statusLabels: Record<LicensingSubmissionStatus, string> = {
  approved: 'Approved',
  correction_required: 'Correction required',
  draft: 'Draft',
  pending_review: 'Awaiting review',
  rejected: 'Not approved',
  withdrawn: 'Withdrawn',
}

const kindLabels: Record<LicensingSubmission['submissionKind'], string> = {
  correction: 'Correct existing record',
  new: 'Add a new credential',
  renewal: 'Renew or replace a credential',
  renewal_in_progress: 'Renewal is in progress',
}

function formatDate(value: string | null): string {
  if (!value) return 'Not provided'
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(`${value.slice(0, 10)}T12:00:00`))
}

function formatTimestamp(value: string | null): string {
  return value ? formatOperationalDateTime(value) : 'Not yet submitted'
}

function formatFileSize(value: number | null): string {
  if (value === null) return 'Size not recorded'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function statusTone(status: LicensingSubmissionStatus): 'green' | 'yellow' | 'red' | 'gray' {
  if (status === 'approved') return 'green'
  if (status === 'pending_review' || status === 'draft') return 'yellow'
  if (status === 'correction_required' || status === 'rejected') return 'red'
  return 'gray'
}

function credentialTone(credential: LicensingCredential): 'green' | 'yellow' | 'red' | 'gray' {
  return credential.complianceColor
}

function documentActionLabel(action: 'preview' | 'download'): string {
  return action === 'preview' ? 'View document' : 'Download document'
}

function ProtectedImagePreview({ bytes, filename, mimeType }: { bytes: Uint8Array; filename: string; mimeType: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const nextUrl = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: mimeType }))
    setUrl(nextUrl)
    return () => URL.revokeObjectURL(nextUrl)
  }, [bytes, mimeType])
  return url ? <img alt={`Preview of ${filename}`} className="licensing-self-document-image" src={url} /> : null
}

function LicensingDocumentAccess({
  action,
  document,
  onClose,
}: {
  action: 'preview' | 'download'
  document: LicensingSubmission['documents'][number]
  onClose: () => void
}) {
  const [preview, setPreview] = useState<{ bytes: Uint8Array; mimeType: string } | null>(null)
  const mutation = useMutation({
    mutationFn: () => getLicensingDocumentBlob(document.id, action, `Employee licensing submission ${action}.`),
    onSuccess: async ({ blob, filename }) => {
      if (action === 'download') {
        const url = URL.createObjectURL(blob)
        const anchor = window.document.createElement('a')
        anchor.href = url
        anchor.download = filename
        anchor.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
        onClose()
        return
      }
      setPreview({ bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type })
    },
  })

  useEffect(() => {
    mutation.mutate()
    // The document and requested action are fixed for the life of this modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <ModalDialog className="licensing-document-access-modal" description={`${document.filename} · Access is recorded in the licensing audit history.`} onClose={onClose} title={documentActionLabel(action)}>
      {mutation.isPending ? <div className="licensing-document-state" role="status">Opening protected document…</div> : null}
      {mutation.isError ? <div className="inline-alert" role="alert">{mutation.error instanceof Error ? mutation.error.message : 'The document could not be opened.'}</div> : null}
      {preview?.mimeType === 'application/pdf' ? <SecurePdfViewer bytes={preview.bytes} title={document.filename} /> : null}
      {preview?.mimeType.startsWith('image/') ? <ProtectedImagePreview bytes={preview.bytes} filename={document.filename} mimeType={preview.mimeType} /> : null}
      <div className="modal-actions">
        {mutation.isError ? <button className="primary-action" onClick={() => mutation.mutate()} type="button">Try again</button> : null}
        <button className="secondary-button" onClick={onClose} type="button">Close</button>
      </div>
    </ModalDialog>
  )
}

function SubmissionDocuments({ documents, onRemove, removingId }: { documents: LicensingSubmission['documents']; onRemove?: (documentId: string) => void; removingId?: string | null }) {
  const [target, setTarget] = useState<{ action: 'preview' | 'download'; document: LicensingSubmission['documents'][number] } | null>(null)
  if (!documents.length) return <p className="licensing-self-muted">No supporting documents are attached.</p>
  return (
    <>
      <div className="licensing-self-documents">
        {documents.map((document) => (
          <article key={document.id}>
            <FileText aria-hidden="true" size={19} />
            <div><strong>{document.filename}</strong><span>{formatFileSize(document.byteSize)} · {formatTimestamp(document.uploadedAt)}</span></div>
            <div>
              <button aria-label={`View ${document.filename}`} className="secondary-button secondary-button--small" onClick={() => setTarget({ action: 'preview', document })} type="button"><Eye aria-hidden="true" size={15} />View</button>
              <button aria-label={`Download ${document.filename}`} className="secondary-button secondary-button--small" onClick={() => setTarget({ action: 'download', document })} type="button"><Download aria-hidden="true" size={15} />Download</button>
              {onRemove ? <button aria-label={`Remove ${document.filename}`} className="secondary-button secondary-button--small" disabled={removingId === document.id} onClick={() => onRemove(document.id)} type="button"><XCircle aria-hidden="true" size={15} />Remove</button> : null}
            </div>
          </article>
        ))}
      </div>
      {target ? <LicensingDocumentAccess action={target.action} document={target.document} onClose={() => setTarget(null)} /> : null}
    </>
  )
}

function SubmissionModal({
  existing,
  initialCredential,
  initialType,
  onClose,
  profile,
}: {
  existing?: LicensingSubmission | null
  initialCredential?: LicensingCredential | null
  initialType?: MyCredentialType | null
  onClose: () => void
  profile: MyLicensingProfile
}) {
  const queryClient = useQueryClient()
  const initialCredentialTypeId = existing?.credentialTypeId ?? initialType?.id ?? initialCredential?.credentialTypeId ?? profile.credentialTypes[0]?.id ?? ''
  const inferredCredential = initialCredential ?? profile.credentials.find((credential) => (
    credential.credentialTypeId === initialCredentialTypeId && credential.credentialId
  )) ?? null
  const [submissionId] = useState(existing?.id ?? crypto.randomUUID())
  const [credentialTypeId, setCredentialTypeId] = useState(initialCredentialTypeId)
  const [credentialId, setCredentialId] = useState(existing?.credentialId ?? inferredCredential?.credentialId ?? null)
  const [submissionKind, setSubmissionKind] = useState<LicensingSubmission['submissionKind']>(existing?.submissionKind ?? (credentialId ? 'renewal' : 'new'))
  const [credentialNumber, setCredentialNumber] = useState(existing?.credentialNumber ?? inferredCredential?.credentialNumber ?? '')
  const [issuingAuthority, setIssuingAuthority] = useState(existing?.issuingAuthority ?? inferredCredential?.issuingAuthority ?? initialType?.issuingAuthority ?? '')
  const [issueDate, setIssueDate] = useState(existing?.issueDate ?? inferredCredential?.issueDate ?? '')
  const [expirationDate, setExpirationDate] = useState(existing?.expirationDate ?? inferredCredential?.expirationDate ?? '')
  const [employeeMessage, setEmployeeMessage] = useState(existing?.employeeMessage ?? '')
  const [files, setFiles] = useState<File[]>([])
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({})
  const uploadRequestIds = useRef(new Map<string, string>())
  const selectedType = profile.credentialTypes.find((type) => type.id === credentialTypeId) ?? null
  const [existingDocuments, setExistingDocuments] = useState(existing?.documents ?? [])

  const mutation = useMutation({
    mutationFn: async (mode: 'draft' | 'submit') => {
      const input: LicensingSubmissionInput = {
        credentialId,
        credentialNumber,
        credentialTypeId,
        employeeMessage,
        expirationDate,
        issueDate,
        issuingAuthority,
        submissionId,
        submissionKind,
      }
      await saveMyLicensingSubmission(input)
      for (const file of files) {
        const fileKey = `${file.name}:${file.size}:${file.lastModified}`
        const requestId = uploadRequestIds.current.get(fileKey) ?? crypto.randomUUID()
        uploadRequestIds.current.set(fileKey, requestId)
        await uploadLicensingSubmissionDocument({ file, idempotencyKey: requestId, submissionId }, (percent) => {
          setUploadProgress((current) => ({ ...current, [file.name]: percent }))
        })
      }
      return mode === 'submit' ? submitMyLicensingSubmission(submissionId) : getMyLicensingProfile()
    },
    onSuccess: async (_data, mode) => {
      await queryClient.invalidateQueries({ queryKey: ['my-licensing-profile'] })
      if (mode === 'submit') onClose()
      else setFiles([])
    },
  })
  const removeMutation = useMutation({
    mutationFn: (documentId: string) => removeLicensingSubmissionDocument(submissionId, documentId),
    onSuccess: async (_data, documentId) => {
      setExistingDocuments((documents) => documents.filter((document) => document.id !== documentId))
      await queryClient.invalidateQueries({ queryKey: ['my-licensing-profile'] })
    },
  })

  function selectType(nextTypeId: string) {
    setCredentialTypeId(nextTypeId)
    const currentCredential = profile.credentials.find((credential) => credential.credentialTypeId === nextTypeId && credential.credentialId)
    setCredentialId(currentCredential?.credentialId ?? null)
    setSubmissionKind(currentCredential ? 'renewal' : 'new')
    setCredentialNumber(currentCredential?.credentialNumber ?? '')
    setIssuingAuthority(currentCredential?.issuingAuthority ?? profile.credentialTypes.find((type) => type.id === nextTypeId)?.issuingAuthority ?? '')
    setIssueDate(currentCredential?.issueDate ?? '')
    setExpirationDate(currentCredential?.expirationDate ?? '')
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    mutation.mutate('submit')
  }

  const canSubmit = credentialTypeId
    && employeeMessage.trim().length >= 10
    && (!selectedType?.expirationRequired || submissionKind === 'renewal_in_progress' || Boolean(expirationDate))
    && (Boolean(existingDocuments.length) || Boolean(files.length) || submissionKind === 'correction')

  return (
    <ModalDialog busy={mutation.isPending} busyLabel="Saving and protecting your licensing documents…" className="modal-dialog--wide licensing-self-submission-modal" description="Your file remains private. Only you and authorized Licensing reviewers can access it." onClose={onClose} title={existing?.status === 'correction_required' ? 'Correct licensing submission' : 'Send a licensing credential'}>
      <form className="licensing-self-form" onSubmit={submit}>
        {existing?.decisionReason ? <div className="licensing-self-decision licensing-self-decision--red" role="alert"><AlertTriangle aria-hidden="true" size={20} /><div><strong>Reviewer requested a correction</strong><span>{existing.decisionReason}</span></div></div> : null}
        <div className="form-grid form-grid--two">
          <label><span>Credential type</span><select disabled={Boolean(existing)} onChange={(event) => selectType(event.target.value)} required value={credentialTypeId}><option value="">Choose a credential</option>{profile.credentialTypes.map((type) => <option key={type.id} value={type.id}>{type.name}{type.required ? ' · Required' : ''}</option>)}</select></label>
          <label><span>What are you submitting?</span><select onChange={(event) => setSubmissionKind(event.target.value as LicensingSubmission['submissionKind'])} value={submissionKind}><option value="new">New credential</option><option disabled={!credentialId} value="renewal">Renewal or replacement</option><option disabled={!credentialId} value="correction">Correction to current record</option><option disabled={!credentialId} value="renewal_in_progress">Proof renewal is in progress</option></select></label>
          <label><span>Credential or license number</span><input onChange={(event) => setCredentialNumber(event.target.value)} placeholder="Enter the number exactly as issued" value={credentialNumber ?? ''} /></label>
          <label><span>Issuing authority</span><input onChange={(event) => setIssuingAuthority(event.target.value)} placeholder="Agency or organization" value={issuingAuthority ?? ''} /></label>
          <label><span>Issue date</span><input onChange={(event) => setIssueDate(event.target.value)} type="date" value={issueDate ?? ''} /></label>
          <label><span>Expiration date{selectedType?.expirationRequired ? ' *' : ''}</span><input onChange={(event) => setExpirationDate(event.target.value)} required={Boolean(selectedType?.expirationRequired && submissionKind !== 'renewal_in_progress')} type="date" value={expirationDate ?? ''} /></label>
        </div>
        <label><span>Message to Licensing</span><textarea maxLength={3000} minLength={10} onChange={(event) => setEmployeeMessage(event.target.value)} placeholder="Explain what you are submitting or what changed." required rows={4} value={employeeMessage} /></label>
        {selectedType?.employeeInstructions || selectedType?.renewalInstructions ? <div className="licensing-self-guidance"><ShieldCheck aria-hidden="true" size={20} /><div><strong>Before you send it</strong><span>{submissionKind === 'new' ? selectedType.employeeInstructions || selectedType.renewalInstructions : selectedType.renewalInstructions || selectedType.employeeInstructions}</span></div></div> : null}
        <section className="licensing-self-upload">
          <div><strong>Supporting documents</strong><span>PDF, PNG, JPEG, or WebP · up to 25 MB each</span></div>
          <label className="secondary-button"><Upload aria-hidden="true" size={17} />Choose files<input accept="application/pdf,image/png,image/jpeg,image/webp" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} type="file" /></label>
        </section>
        {existingDocuments.length ? <SubmissionDocuments documents={existingDocuments} onRemove={(documentId) => removeMutation.mutate(documentId)} removingId={removeMutation.variables ?? null} /> : null}
        {removeMutation.isError ? <div className="inline-alert" role="alert">{removeMutation.error instanceof Error ? removeMutation.error.message : 'The document could not be removed.'}</div> : null}
        {files.length ? <div className="licensing-self-selected-files">{files.map((file) => <article key={`${file.name}-${file.size}-${file.lastModified}`}><FileCheck2 aria-hidden="true" size={18} /><span>{file.name} · {formatFileSize(file.size)}</span><strong>{uploadProgress[file.name] ? `${uploadProgress[file.name]}%` : 'Ready'}</strong><button aria-label={`Remove ${file.name} from upload`} className="modal-close" disabled={mutation.isPending} onClick={() => setFiles((current) => current.filter((candidate) => candidate !== file))} type="button"><XCircle aria-hidden="true" size={17} /></button></article>)}</div> : null}
        {mutation.isError ? <div className="inline-alert" role="alert">{mutation.error instanceof Error ? mutation.error.message : 'The submission could not be saved.'}</div> : null}
        {mutation.isSuccess ? <div className="inline-alert inline-alert--success" role="status">Draft saved. You can keep working or send it for review.</div> : null}
        <div className="modal-actions"><button className="secondary-button" disabled={mutation.isPending || employeeMessage.trim().length < 10} onClick={() => mutation.mutate('draft')} type="button">Save draft</button><button className="primary-action" disabled={mutation.isPending || !canSubmit} type="submit"><Send aria-hidden="true" size={17} />Send for review</button></div>
      </form>
    </ModalDialog>
  )
}

function CredentialDocumentsModal({ credential, onClose }: { credential: LicensingCredential; onClose: () => void }) {
  const query = useQuery({
    queryFn: () => getLicensingCredentialDocuments(credential.credentialId!, 1, 20),
    queryKey: ['licensing-credential-documents', credential.credentialId, 1, 20],
  })
  return (
    <ModalDialog className="modal-dialog--wide" description="These files are protected and every access is recorded." onClose={onClose} title={`${credential.credentialName} documents`}>
      {query.isPending ? <div className="licensing-document-state">Loading protected documents…</div> : null}
      {query.isError ? <div className="inline-alert" role="alert">{query.error instanceof Error ? query.error.message : 'Credential documents could not be loaded.'}</div> : null}
      {query.data ? <SubmissionDocuments documents={query.data.documents.map((document) => ({ ...document, uploadState: 'stored' }))} /> : null}
      <div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Close</button></div>
    </ModalDialog>
  )
}

export function MyLicensingWorkspace({ compact = false }: { compact?: boolean }) {
  const queryClient = useQueryClient()
  const [submissionTarget, setSubmissionTarget] = useState<{ credential?: LicensingCredential | null; existing?: LicensingSubmission | null; type?: MyCredentialType | null } | null>(null)
  const [documentCredential, setDocumentCredential] = useState<LicensingCredential | null>(null)
  const deepLinkHandled = useRef(false)
  const profileQuery = useQuery({ queryFn: getMyLicensingProfile, queryKey: ['my-licensing-profile'] })
  const withdrawMutation = useMutation({
    mutationFn: withdrawMyLicensingSubmission,
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['my-licensing-profile'] }),
  })
  useEffect(() => {
    if (deepLinkHandled.current || !profileQuery.data) return
    const submissionId = new URLSearchParams(window.location.search).get('submission')
    if (!submissionId) {
      deepLinkHandled.current = true
      return
    }
    const linkedSubmission = profileQuery.data.submissions.find((submission) => submission.id === submissionId)
    if (linkedSubmission && ['draft', 'correction_required'].includes(linkedSubmission.status)) {
      setSubmissionTarget({ existing: linkedSubmission })
    }
    deepLinkHandled.current = true
  }, [profileQuery.data])

  if (profileQuery.isPending) return <DataStatePanel icon={BadgeCheck} title="Loading your licenses and credentials"><p>Checking current records, renewals, and submissions.</p></DataStatePanel>
  if (profileQuery.isError) return <DataStatePanel icon={AlertTriangle} title="Your licensing profile is unavailable" tone="error"><p>{profileQuery.error instanceof Error ? profileQuery.error.message : 'Your profile could not be loaded.'}</p></DataStatePanel>
  const profile = profileQuery.data

  return (
    <section className={compact ? 'licensing-self licensing-self--compact' : 'licensing-self'}>
      {!compact ? <header className="page-intro licensing-self-intro"><div><p className="eyebrow">My Licenses & Credentials</p><h1>Keep your credentials current</h1><p className="page-summary">View what is on file, securely submit a new license or renewal, and follow every review decision.</p></div><button className="primary-action" onClick={() => setSubmissionTarget({})} type="button"><Upload aria-hidden="true" size={18} />Submit a credential</button></header> : null}
      <div className="licensing-self-summary" aria-label="My licensing summary"><article><BadgeCheck aria-hidden="true" size={20} /><span>Current</span><strong>{profile.summary.current}</strong></article><article><AlertTriangle aria-hidden="true" size={20} /><span>Needs attention</span><strong>{profile.summary.attention}</strong></article><article><Clock3 aria-hidden="true" size={20} /><span>Awaiting review</span><strong>{profile.summary.pending}</strong></article><article><RefreshCw aria-hidden="true" size={20} /><span>Correction requested</span><strong>{profile.summary.correctionRequired}</strong></article></div>
      <section className="licensing-self-panel"><div className="licensing-self-panel__heading"><div><p className="eyebrow">Verified record</p><h2>Credentials on file</h2><p>These are the current records used for licensing and work-eligibility checks.</p></div><button className="primary-action" onClick={() => setSubmissionTarget({})} type="button"><Upload aria-hidden="true" size={17} />Submit credential</button></div><div className="licensing-self-credential-grid">{profile.credentials.map((credential) => <article className={`licensing-self-credential licensing-self-credential--${credentialTone(credential)}`} key={credential.credentialTypeId}><div className="licensing-self-credential__heading"><BadgeCheck aria-hidden="true" size={22} /><div><strong>{credential.credentialName}</strong><span className={`licensing-status licensing-status--${credentialTone(credential)}`}>{credential.statusLabel}</span></div></div><dl><div><dt>Number</dt><dd>{credential.credentialNumber || 'Not on file'}</dd></div><div><dt>Expires</dt><dd>{formatDate(credential.expirationDate)}</dd></div><div><dt>Documents</dt><dd>{credential.documentCount}</dd></div></dl><div className="licensing-self-actions">{credential.credentialId && credential.documentCount ? <button className="secondary-button secondary-button--small" onClick={() => setDocumentCredential(credential)} type="button"><Eye aria-hidden="true" size={15} />View files</button> : null}<button className="secondary-button secondary-button--small" onClick={() => setSubmissionTarget({ credential, type: profile.credentialTypes.find((type) => type.id === credential.credentialTypeId) })} type="button"><RefreshCw aria-hidden="true" size={15} />{credential.credentialId ? 'Renew or update' : 'Submit now'}</button></div></article>)}</div></section>
      <section className="licensing-self-panel"><div className="licensing-self-panel__heading"><div><p className="eyebrow">Submission history</p><h2>Requests and decisions</h2><p>Drafts, corrections, and completed reviews remain in one traceable history.</p></div></div>{profile.submissions.length ? <div className="licensing-self-submissions">{profile.submissions.map((submission) => <article key={submission.id}><div className="licensing-self-submission__heading"><div><strong>{submission.credentialName}</strong><span>{kindLabels[submission.submissionKind]} · {formatTimestamp(submission.submittedAt)}</span></div><span className={`licensing-status licensing-status--${statusTone(submission.status)}`}>{statusLabels[submission.status]}</span></div>{submission.decisionReason ? <div className={`licensing-self-decision licensing-self-decision--${statusTone(submission.status)}`}><AlertTriangle aria-hidden="true" size={18} /><span>{submission.decisionReason}</span></div> : null}<p>{submission.employeeMessage}</p><SubmissionDocuments documents={submission.documents} /><div className="licensing-self-actions">{['draft', 'correction_required'].includes(submission.status) ? <button className="primary-action" onClick={() => setSubmissionTarget({ existing: submission })} type="button">{submission.status === 'draft' ? 'Continue draft' : 'Make correction'}</button> : null}{['draft', 'pending_review', 'correction_required'].includes(submission.status) ? <button className="secondary-button" disabled={withdrawMutation.isPending} onClick={() => withdrawMutation.mutate(submission.id)} type="button">Withdraw</button> : null}</div></article>)}</div> : <div className="licensing-empty"><History aria-hidden="true" size={24} /><strong>No submissions yet</strong><span>Use Submit credential when you have a new license, renewal, or correction.</span></div>}</section>
      {submissionTarget ? <SubmissionModal existing={submissionTarget.existing} initialCredential={submissionTarget.credential} initialType={submissionTarget.type} onClose={() => setSubmissionTarget(null)} profile={profile} /> : null}
      {documentCredential ? <CredentialDocumentsModal credential={documentCredential} onClose={() => setDocumentCredential(null)} /> : null}
    </section>
  )
}

function ReviewModal({ item, onClose }: { item: LicensingReviewItem; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [decision, setDecision] = useState<'approve' | 'request_correction' | 'reject'>('approve')
  const [reason, setReason] = useState('')
  const mutation = useMutation({
    mutationFn: () => reviewLicensingSubmission({ decision, reason, submissionId: item.id }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['licensing-submission-worklist'] }),
        queryClient.invalidateQueries({ queryKey: ['licensing-center'] }),
      ])
      onClose()
    },
  })
  const reasonRequired = decision !== 'approve'
  return (
    <ModalDialog busy={mutation.isPending} busyLabel="Saving review decision…" className="modal-dialog--wide licensing-review-modal" description={`${item.employeeName} · ${item.employeeNumber || item.username} · Revision ${item.revisionNumber}`} onClose={onClose} title={`Review ${item.credentialName}`}>
      <div className="licensing-review-detail"><dl><div><dt>Submission</dt><dd>{kindLabels[item.submissionKind]}</dd></div><div><dt>Credential number</dt><dd>{item.credentialNumber || 'Not provided'}</dd></div><div><dt>Issue date</dt><dd>{formatDate(item.issueDate)}</dd></div><div><dt>Expiration date</dt><dd>{formatDate(item.expirationDate)}</dd></div><div><dt>Issuing authority</dt><dd>{item.issuingAuthority || 'Not provided'}</dd></div><div><dt>Submitted</dt><dd>{formatTimestamp(item.submittedAt)}</dd></div></dl><section><strong>Employee message</strong><p>{item.employeeMessage}</p></section><SubmissionDocuments documents={item.documents} /></div>
      {item.status === 'pending_review' ? <form className="licensing-review-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate() }}><fieldset><legend>Decision</legend><label><input checked={decision === 'approve'} name="review-decision" onChange={() => setDecision('approve')} type="radio" />Approve and update verified record</label><label><input checked={decision === 'request_correction'} name="review-decision" onChange={() => setDecision('request_correction')} type="radio" />Request a correction</label><label><input checked={decision === 'reject'} name="review-decision" onChange={() => setDecision('reject')} type="radio" />Reject submission</label></fieldset><label><span>{reasonRequired ? 'Required explanation' : 'Approval note (optional)'}</span><textarea maxLength={2000} minLength={reasonRequired ? 10 : undefined} onChange={(event) => setReason(event.target.value)} placeholder={reasonRequired ? 'Tell the employee exactly what must be corrected.' : 'Add an internal decision note if needed.'} required={reasonRequired} rows={4} value={reason} /></label>{mutation.isError ? <div className="inline-alert" role="alert">{mutation.error instanceof Error ? mutation.error.message : 'The review decision could not be saved.'}</div> : null}<div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Cancel</button><button className="primary-action" disabled={mutation.isPending || (reasonRequired && reason.trim().length < 10)} type="submit">{decision === 'approve' ? <CheckCircle2 aria-hidden="true" size={17} /> : <XCircle aria-hidden="true" size={17} />}Save decision</button></div></form> : <div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Close</button></div>}
    </ModalDialog>
  )
}

export function LicensingSubmissionReviewQueue() {
  const [deepLinkId] = useState(() => new URLSearchParams(window.location.search).get('submission'))
  const [status, setStatus] = useState<ReviewFilter>('pending_review')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<LicensingReviewItem | null>(null)
  const query = useQuery({
    queryFn: () => getLicensingSubmissionWorklist({ page, pageSize: 10, search: deepLinkId || search, status }),
    queryKey: ['licensing-submission-worklist', status, search, page, deepLinkId],
  })
  useEffect(() => {
    if (!selected && deepLinkId) {
      const linked = query.data?.items.find((item) => item.id === deepLinkId)
      if (linked) setSelected(linked)
    }
  }, [deepLinkId, query.data?.items, selected])
  const summary = query.data?.summary
  const tabs = useMemo(() => ([
    { count: summary?.pendingReview ?? 0, label: 'Awaiting review', value: 'pending_review' as const },
    { count: summary?.correctionRequired ?? 0, label: 'Correction requested', value: 'correction_required' as const },
    { count: summary?.approved ?? 0, label: 'Approved', value: 'approved' as const },
    { count: summary?.rejected ?? 0, label: 'Rejected', value: 'rejected' as const },
  ]), [summary])

  return (
    <section className="licensing-review-queue">
      <div className="licensing-review-queue__heading"><div><p className="eyebrow">Employee submissions</p><h2>Licensing review queue</h2><p>Review employee uploads here. Approval updates the existing verified credential record and keeps the prior version.</p></div><span className="licensing-review-count">{summary?.pendingReview ?? 0} awaiting review</span></div>
      <div className="licensing-review-toolbar"><div className="licensing-review-tabs" role="tablist" aria-label="Submission status">{tabs.map((tab) => <button aria-selected={status === tab.value} className={status === tab.value ? 'is-active' : ''} key={tab.value} onClick={() => { setStatus(tab.value); setPage(1) }} role="tab" type="button"><span>{tab.label}</span><strong>{tab.count}</strong></button>)}</div><label className="search-field"><Search aria-hidden="true" size={18} /><span className="visually-hidden">Search submissions</span><input onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="Search employee, ID, username, or credential" type="search" value={search} /></label></div>
      {query.isPending ? <div className="licensing-document-state">Loading employee submissions…</div> : null}
      {query.isError ? <div className="inline-alert" role="alert">{query.error instanceof Error ? query.error.message : 'Employee submissions could not be loaded.'}</div> : null}
      {query.data && !query.data.items.length ? <div className="licensing-empty"><CheckCircle2 aria-hidden="true" size={24} /><strong>No submissions in this view</strong><span>New employee submissions will appear here automatically.</span></div> : null}
      {query.data?.items.length ? <div className="licensing-review-list">{query.data.items.map((item) => <article key={item.id}><div><strong>{item.employeeName}</strong><span>{item.employeeNumber || item.username} · {item.credentialName}</span></div><div><span>{kindLabels[item.submissionKind]}</span><small>{formatTimestamp(item.submittedAt)}</small></div><span className={`licensing-status licensing-status--${statusTone(item.status)}`}>{statusLabels[item.status]}</span><button className={item.status === 'pending_review' ? 'primary-action' : 'secondary-button'} onClick={() => setSelected(item)} type="button">{item.status === 'pending_review' ? 'Review' : 'View'}</button></article>)}</div> : null}
      {query.data && query.data.pagination.totalPages > 1 ? <div className="licensing-document-pagination"><span>{query.data.pagination.totalCount} submissions</span><button className="secondary-button secondary-button--small" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">Previous</button><span>Page {page} of {query.data.pagination.totalPages}</span><button className="secondary-button secondary-button--small" disabled={page >= query.data.pagination.totalPages} onClick={() => setPage((value) => value + 1)} type="button">Next</button></div> : null}
      {selected ? <ReviewModal item={selected} onClose={() => setSelected(null)} /> : null}
    </section>
  )
}
