import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  BadgeCheck,
  BellRing,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Download,
  Eye,
  FileText,
  FolderOpen,
  Mail,
  Pencil,
  Save,
  Search,
  ShieldAlert,
  Upload,
  UserRoundPlus,
  X,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { IdentityVerificationModal } from '../components/IdentityVerificationModal'
import { ModalDialog } from '../components/ModalDialog'
import { getSessionContext } from '../data/auth'
import {
  formatEligibility,
  formatRole,
  getLicensingCredentialDocuments,
  getLicensingCenter,
  getLicensingDocumentBlob,
  isLicensingIdentityVerificationRequired,
  recordLicensingCommunication,
  upsertLicensingCredential,
  upsertLicensingEmployee,
  uploadCredentialDocument,
  type ComplianceColor,
  type CredentialStatus,
  type CredentialType,
  type LicensingCenter,
  type LicensingCredential,
  type LicensingCredentialDocument,
  type LicensingEmployee,
  type RenewalStatus,
} from '../data/licensing'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'
import { activeCredentialRenewalCount } from '../lib/licensingWorklist'

type SummaryFilter =
  | 'all'
  | 'needsAction'
  | 'dueSoon'
  | 'compliant'
  | 'expired'
  | 'missing'
  | 'awaitingReview'
  | 'ineligible'

type StatusFilter =
  | 'all'
  | 'needsAction'
  | 'missing'
  | 'awaitingReview'
  | 'verified'
  | 'expiring'
  | 'expired'
  | 'rejected'
  | 'renewal'

type EligibilityFilter = 'all' | 'armed' | 'unarmed' | 'ineligible'
type ExpirationFilter = 'all' | '30' | '60' | '90'
type WorklistSort = 'employee' | 'expiration' | 'status' | 'eligibility'
type ProfileTab = 'credentials' | 'renewals' | 'activity'

const complianceLabels: Record<ComplianceColor, string> = {
  gray: 'Neutral',
  green: 'Compliant',
  red: 'Immediate Action',
  yellow: 'Attention Required',
}

const employmentStatusLabels: Record<LicensingEmployee['employmentStatus'], string> = {
  active: 'Active',
  inactive: 'Inactive',
  leave: 'On Leave',
  onboarding: 'Onboarding',
  separated: 'Separated',
}

const credentialStatusOptions: Array<{ value: CredentialStatus; label: string }> = [
  { label: 'Pending / Submitted', value: 'pending' },
  { label: 'Active / Verified', value: 'active' },
  { label: 'Expired', value: 'expired' },
  { label: 'Suspended', value: 'suspended' },
  { label: 'Revoked', value: 'revoked' },
]

const renewalStatusOptions: Array<{ value: RenewalStatus; label: string }> = [
  { label: 'Not started', value: 'not_started' },
  { label: 'Started', value: 'started' },
  { label: 'Submitted', value: 'submitted' },
  { label: 'Awaiting issuing authority', value: 'awaiting_issuing_authority' },
  { label: 'Approved', value: 'approved' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Completed', value: 'completed' },
]

function formatDate(value: string | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(`${value.slice(0, 10)}T12:00:00`))
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—'
  return formatOperationalDateTime(value)
}

function normalized(value: unknown): string {
  return String(value ?? '').toLocaleLowerCase()
}

function formatFileSize(value: number | null): string {
  if (value === null) return 'Size not recorded'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function legalEmployeeName(employee: LicensingEmployee): string {
  return [employee.firstName, employee.middleName, employee.lastName].filter(Boolean).join(' ')
}

function credentialIsMissing(credential: LicensingCredential): boolean {
  return credential.required && !credential.credentialId
}

function credentialIsAwaitingReview(credential: LicensingCredential): boolean {
  return normalized(credential.status).includes('review') || credential.status === 'Pending'
}

function credentialIsRejected(credential: LicensingCredential): boolean {
  return normalized(credential.status).includes('reject') || Boolean(credential.rejectionReason)
}

function credentialIsExpired(credential: LicensingCredential): boolean {
  return credential.statusLabel === 'Expired'
    || credential.status === 'Expired'
    || (typeof credential.daysRemaining === 'number' && credential.daysRemaining < 0)
}

function credentialHasActiveRenewal(credential: LicensingCredential): boolean {
  return credential.renewalStatus !== 'not_started' && credential.renewalStatus !== 'completed'
}

function credentialNeedsAction(credential: LicensingCredential): boolean {
  return credential.complianceColor === 'red'
    || credentialIsMissing(credential)
    || credentialIsExpired(credential)
    || credentialIsRejected(credential)
}

function employeeIsArmedEligible(employee: LicensingEmployee): boolean {
  if (employee.workEligibility === 'ineligible' || employee.workEligibility === 'restricted') return false
  return employee.credentials.some((credential) => (
    credential.credentialTypeCode === 'armed_security_guard_credential'
      && Boolean(credential.credentialId)
      && credential.complianceColor !== 'red'
      && !credentialIsExpired(credential)
  ))
}

function employeeMatchesStatus(employee: LicensingEmployee, filter: StatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'needsAction') return employee.overallCompliance === 'red' || employee.credentials.some(credentialNeedsAction)
  if (filter === 'missing') return employee.credentials.some(credentialIsMissing)
  if (filter === 'awaitingReview') return employee.credentials.some(credentialIsAwaitingReview)
  if (filter === 'verified') return employee.overallCompliance === 'green'
  if (filter === 'expiring') return employee.credentials.some((credential) => (
    typeof credential.daysRemaining === 'number' && credential.daysRemaining >= 0 && credential.daysRemaining <= 90
  ))
  if (filter === 'expired') return employee.credentials.some(credentialIsExpired)
  if (filter === 'rejected') return employee.credentials.some(credentialIsRejected)
  if (filter === 'renewal') return employee.credentials.some(credentialHasActiveRenewal)
  return true
}

function employeeMatchesSummary(employee: LicensingEmployee, filter: SummaryFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'needsAction') return employeeMatchesStatus(employee, 'needsAction') || employee.workEligibility === 'ineligible'
  if (filter === 'dueSoon') return employee.credentials.some((credential) => (
    typeof credential.daysRemaining === 'number' && credential.daysRemaining >= 0 && credential.daysRemaining <= 30
  ))
  if (filter === 'compliant') return employee.overallCompliance === 'green'
  if (filter === 'expired') return employeeMatchesStatus(employee, 'expired')
  if (filter === 'missing') return employeeMatchesStatus(employee, 'missing')
  if (filter === 'awaitingReview') return employeeMatchesStatus(employee, 'awaitingReview')
  if (filter === 'ineligible') return employee.workEligibility === 'ineligible'
  return true
}

function employeeMatchesEligibility(employee: LicensingEmployee, filter: EligibilityFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'ineligible') return employee.workEligibility === 'ineligible'
  if (filter === 'armed') return employeeIsArmedEligible(employee)
  return employee.workEligibility !== 'ineligible' && !employeeIsArmedEligible(employee)
}

function employeeMatchesExpiration(employee: LicensingEmployee, filter: ExpirationFilter): boolean {
  if (filter === 'all') return true
  const days = Number(filter)
  return employee.credentials.some((credential) => (
    typeof credential.daysRemaining === 'number' && credential.daysRemaining >= 0 && credential.daysRemaining <= days
  ))
}

function statusRank(color: ComplianceColor): number {
  return color === 'red' ? 0 : color === 'yellow' ? 1 : color === 'gray' ? 2 : 3
}

function statusToneClass(color: ComplianceColor): string {
  return `licensing-status licensing-status--${color}`
}

function CredentialStatusPill({ color, label }: { color: ComplianceColor; label: string }) {
  return <span className={statusToneClass(color)}>{label}</span>
}

function isGuardLicenseCode(code: string): boolean {
  return code === 'denver_security_guard_license' || code === 'armed_security_guard_credential'
}

function credentialDisplayName(credential: Pick<LicensingCredential, 'credentialName' | 'credentialTypeCode'>): string {
  if (credential.credentialTypeCode === 'denver_security_guard_license') return 'Standard Guard License'
  if (credential.credentialTypeCode === 'armed_security_guard_credential') return 'Armed Guard License / Endorsement'
  return credential.credentialName
}

function credentialTemplateFromType(type: CredentialType): LicensingCredential {
  return {
    affectsWorkEligibility: type.affectsWorkEligibility,
    category: type.category,
    complianceColor: 'gray',
    credentialId: null,
    credentialName: type.name,
    credentialNumber: null,
    credentialTypeCode: type.code,
    credentialTypeId: type.id,
    daysRemaining: null,
    documentCount: 0,
    employeeNotes: null,
    expirationDate: null,
    internalNotes: null,
    issueDate: null,
    issuingAuthority: type.issuingAuthority,
    lastEmployeeNotification: null,
    latestDocumentAt: null,
    rejectionReason: null,
    renewalStatus: 'not_started',
    required: false,
    status: 'Not Added',
    statusLabel: 'Ready to add',
  }
}

function EmployeeFormModal({
  employee,
  onClose,
}: {
  employee?: LicensingEmployee
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [message, setMessage] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: upsertLicensingEmployee,
    onSuccess: async () => {
      setMessage(employee ? 'Employee profile saved.' : 'Onboarding employee created.')
      await queryClient.invalidateQueries({ queryKey: ['licensing-center'], refetchType: 'active' })
      if (!employee) onClose()
    },
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const value = (key: string) => String(form.get(key) ?? '').trim()
    mutation.mutate({
      companyEmail: value('companyEmail'),
      employeeId: employee?.employeeId,
      employmentStatus: value('employmentStatus') as LicensingEmployee['employmentStatus'],
      employmentType: value('employmentType') as LicensingEmployee['employmentType'],
      firstName: value('firstName'),
      jobTitle: value('jobTitle'),
      lastName: value('lastName'),
      middleName: value('middleName'),
      mobilePhone: value('mobilePhone'),
      personalEmail: value('personalEmail'),
      preferredName: value('preferredName'),
      role: employee?.role ?? 'guard',
    })
  }

  return (
    <ModalDialog
      busy={mutation.isPending}
      busyLabel={employee ? 'Saving employee profile...' : 'Creating onboarding record...'}
      className="modal-dialog--wide"
      description="Recruiting and licensing can maintain onboarding and operational profile information without user-admin access."
      onClose={onClose}
      title={employee ? `Edit ${employee.displayName}` : 'Add onboarding employee'}
    >
      <form className="request-form licensing-form" onSubmit={submit}>
        <div className="form-grid form-grid--three">
          <label><span>First name</span><input defaultValue={employee?.firstName ?? ''} name="firstName" required /></label>
          <label><span>Middle name</span><input defaultValue={employee?.middleName ?? ''} name="middleName" /></label>
          <label><span>Last name</span><input defaultValue={employee?.lastName ?? ''} name="lastName" required /></label>
        </div>
        <div className="form-grid form-grid--three">
          <label><span>Preferred name</span><input defaultValue={employee?.preferredName ?? ''} name="preferredName" /></label>
          <label><span>Job title / position</span><input defaultValue={employee?.jobTitle ?? ''} maxLength={140} name="jobTitle" /></label>
          <label>
            <span>Employment</span>
            <select defaultValue={employee?.employmentType ?? 'hourly'} name="employmentType">
              <option value="hourly">Hourly</option>
              <option value="salary">Salary</option>
              <option value="flex">Flex</option>
            </select>
          </label>
        </div>
        <div className="form-grid form-grid--three">
          <label>
            <span>Status</span>
            <select defaultValue={employee?.employmentStatus ?? 'onboarding'} name="employmentStatus">
              <option value="onboarding">Onboarding</option>
              <option value="active">Active</option>
              <option value="leave">On leave</option>
              <option value="inactive">Inactive</option>
              <option value="separated">Separated</option>
            </select>
          </label>
          <label><span>Personal email</span><input defaultValue={employee?.personalEmail ?? ''} name="personalEmail" type="email" /></label>
          <label><span>Company email</span><input defaultValue={employee?.companyEmail ?? ''} name="companyEmail" type="email" /></label>
        </div>
        <div className="form-grid form-grid--two">
          <label><span>Mobile phone</span><input defaultValue={employee?.mobilePhone ?? ''} name="mobilePhone" /></label>
          <label><span>System role</span><input value={employee ? formatRole(employee.role) : 'Guard'} readOnly /></label>
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">Cancel</button>
          <button className="primary-action" disabled={mutation.isPending} type="submit">
            <Save aria-hidden="true" size={17} />
            {mutation.isPending ? 'Saving...' : employee ? 'Save profile' : 'Create onboarding record'}
          </button>
        </div>
        {message ? <div className="form-feedback form-feedback--success" role="status">{message}</div> : null}
        {mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}
      </form>
    </ModalDialog>
  )
}

function CredentialDocumentAccessModal({
  action,
  document,
  onClose,
}: {
  action: 'preview' | 'download'
  document: LicensingCredentialDocument
  onClose: () => void
}) {
  const [reason, setReason] = useState('')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewType, setPreviewType] = useState('')
  const [verificationOpen, setVerificationOpen] = useState(false)
  const accessMutation = useMutation({
    mutationFn: () => getLicensingDocumentBlob(document.id, action, reason),
    onSuccess: ({ blob, filename }) => {
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
      setPreviewType(blob.type)
      setPreviewUrl(URL.createObjectURL(blob))
    },
    onError: (error) => {
      if (isLicensingIdentityVerificationRequired(error)) setVerificationOpen(true)
    },
  })

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])

  return (
    <>
      <ModalDialog
      busy={accessMutation.isPending}
      busyLabel={`Preparing protected ${action}…`}
      className="licensing-document-access-modal"
      description={`${document.filename} · Access is recorded in the licensing audit history.`}
      onClose={onClose}
      title={action === 'preview' ? 'View licensing document' : 'Download licensing document'}
    >
      {previewUrl ? (
        <div className="licensing-document-preview">
          {previewType === 'application/pdf' ? <iframe sandbox="" src={previewUrl} title={`Preview of ${document.filename}`} /> : null}
          {previewType.startsWith('image/') ? <img alt={`Preview of ${document.filename}`} src={previewUrl} /> : null}
          <div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Close preview</button></div>
        </div>
      ) : (
        <form className="licensing-document-access-form" onSubmit={(event) => { event.preventDefault(); if (reason.trim().length >= 8) accessMutation.mutate() }}>
          <div className="licensing-document-access-summary"><FileText aria-hidden="true" size={24} /><div><strong>{document.filename}</strong><span>{formatFileSize(document.byteSize)} · Protected credential evidence</span></div></div>
          <label>Business reason<textarea autoFocus maxLength={500} minLength={8} onChange={(event) => setReason(event.target.value)} placeholder="Explain why you need to view or download this document." required rows={3} value={reason} /></label>
          {accessMutation.isError && !isLicensingIdentityVerificationRequired(accessMutation.error) ? <div className="inline-alert" role="alert">{accessMutation.error instanceof Error ? accessMutation.error.message : 'Document access could not be completed.'}</div> : null}
          <div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Cancel</button><button className="primary-action" disabled={reason.trim().length < 8 || accessMutation.isPending} type="submit">{action === 'preview' ? <Eye aria-hidden="true" size={17} /> : <Download aria-hidden="true" size={17} />}{action === 'preview' ? 'Open protected preview' : 'Download protected file'}</button></div>
        </form>
      )}
      </ModalDialog>
      {verificationOpen ? (
        <IdentityVerificationModal
          onCancel={() => setVerificationOpen(false)}
          onVerified={() => {
            setVerificationOpen(false)
            accessMutation.reset()
            accessMutation.mutate()
          }}
        />
      ) : null}
    </>
  )
}

function CredentialDocumentList({ credentialId, onVerificationRequired }: { credentialId: string; onVerificationRequired: () => void }) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<5 | 10 | 20>(5)
  const [accessTarget, setAccessTarget] = useState<{ action: 'preview' | 'download'; document: LicensingCredentialDocument } | null>(null)
  const documentsQuery = useQuery({
    queryFn: () => getLicensingCredentialDocuments(credentialId, page, pageSize),
    queryKey: ['licensing-credential-documents', credentialId, page, pageSize],
  })
  const workspace = documentsQuery.data

  useEffect(() => {
    if (workspace && page > Math.max(workspace.pagination.totalPages, 1)) setPage(Math.max(workspace.pagination.totalPages, 1))
  }, [page, workspace])

  useEffect(() => {
    if (isLicensingIdentityVerificationRequired(documentsQuery.error)) onVerificationRequired()
  }, [documentsQuery.error, onVerificationRequired])

  if (documentsQuery.isPending) return <div className="licensing-document-state" role="status">Loading protected documents…</div>
  if (documentsQuery.isError) return isLicensingIdentityVerificationRequired(documentsQuery.error)
    ? <div className="licensing-document-state" role="status">Identity verification is required to load protected documents.</div>
    : <div className="inline-alert" role="alert">{documentsQuery.error instanceof Error ? documentsQuery.error.message : 'Credential documents could not be loaded.'}</div>
  if (!workspace) return null

  return (
    <div className="licensing-document-workspace">
      {workspace.documents.length ? (
        <div className="licensing-document-list">
          {workspace.documents.map((document) => (
            <article key={document.id}>
              <span className="licensing-document-list__icon"><FileText aria-hidden="true" size={19} /></span>
              <div><strong title={document.filename}>{document.filename}</strong><span>{formatFileSize(document.byteSize)} · Uploaded {formatTimestamp(document.uploadedAt)}</span></div>
              <div className="licensing-document-list__actions">
                <button className="secondary-button secondary-button--small" onClick={() => setAccessTarget({ action: 'preview', document })} type="button"><Eye aria-hidden="true" size={15} />View</button>
                <button className="secondary-button secondary-button--small" onClick={() => setAccessTarget({ action: 'download', document })} type="button"><Download aria-hidden="true" size={15} />Download</button>
              </div>
            </article>
          ))}
        </div>
      ) : <div className="licensing-document-empty"><FileText aria-hidden="true" size={22} /><span>No documents have been uploaded for this credential.</span></div>}
      <div className="licensing-document-pagination">
        <span>{workspace.pagination.totalCount} document{workspace.pagination.totalCount === 1 ? '' : 's'}</span>
        <label>Rows<select onChange={(event) => { setPageSize(Number(event.target.value) as 5 | 10 | 20); setPage(1) }} value={pageSize}><option value={5}>5</option><option value={10}>10</option><option value={20}>20</option></select></label>
        <button className="secondary-button secondary-button--small" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button"><ChevronLeft aria-hidden="true" size={15} />Previous</button>
        <span>Page {workspace.pagination.totalCount === 0 ? 0 : page} of {workspace.pagination.totalPages}</span>
        <button className="secondary-button secondary-button--small" disabled={page >= workspace.pagination.totalPages} onClick={() => setPage((value) => value + 1)} type="button">Next<ChevronRight aria-hidden="true" size={15} /></button>
      </div>
      {accessTarget ? <CredentialDocumentAccessModal action={accessTarget.action} document={accessTarget.document} onClose={() => setAccessTarget(null)} /> : null}
    </div>
  )
}

function CredentialDocumentsModal({ credential, onClose }: { credential: LicensingCredential; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [verificationOpen, setVerificationOpen] = useState(false)
  const requireVerification = useCallback(() => setVerificationOpen(true), [])
  if (!credential.credentialId) return null
  return (
    <>
      <ModalDialog className="modal-dialog--wide licensing-documents-modal" description={`${credentialDisplayName(credential)} · Protected documents remain private and every access is audited.`} onClose={onClose} title="Credential documents"><CredentialDocumentList credentialId={credential.credentialId} onVerificationRequired={requireVerification} /></ModalDialog>
      {verificationOpen ? (
        <IdentityVerificationModal
          onCancel={() => setVerificationOpen(false)}
          onVerified={async () => {
            setVerificationOpen(false)
            await queryClient.invalidateQueries({ queryKey: ['licensing-credential-documents', credential.credentialId] })
          }}
        />
      ) : null}
    </>
  )
}

function CredentialEditModal({
  credential,
  credentialTypes,
  employee,
  onClose,
}: {
  credential: LicensingCredential
  credentialTypes: CredentialType[]
  employee: LicensingEmployee
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [selectedStatus, setSelectedStatus] = useState<CredentialStatus>(
    credential.status === 'Verified' || credential.status === 'Expiring' || credential.status === 'Renewal Needed'
      ? 'active'
      : credential.status === 'Expired'
        ? 'expired'
        : 'pending',
  )
  const [currentCredentialId, setCurrentCredentialId] = useState(credential.credentialId)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadRequestId, setUploadRequestId] = useState(() => crypto.randomUUID())
  const [verificationOpen, setVerificationOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const selectedType = credentialTypes.find((type) => type.id === credential.credentialTypeId)
  const requireVerification = useCallback(() => setVerificationOpen(true), [])

  const credentialMutation = useMutation({
    mutationFn: upsertLicensingCredential,
    onSuccess: async (payload) => {
      const updatedEmployee = payload.employees.find((item) => item.employeeId === employee.employeeId)
      const updatedCredential = updatedEmployee?.credentials.find((item) => item.credentialTypeId === credential.credentialTypeId)
      setCurrentCredentialId(updatedCredential?.credentialId ?? currentCredentialId)
      await queryClient.invalidateQueries({ queryKey: ['licensing-center'], refetchType: 'active' })
    },
  })
  const documentMutation = useMutation({
    mutationFn: (input: { credentialId: string; file: File; idempotencyKey: string }) => uploadCredentialDocument(input, setUploadProgress),
    onSuccess: async () => {
      setSelectedFile(null)
      setUploadProgress(100)
      setUploadRequestId(crypto.randomUUID())
      if (fileInputRef.current) fileInputRef.current.value = ''
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['licensing-center'], refetchType: 'active' }),
        queryClient.invalidateQueries({ queryKey: ['licensing-credential-documents', currentCredentialId] }),
      ])
    },
    onError: (error) => {
      if (isLicensingIdentityVerificationRequired(error)) {
        setVerificationOpen(true)
        return
      }
      if ((error as Error & { code?: string }).code === 'licensing_document_storage_failed') {
        setUploadRequestId(crypto.randomUUID())
      }
    },
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const value = (key: string) => String(form.get(key) ?? '').trim()
    credentialMutation.mutate({
      credentialNumber: value('credentialNumber'),
      credentialTypeId: credential.credentialTypeId,
      employeeId: employee.employeeId,
      employeeNotes: value('employeeNotes'),
      expirationDate: value('expirationDate'),
      internalNotes: value('internalNotes'),
      issueDate: value('issueDate'),
      issuingAuthority: value('issuingAuthority'),
      rejectionReason: value('rejectionReason'),
      renewalStatus: value('renewalStatus') as RenewalStatus,
      status: selectedStatus,
    })
  }

  function uploadDocument() {
    if (!selectedFile || !currentCredentialId) return
    setUploadProgress(0)
    documentMutation.mutate({
      credentialId: currentCredentialId,
      file: selectedFile,
      idempotencyKey: uploadRequestId,
    })
  }

  function chooseDocument(file: File | null) {
    documentMutation.reset()
    setSelectedFile(file)
    setUploadProgress(0)
    setUploadRequestId(crypto.randomUUID())
  }

  return (
    <>
      <ModalDialog
      busy={credentialMutation.isPending || documentMutation.isPending}
      busyLabel={documentMutation.isPending ? 'Uploading credential document...' : 'Saving credential...'}
      className="modal-dialog--wide"
      description={`${employee.displayName} • ${credential.credentialName}`}
      onClose={onClose}
      title={credential.credentialId ? 'Manage credential/license' : 'Add credential/license'}
    >
      <form className="request-form licensing-form" onSubmit={submit}>
        <section className={`licensing-alert licensing-alert--${credential.complianceColor}`}>
          <ShieldAlert aria-hidden="true" size={20} />
          <div>
            <strong>{credential.statusLabel}</strong>
            <span>
              {selectedType?.renewalInstructions ?? 'Keep this credential record complete and accurate before relying on it for scheduling.'}
            </span>
          </div>
        </section>
        <div className="form-grid form-grid--three">
          <label>
            <span>Status</span>
            <select name="status" onChange={(event) => setSelectedStatus(event.target.value as CredentialStatus)} value={selectedStatus}>
              {credentialStatusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>
            <span>Renewal status</span>
            <select defaultValue={credential.renewalStatus ?? 'not_started'} name="renewalStatus">
              {renewalStatusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label><span>Credential number</span><input defaultValue={credential.credentialNumber ?? ''} name="credentialNumber" /></label>
        </div>
        <div className="form-grid form-grid--three">
          <label><span>Issuing authority</span><input defaultValue={credential.issuingAuthority ?? selectedType?.issuingAuthority ?? ''} name="issuingAuthority" /></label>
          <label><span>Issue date</span><input defaultValue={credential.issueDate ?? ''} name="issueDate" type="date" /></label>
          <label><span>Expiration date</span><input defaultValue={credential.expirationDate ?? ''} name="expirationDate" required={selectedType?.expirationRequired ?? false} type="date" /></label>
        </div>
        <div className="form-grid form-grid--two">
          <label className="field-stack"><span>Internal notes</span><textarea defaultValue={credential.internalNotes ?? ''} maxLength={2000} name="internalNotes" rows={3} /></label>
          <label className="field-stack"><span>Employee-facing notes</span><textarea defaultValue={credential.employeeNotes ?? ''} maxLength={2000} name="employeeNotes" rows={3} /></label>
        </div>
        <label className="field-stack">
          <span>Rejection reason <small>Only use when rejecting an invalid/unreadable document</small></span>
          <textarea defaultValue={credential.rejectionReason ?? ''} maxLength={2000} name="rejectionReason" rows={2} />
        </label>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">Close</button>
          <button className="primary-action" disabled={credentialMutation.isPending} type="submit">
            <Save aria-hidden="true" size={17} />
            {credentialMutation.isPending ? 'Saving...' : 'Save credential/license'}
          </button>
        </div>
        {credentialMutation.isSuccess ? <div className="form-feedback form-feedback--success" role="status">Credential saved and compliance recalculated.</div> : null}
        {credentialMutation.isError ? <div className="inline-alert" role="alert">{credentialMutation.error.message}</div> : null}
      </form>

      <section className="licensing-document-panel">
        <div className="licensing-document-panel__heading">
          <div><strong>Credential documents</strong><span>PDF, PNG, JPEG, or WebP · 25 MB maximum · secure viewing and downloading</span></div>
          <div className="licensing-document-upload-controls">
            <label className="file-picker">
              <Upload aria-hidden="true" size={17} />
              <span>{selectedFile ? selectedFile.name : 'Choose document'}</span>
              <input
                accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp"
                onChange={(event) => chooseDocument(event.target.files?.[0] ?? null)}
                ref={fileInputRef}
                type="file"
              />
            </label>
            <button className="secondary-button" disabled={!selectedFile || !currentCredentialId || documentMutation.isPending} onClick={uploadDocument} type="button">
              <Upload aria-hidden="true" size={17} />
              {documentMutation.isPending ? `Uploading ${uploadProgress}%` : 'Upload document'}
            </button>
          </div>
        </div>
        {!currentCredentialId ? <p className="form-note">Save the credential first, then attach documents.</p> : null}
        {documentMutation.isPending ? <div aria-label={`Upload ${uploadProgress}% complete`} className="licensing-document-progress"><span style={{ width: `${uploadProgress}%` }} /></div> : null}
        {documentMutation.isSuccess ? <div className="form-feedback form-feedback--success" role="status">Document uploaded securely. It is ready to view or download below.</div> : null}
        {documentMutation.isError && !isLicensingIdentityVerificationRequired(documentMutation.error) ? <div className="inline-alert" role="alert">{documentMutation.error instanceof Error ? documentMutation.error.message : 'The licensing document could not be uploaded.'}</div> : null}
        {currentCredentialId ? <CredentialDocumentList credentialId={currentCredentialId} onVerificationRequired={requireVerification} /> : null}
      </section>
      </ModalDialog>
      {verificationOpen ? (
        <IdentityVerificationModal
          onCancel={() => setVerificationOpen(false)}
          onVerified={async () => {
            setVerificationOpen(false)
            await queryClient.invalidateQueries({ queryKey: ['licensing-credential-documents', currentCredentialId] })
            if (selectedFile && currentCredentialId && isLicensingIdentityVerificationRequired(documentMutation.error)) {
              documentMutation.reset()
              setUploadProgress(0)
              documentMutation.mutate({ credentialId: currentCredentialId, file: selectedFile, idempotencyKey: uploadRequestId })
            }
          }}
        />
      ) : null}
    </>
  )
}

function CommunicationModal({
  credential,
  employee,
  onClose,
}: {
  credential: LicensingCredential
  employee: LicensingEmployee
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const recipient = employee.companyEmail || employee.personalEmail || ''
  const subject = `${credential.credentialName} update needed`
  const body = [
    `Hello ${employee.preferredName || employee.firstName},`,
    `We are reviewing your ${credential.credentialName} record in SygShift.`,
    credential.expirationDate
      ? `Current expiration date on file: ${formatDate(credential.expirationDate)}.`
      : 'This credential is currently missing an expiration date or document.',
    'Please provide any updated documentation or renewal status as soon as possible.',
    'Thank you,',
    'SygShift Licensing',
  ].join('\n\n')

  const mutation = useMutation({
    mutationFn: recordLicensingCommunication,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['licensing-center'], refetchType: 'active' })
    },
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    mutation.mutate({
      body: String(form.get('body') ?? '').trim(),
      communicationType: String(form.get('communicationType') ?? 'custom_licensing_email'),
      credentialId: credential.credentialId,
      employeeId: employee.employeeId,
      recipientEmail: String(form.get('recipientEmail') ?? '').trim(),
      subject: String(form.get('subject') ?? '').trim(),
    })
  }

  return (
    <ModalDialog
      busy={mutation.isPending}
      busyLabel="Recording licensing communication..."
      className="modal-dialog--wide"
      description="Preview and record licensing communication. Automated sending can use these records as the approved source."
      onClose={onClose}
      title="Licensing communication"
    >
      <form className="request-form licensing-form" onSubmit={submit}>
        <div className="form-grid form-grid--two">
          <label>
            <span>Message type</span>
            <select name="communicationType">
              <option value="90_day_reminder">90-day reminder</option>
              <option value="60_day_warning">60-day warning</option>
              <option value="30_day_final_warning">30-day final warning</option>
              <option value="expiration_notice">Expiration notice</option>
              <option value="missing_credential">Missing credential notice</option>
              <option value="rejected_document">Rejected document notice</option>
              <option value="custom_licensing_email">Custom licensing email</option>
            </select>
          </label>
          <label><span>Recipient</span><input defaultValue={recipient} name="recipientEmail" required type="email" /></label>
        </div>
        <label className="field-stack"><span>Subject</span><input defaultValue={subject} name="subject" required /></label>
        <label className="field-stack"><span>Message preview</span><textarea defaultValue={body} name="body" required rows={9} /></label>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">Close</button>
          <button className="primary-action" disabled={mutation.isPending} type="submit">
            <Mail aria-hidden="true" size={17} />
            {mutation.isPending ? 'Recording...' : 'Record communication'}
          </button>
        </div>
        {mutation.isSuccess ? <div className="form-feedback form-feedback--success" role="status">Communication recorded in licensing history.</div> : null}
        {mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}
      </form>
    </ModalDialog>
  )
}

function EmployeeLicensingProfile({
  canCommunicate,
  canEditCredentials,
  canManageEmployeeProfile,
  center,
  employee,
  onClose,
  onEditEmployee,
}: {
  canCommunicate: boolean
  canEditCredentials: boolean
  canManageEmployeeProfile: boolean
  center: LicensingCenter
  employee: LicensingEmployee
  onClose: () => void
  onEditEmployee: (employee: LicensingEmployee) => void
}) {
  const [editingCredentialTypeId, setEditingCredentialTypeId] = useState<string | null>(null)
  const [communicatingCredentialTypeId, setCommunicatingCredentialTypeId] = useState<string | null>(null)
  const [viewingDocumentCredentialTypeId, setViewingDocumentCredentialTypeId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<ProfileTab>('credentials')
  const credentialChoices = useMemo(() => {
    const existingTypeIds = new Set(employee.credentials.map((credential) => credential.credentialTypeId))
    const readyToAdd = center.credentialTypes
      .filter((type) => type.active && !existingTypeIds.has(type.id))
      .map((type) => credentialTemplateFromType(type))
    return [...employee.credentials, ...readyToAdd].sort((left, right) => {
      const leftMissing = !left.credentialId || left.complianceColor === 'red'
      const rightMissing = !right.credentialId || right.complianceColor === 'red'
      if (leftMissing !== rightMissing) return leftMissing ? -1 : 1
      return left.credentialName.localeCompare(right.credentialName)
    })
  }, [center.credentialTypes, employee.credentials])
  const editingCredential = editingCredentialTypeId
    ? credentialChoices.find((credential) => credential.credentialTypeId === editingCredentialTypeId) ?? null
    : null
  const communicatingCredential = communicatingCredentialTypeId
    ? credentialChoices.find((credential) => credential.credentialTypeId === communicatingCredentialTypeId) ?? null
    : null
  const viewingDocumentCredential = viewingDocumentCredentialTypeId
    ? credentialChoices.find((credential) => credential.credentialTypeId === viewingDocumentCredentialTypeId) ?? null
    : null
  const firstAction = employee.credentials.find((credential) => credential.complianceColor === 'red')
    ?? employee.credentials.find((credential) => credential.complianceColor === 'yellow')
  const credentialsOnFile = credentialChoices.filter((credential) => credential.credentialId)
  const credentialsAvailable = credentialChoices.filter((credential) => !credential.credentialId)
  const firstCredential = firstAction ?? credentialsOnFile[0] ?? credentialsAvailable[0] ?? null
  const [expandedCredentialTypeId, setExpandedCredentialTypeId] = useState(firstCredential?.credentialTypeId ?? '')

  useEffect(() => {
    if (credentialChoices.length === 0) {
      if (expandedCredentialTypeId) setExpandedCredentialTypeId('')
      return
    }

    const selectionStillExists = credentialChoices.some((credential) => credential.credentialTypeId === expandedCredentialTypeId)
    if (!selectionStillExists) {
      setExpandedCredentialTypeId(firstCredential?.credentialTypeId ?? credentialChoices[0].credentialTypeId)
    }
  }, [credentialChoices, expandedCredentialTypeId, firstCredential?.credentialTypeId])

  function openCredentialEditor(credentialTypeId: string | null | undefined = firstCredential?.credentialTypeId) {
    if (!canEditCredentials) return
    const targetCredential = credentialChoices.find((credential) => credential.credentialTypeId === credentialTypeId)
      ?? credentialsAvailable[0]
      ?? firstCredential
    if (!targetCredential) return
    setExpandedCredentialTypeId(targetCredential.credentialTypeId)
    setEditingCredentialTypeId(targetCredential.credentialTypeId)
  }

  function renderCredential(credential: LicensingCredential) {
    const isExpanded = expandedCredentialTypeId === credential.credentialTypeId
    return (
      <article className={`licensing-credential-accordion licensing-credential-accordion--${credential.complianceColor}`} key={credential.credentialTypeId}>
        <button
          aria-expanded={isExpanded}
          className="licensing-credential-accordion__trigger"
          onClick={() => setExpandedCredentialTypeId(isExpanded ? '' : credential.credentialTypeId)}
          type="button"
        >
          <span className="licensing-credential-accordion__identity">
            <strong>{credentialDisplayName(credential)}</strong>
            <small>
              {credential.credentialNumber || (credential.credentialId ? 'Number not recorded' : 'Not on file')}
              {credential.expirationDate ? ` | Expires ${formatDate(credential.expirationDate)}` : ''}
            </small>
          </span>
          <span className="licensing-credential-accordion__state">
            <CredentialStatusPill color={credential.complianceColor} label={credential.credentialId ? credential.statusLabel : 'Available to add'} />
            <ChevronDown aria-hidden="true" className={isExpanded ? 'is-open' : ''} size={19} />
          </span>
        </button>
        {isExpanded ? (
          <div className="licensing-credential-accordion__body">
            <dl className="licensing-selected-credential__details">
              <div><dt>Credential number</dt><dd>{credential.credentialNumber || 'Not recorded'}</dd></div>
              <div><dt>Issuing authority</dt><dd>{credential.issuingAuthority || 'Not recorded'}</dd></div>
              <div><dt>Issue date</dt><dd>{formatDate(credential.issueDate)}</dd></div>
              <div><dt>Expiration</dt><dd>{formatDate(credential.expirationDate)}</dd></div>
              <div><dt>Days remaining</dt><dd>{credential.daysRemaining ?? '—'}</dd></div>
              <div><dt>Renewal status</dt><dd>{(credential.renewalStatus ?? 'not_started').replaceAll('_', ' ')}</dd></div>
              <div><dt>Documents</dt><dd>{credential.documentCount}</dd></div>
              <div><dt>Last employee notice</dt><dd>{formatTimestamp(credential.lastEmployeeNotification)}</dd></div>
            </dl>
            {credential.internalNotes ? <p className="licensing-credential-note"><strong>Internal note:</strong> {credential.internalNotes}</p> : null}
            {credential.employeeNotes ? <p className="licensing-credential-note"><strong>Employee note:</strong> {credential.employeeNotes}</p> : null}
            {credential.rejectionReason ? <p className="credential-rejection-note">Rejection reason: {credential.rejectionReason}</p> : null}
            {canEditCredentials || (canCommunicate && credential.credentialId) || (credential.credentialId && credential.documentCount > 0) ? (
              <div className="licensing-selected-credential__actions">
                {canEditCredentials ? (
                  <button className="primary-action" onClick={() => openCredentialEditor(credential.credentialTypeId)} type="button">
                    <Pencil aria-hidden="true" size={17} />
                    {credential.credentialId ? 'Manage credential' : 'Add credential'}
                  </button>
                ) : null}
                {credential.credentialId && credential.documentCount > 0 ? (
                  <button className="secondary-button" onClick={() => setViewingDocumentCredentialTypeId(credential.credentialTypeId)} type="button">
                    <Eye aria-hidden="true" size={17} />
                    View documents
                  </button>
                ) : null}
                {canCommunicate && credential.credentialId ? (
                  <button className="secondary-button" onClick={() => setCommunicatingCredentialTypeId(credential.credentialTypeId)} type="button">
                    <Mail aria-hidden="true" size={17} />
                    Record communication
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </article>
    )
  }

  return (
    <section className="licensing-profile-page" aria-label={`Licensing profile for ${legalEmployeeName(employee)}`}>
      <header className="licensing-profile-header">
        <div className="licensing-profile-header__identity">
          <button className="secondary-button secondary-button--small" onClick={onClose} type="button">
            <ChevronLeft aria-hidden="true" size={17} /> Back to worklist
          </button>
          <div>
            <span className="eyebrow">Employee licensing profile</span>
            <h1>{legalEmployeeName(employee)}</h1>
            <p>
              {employee.employeeNumber ?? 'ID pending'} | @{employee.username} | {employee.jobTitle || formatRole(employee.role)} | {employmentStatusLabels[employee.employmentStatus]}
            </p>
          </div>
        </div>
        <div className="licensing-profile-header__actions">
          <CredentialStatusPill color={employee.overallCompliance} label={complianceLabels[employee.overallCompliance]} />
          <span className={`work-eligibility work-eligibility--${employee.workEligibility}`}>{formatEligibility(employee.workEligibility)}</span>
          {canEditCredentials && credentialsAvailable[0] ? (
            <button className="primary-action" onClick={() => openCredentialEditor(credentialsAvailable[0].credentialTypeId)} type="button">
              <FileText aria-hidden="true" size={17} /> Add credential
            </button>
          ) : null}
          {canManageEmployeeProfile ? (
            <button className="secondary-button" onClick={() => onEditEmployee(employee)} type="button">
              <Pencil aria-hidden="true" size={17} /> Edit employee
            </button>
          ) : null}
        </div>
      </header>

      <section className="licensing-profile-summary" aria-label="Credential summary">
        <article><span>Required</span><strong>{employee.requiredCredentialCount}</strong></article>
        <article><span>Verified</span><strong>{employee.verifiedCredentialCount}</strong></article>
        <article><span>Missing</span><strong>{employee.missingCredentialCount}</strong></article>
        <article><span>Closest expiration</span><strong>{formatDate(employee.closestExpirationDate)}</strong></article>
        <article><span>Future shifts affected</span><strong>{employee.affectedFutureShiftCount}</strong></article>
        <article><span>Last communication</span><strong>{formatTimestamp(employee.lastEmployeeNotification)}</strong></article>
      </section>

      {firstAction ? (
        <section className={`licensing-alert licensing-alert--${firstAction.complianceColor}`}>
          <AlertTriangle aria-hidden="true" size={20} />
          <div><strong>Recommended next action: {credentialDisplayName(firstAction)}</strong><span>{firstAction.statusLabel}</span></div>
          {canEditCredentials ? <button className="secondary-button secondary-button--small" onClick={() => openCredentialEditor(firstAction.credentialTypeId)} type="button">Work this item</button> : null}
        </section>
      ) : (
        <section className="licensing-alert licensing-alert--green">
          <BadgeCheck aria-hidden="true" size={20} />
          <div><strong>No immediate licensing action is required.</strong><span>Review renewals and documents as needed.</span></div>
        </section>
      )}

      <nav className="licensing-profile-tabs" aria-label="Licensing profile sections">
        {([
          ['credentials', 'Credentials'],
          ['renewals', 'Renewals'],
          ['activity', 'Documents & Activity'],
        ] as Array<[ProfileTab, string]>).map(([tab, label]) => (
          <button aria-current={activeTab === tab ? 'page' : undefined} className={activeTab === tab ? 'is-active' : ''} key={tab} onClick={() => setActiveTab(tab)} type="button">{label}</button>
        ))}
      </nav>

      {activeTab === 'credentials' ? (
        <section className="licensing-profile-tab-panel">
          <div className="licensing-profile-tab-panel__heading"><div><h2>Credentials on file</h2><p>Open one record at a time to review or update it.</p></div><strong>{credentialsOnFile.length}</strong></div>
          {credentialsOnFile.length > 0 ? (
            <div className="licensing-credential-accordion-list">
              {credentialsOnFile.filter((credential) => isGuardLicenseCode(credential.credentialTypeCode)).length > 0 ? (
                <section className="licensing-credential-group"><span className="eyebrow">Guard license package</span>{credentialsOnFile.filter((credential) => isGuardLicenseCode(credential.credentialTypeCode)).map(renderCredential)}</section>
              ) : null}
              {credentialsOnFile.filter((credential) => !isGuardLicenseCode(credential.credentialTypeCode)).length > 0 ? (
                <section className="licensing-credential-group"><span className="eyebrow">Other credentials</span>{credentialsOnFile.filter((credential) => !isGuardLicenseCode(credential.credentialTypeCode)).map(renderCredential)}</section>
              ) : null}
            </div>
          ) : <div className="licensing-empty"><ClipboardCheck aria-hidden="true" size={26} /><strong>No credentials are on file.</strong><span>Use Add credential to create the first record.</span></div>}
          {credentialsAvailable.length > 0 ? (
            <details className="licensing-available-credentials">
              <summary>Available and missing credential types <span>{credentialsAvailable.length}</span></summary>
              <div className="licensing-credential-accordion-list">{credentialsAvailable.map(renderCredential)}</div>
            </details>
          ) : null}
        </section>
      ) : null}

      {activeTab === 'renewals' ? (
        <section className="licensing-profile-tab-panel">
          <div className="licensing-profile-tab-panel__heading"><div><h2>Renewal work</h2><p>Current renewal state and expiration timing for each credential.</p></div><strong>{activeCredentialRenewalCount(employee.credentials)} active</strong></div>
          <div className="licensing-renewal-list">
            {credentialsOnFile.slice().sort((left, right) => (left.daysRemaining ?? Number.MAX_SAFE_INTEGER) - (right.daysRemaining ?? Number.MAX_SAFE_INTEGER)).map((credential) => (
              <article key={credential.credentialTypeId}>
                <div><strong>{credentialDisplayName(credential)}</strong><span>{credential.credentialNumber || 'Number not recorded'}</span></div>
                <div><span>Expiration</span><strong>{formatDate(credential.expirationDate)}</strong></div>
                <div><span>Renewal</span><strong>{(credential.renewalStatus ?? 'not_started').replaceAll('_', ' ')}</strong></div>
                {canEditCredentials ? <button className="secondary-button secondary-button--small" onClick={() => openCredentialEditor(credential.credentialTypeId)} type="button">Manage</button> : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {activeTab === 'activity' ? (
        <section className="licensing-profile-tab-panel">
          <div className="licensing-profile-tab-panel__heading"><div><h2>Documents &amp; activity</h2><p>Document totals and the latest recorded employee communication by credential.</p></div></div>
          <div className="licensing-activity-list">
            {credentialsOnFile.map((credential) => (
              <article key={credential.credentialTypeId}>
                <div><strong>{credentialDisplayName(credential)}</strong><CredentialStatusPill color={credential.complianceColor} label={credential.statusLabel} /></div>
                <dl><div><dt>Documents</dt><dd>{credential.documentCount}</dd></div><div><dt>Latest upload</dt><dd>{formatTimestamp(credential.latestDocumentAt)}</dd></div><div><dt>Last notice</dt><dd>{formatTimestamp(credential.lastEmployeeNotification)}</dd></div></dl>
                <div className="licensing-selected-credential__actions">
                  {canEditCredentials ? <button className="secondary-button secondary-button--small" onClick={() => openCredentialEditor(credential.credentialTypeId)} type="button"><Upload aria-hidden="true" size={15} /> Manage documents</button> : null}
                  {credential.documentCount > 0 ? <button className="secondary-button secondary-button--small" onClick={() => setViewingDocumentCredentialTypeId(credential.credentialTypeId)} type="button"><Eye aria-hidden="true" size={15} /> View documents</button> : null}
                  {canCommunicate ? <button className="secondary-button secondary-button--small" onClick={() => setCommunicatingCredentialTypeId(credential.credentialTypeId)} type="button"><Mail aria-hidden="true" size={15} /> Record communication</button> : null}
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {canEditCredentials && editingCredential ? (
        <CredentialEditModal
          credential={editingCredential}
          credentialTypes={center.credentialTypes}
          employee={employee}
          key={`${employee.employeeId}-${editingCredential.credentialTypeId}-${editingCredential.credentialId ?? 'missing'}-${editingCredential.status}-${editingCredential.credentialNumber ?? ''}-${editingCredential.expirationDate ?? ''}`}
          onClose={() => setEditingCredentialTypeId(null)}
        />
      ) : null}
      {canCommunicate && communicatingCredential ? (
        <CommunicationModal
          credential={communicatingCredential}
          employee={employee}
          onClose={() => setCommunicatingCredentialTypeId(null)}
        />
      ) : null}
      {viewingDocumentCredential?.credentialId ? (
        <CredentialDocumentsModal credential={viewingDocumentCredential} onClose={() => setViewingDocumentCredentialTypeId(null)} />
      ) : null}
    </section>
  )
}

export function LicensingCenterPage() {
  const [summaryFilter, setSummaryFilter] = useState<SummaryFilter>('all')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [credentialTypeFilter, setCredentialTypeFilter] = useState('all')
  const [employmentStatusFilter, setEmploymentStatusFilter] = useState<'all' | LicensingEmployee['employmentStatus']>('active')
  const [eligibilityFilter, setEligibilityFilter] = useState<EligibilityFilter>('all')
  const [expirationFilter, setExpirationFilter] = useState<ExpirationFilter>('all')
  const [sortBy, setSortBy] = useState<WorklistSort>('employee')
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null)
  const [employeeBeingEditedId, setEmployeeBeingEditedId] = useState<string | null | 'new'>(null)

  const centerQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: getLicensingCenter,
    queryKey: ['licensing-center'],
  })
  const sessionQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: getSessionContext,
    queryKey: ['session-context'],
  })

  const visibleEmployees = useMemo(() => {
    const term = normalized(search.trim())
    const matching = (centerQuery.data?.employees ?? []).filter((employee) => {
      const searchable = [
        legalEmployeeName(employee),
        employee.username,
        employee.employeeNumber,
        employee.jobTitle,
        ...employee.credentials.flatMap((credential) => [
          credentialDisplayName(credential),
          credential.credentialName,
          credential.credentialNumber,
          credential.status,
          credential.statusLabel,
        ]),
      ].map(normalized).join(' ')
      return employeeMatchesSummary(employee, summaryFilter)
        && employeeMatchesStatus(employee, statusFilter)
        && (credentialTypeFilter === 'all' || employee.credentials.some((credential) => credential.credentialTypeId === credentialTypeFilter))
        && (employmentStatusFilter === 'all' || employee.employmentStatus === employmentStatusFilter)
        && employeeMatchesEligibility(employee, eligibilityFilter)
        && employeeMatchesExpiration(employee, expirationFilter)
        && (!term || searchable.includes(term))
    })
    return matching.sort((left, right) => {
      if (sortBy === 'expiration') {
        return (left.closestExpirationDate ?? '9999-12-31').localeCompare(right.closestExpirationDate ?? '9999-12-31')
          || legalEmployeeName(left).localeCompare(legalEmployeeName(right))
      }
      if (sortBy === 'status') {
        return statusRank(left.overallCompliance) - statusRank(right.overallCompliance)
          || legalEmployeeName(left).localeCompare(legalEmployeeName(right))
      }
      if (sortBy === 'eligibility') {
        return formatEligibility(left.workEligibility).localeCompare(formatEligibility(right.workEligibility))
          || legalEmployeeName(left).localeCompare(legalEmployeeName(right))
      }
      return legalEmployeeName(left).localeCompare(legalEmployeeName(right))
    })
  }, [centerQuery.data?.employees, credentialTypeFilter, eligibilityFilter, employmentStatusFilter, expirationFilter, search, sortBy, statusFilter, summaryFilter])

  if (!isSupabaseConfigured) {
    return (
      <div className="page page--licensing">
        <DataStatePanel icon={ShieldAlert} title="Licensing Center needs the secure data connection" tone="setup">
          <p>Licensing records stay protected until Supabase is configured.</p>
        </DataStatePanel>
      </div>
    )
  }

  if (centerQuery.isPending) {
    return (
      <div className="page page--licensing">
        <DataStatePanel icon={ClipboardCheck} title="Loading Licensing Center">
          <p>Checking MFA, role permissions, credential records, and compliance status.</p>
        </DataStatePanel>
      </div>
    )
  }

  if (centerQuery.isError) {
    return (
      <div className="page page--licensing">
        <DataStatePanel icon={ShieldAlert} title="Licensing Center unavailable" tone="error">
          <p>{centerQuery.error.message}</p>
          <p>Sign in as an administrator or Recruiting and Licensing Coordinator with MFA.</p>
        </DataStatePanel>
      </div>
    )
  }

  const center = centerQuery.data
  const canEditCredentials = center.permissions.canManage
    || Boolean(sessionQuery.data?.permissions.includes('directory.edit_credentials'))
  const selectedEmployee = selectedEmployeeId
    ? center.employees.find((employee) => employee.employeeId === selectedEmployeeId) ?? null
    : null
  const employeeBeingEdited = employeeBeingEditedId && employeeBeingEditedId !== 'new'
    ? center.employees.find((employee) => employee.employeeId === employeeBeingEditedId) ?? null
    : null

  const workingEmployees = center.employees.filter((employee) => employee.employmentStatus === 'active')
  const needsActionCount = workingEmployees.filter((employee) => employeeMatchesSummary(employee, 'needsAction')).length
  const dueSoonCount = workingEmployees.filter((employee) => employeeMatchesSummary(employee, 'dueSoon')).length
  const awaitingReviewCount = workingEmployees.filter((employee) => employeeMatchesSummary(employee, 'awaitingReview')).length
  const filtersAreActive = summaryFilter !== 'all'
    || search.trim() !== ''
    || statusFilter !== 'all'
    || credentialTypeFilter !== 'all'
    || employmentStatusFilter !== 'active'
    || eligibilityFilter !== 'all'
    || expirationFilter !== 'all'

  function clearFilters() {
    setSummaryFilter('all')
    setSearch('')
    setStatusFilter('all')
    setCredentialTypeFilter('all')
    setEmploymentStatusFilter('active')
    setEligibilityFilter('all')
    setExpirationFilter('all')
    setSortBy('employee')
  }

  if (selectedEmployee) {
    return (
      <div className="page page--licensing">
        <EmployeeLicensingProfile
          canCommunicate={center.permissions.canCommunicate}
          canEditCredentials={canEditCredentials}
          canManageEmployeeProfile={center.permissions.canManage}
          center={center}
          employee={selectedEmployee}
          onClose={() => setSelectedEmployeeId(null)}
          onEditEmployee={(employee) => setEmployeeBeingEditedId(employee.employeeId)}
        />
        {employeeBeingEdited ? (
          <EmployeeFormModal
            employee={employeeBeingEdited}
            key={`${employeeBeingEdited.employeeId}-${employeeBeingEdited.firstName}-${employeeBeingEdited.lastName}-${employeeBeingEdited.jobTitle ?? ''}-${employeeBeingEdited.employmentStatus}`}
            onClose={() => setEmployeeBeingEditedId(null)}
          />
        ) : null}
      </div>
    )
  }

  return (
    <div className="page page--licensing">
      <section className="page-intro licensing-intro">
        <div>
          <p className="eyebrow">Licensing & Credentials</p>
          <h1>Licensing Center</h1>
          <p className="page-summary">
            Monitor licenses, credentials, renewals, missing documents, and shift eligibility from one controlled workspace.
          </p>
        </div>
        <div className="licensing-intro__actions">
          <div className="access-note">
            <ShieldAlert aria-hidden="true" size={19} />
            Admin or Recruiting & Licensing access with MFA
          </div>
          {center.permissions.canManage ? (
            <button className="primary-action" onClick={() => setEmployeeBeingEditedId('new')} type="button">
              <UserRoundPlus aria-hidden="true" size={17} />
              Add onboarding profile
            </button>
          ) : null}
        </div>
      </section>

      <section className="licensing-priority-grid" aria-label="Priority licensing work">
        {([
          { count: needsActionCount, helper: 'Expired, missing, rejected, or ineligible', key: 'needsAction' as const, label: 'Needs action', tone: 'red' as const },
          { count: dueSoonCount, helper: 'Credential expires within 30 days', key: 'dueSoon' as const, label: 'Due soon', tone: 'yellow' as const },
          { count: awaitingReviewCount, helper: 'Submitted credential needs review', key: 'awaitingReview' as const, label: 'Awaiting review', tone: 'yellow' as const },
        ]).map((card) => (
          <button
            className={[
              'licensing-priority-card',
              `licensing-priority-card--${card.tone}`,
              summaryFilter === card.key ? 'is-active' : '',
            ].filter(Boolean).join(' ')}
            key={card.key}
            onClick={() => setSummaryFilter(summaryFilter === card.key ? 'all' : card.key)}
            type="button"
          >
            <span className="licensing-priority-card__icon">{card.tone === 'red' ? <AlertTriangle aria-hidden="true" size={20} /> : <BellRing aria-hidden="true" size={20} />}</span>
            <span>{card.label}</span>
            <strong>{card.count}</strong>
            <small>{card.helper}</small>
          </button>
        ))}
      </section>

      <details className="licensing-status-details">
        <summary>More status details <ChevronDown aria-hidden="true" size={18} /></summary>
        <div>
          <button className={summaryFilter === 'compliant' ? 'is-active' : ''} onClick={() => setSummaryFilter(summaryFilter === 'compliant' ? 'all' : 'compliant')} type="button"><span>Fully compliant</span><strong>{center.summary.fullyCompliantEmployees}</strong></button>
          <button className={summaryFilter === 'ineligible' ? 'is-active' : ''} onClick={() => setSummaryFilter(summaryFilter === 'ineligible' ? 'all' : 'ineligible')} type="button"><span>Ineligible</span><strong>{center.summary.ineligibleEmployees}</strong></button>
          <button className={summaryFilter === 'missing' ? 'is-active' : ''} onClick={() => setSummaryFilter(summaryFilter === 'missing' ? 'all' : 'missing')} type="button"><span>Missing credentials</span><strong>{center.summary.missingRequired}</strong></button>
          <button className={summaryFilter === 'expired' ? 'is-active' : ''} onClick={() => setSummaryFilter(summaryFilter === 'expired' ? 'all' : 'expired')} type="button"><span>Expired credentials</span><strong>{center.summary.expired}</strong></button>
          <article><span>Expiring in 90 days</span><strong>{center.summary.expiring90}</strong></article>
          <article><span>Expiring in 60 days</span><strong>{center.summary.expiring60}</strong></article>
          <article><span>Expiring in 30 days</span><strong>{center.summary.expiring30}</strong></article>
          <article><span>Renewals in progress</span><strong>{center.summary.renewalsInProgress}</strong></article>
          <article><span>Rejected</span><strong>{center.summary.rejected}</strong></article>
        </div>
      </details>

      <section className="licensing-toolbar licensing-toolbar--compact" aria-label="Licensing filters">
        <div className="licensing-toolbar__primary">
          <label className="search-field search-field--wide">
            <Search aria-hidden="true" size={20} />
            <span className="visually-hidden">Search employees and credentials</span>
            <input onChange={(event) => setSearch(event.target.value)} placeholder="Search legal name, username, employee ID, license number, or credential" type="search" value={search} />
          </label>
          <label className="select-field"><span>Credential status</span><select onChange={(event) => setStatusFilter(event.target.value as StatusFilter)} value={statusFilter}>
            <option value="all">All statuses</option><option value="needsAction">Needs action</option><option value="missing">Missing</option><option value="awaitingReview">Awaiting review</option><option value="verified">Verified</option><option value="expiring">Expiring</option><option value="expired">Expired</option><option value="rejected">Rejected</option><option value="renewal">Renewal in progress</option>
          </select></label>
          <label className="select-field"><span>Credential type</span><select onChange={(event) => setCredentialTypeFilter(event.target.value)} value={credentialTypeFilter}>
            <option value="all">All types</option>
            <optgroup label="Guard license package">{center.credentialTypes.filter((type) => isGuardLicenseCode(type.code)).map((type) => <option key={type.id} value={type.id}>{type.code === 'denver_security_guard_license' ? 'Standard Guard License' : 'Armed Guard License / Endorsement'}</option>)}</optgroup>
            <optgroup label="Other credentials">{center.credentialTypes.filter((type) => !isGuardLicenseCode(type.code)).map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</optgroup>
          </select></label>
          <label className="select-field"><span>Employment</span><select onChange={(event) => setEmploymentStatusFilter(event.target.value as typeof employmentStatusFilter)} value={employmentStatusFilter}>
            <option value="active">Active</option><option value="onboarding">Onboarding</option><option value="leave">On leave</option><option value="inactive">Inactive</option><option value="separated">Separated</option><option value="all">All statuses</option>
          </select></label>
        </div>
        <details className="licensing-more-filters">
          <summary>More filters <ChevronDown aria-hidden="true" size={17} /></summary>
          <div>
            <label className="select-field"><span>Shift eligibility</span><select onChange={(event) => setEligibilityFilter(event.target.value as EligibilityFilter)} value={eligibilityFilter}><option value="all">All eligibility</option><option value="armed">Armed eligible</option><option value="unarmed">Unarmed only</option><option value="ineligible">Ineligible</option></select></label>
            <label className="select-field"><span>Expiration window</span><select onChange={(event) => setExpirationFilter(event.target.value as ExpirationFilter)} value={expirationFilter}><option value="all">Any expiration</option><option value="30">Within 30 days</option><option value="60">Within 60 days</option><option value="90">Within 90 days</option></select></label>
            <label className="select-field"><span>Sort worklist</span><select onChange={(event) => setSortBy(event.target.value as WorklistSort)} value={sortBy}><option value="employee">Employee name</option><option value="expiration">Next expiration</option><option value="status">Overall status</option><option value="eligibility">Shift eligibility</option></select></label>
          </div>
        </details>
        <div className="licensing-toolbar__footer"><span>{visibleEmployees.length} employee{visibleEmployees.length === 1 ? '' : 's'} match</span><button className="secondary-button" disabled={!filtersAreActive} onClick={clearFilters} type="button"><X aria-hidden="true" size={17} /> Clear filters</button></div>
      </section>

      <section className="licensing-table-panel" aria-label="Licensing records">
        <div className="licensing-table-panel__heading">
          <div>
            <h2>Credential worklist</h2>
            <p>Active employees are shown by default. Open a profile only when licensing work is needed.</p>
          </div>
          {summaryFilter !== 'all' ? <CredentialStatusPill color="yellow" label="Summary filter active" /> : null}
        </div>
        <div className="licensing-table" role="table" aria-label="Credential compliance records">
          <div className="licensing-row licensing-row--header" role="row">
            <span role="columnheader">Employee</span>
            <span role="columnheader">Licenses &amp; Credentials</span>
            <span role="columnheader">Next Expiration</span>
            <span role="columnheader">Overall Status</span>
            <span role="columnheader">Shift Eligibility</span>
            <span role="columnheader">Action</span>
          </div>
          {visibleEmployees.map((employee) => {
            const credentialsOnFile = employee.credentials.filter((credential) => credential.credentialId)
            const credentialNames = Array.from(new Set(credentialsOnFile.map(credentialDisplayName)))
            const credentialPreview = credentialNames.length === 0
              ? 'No credentials on file'
              : `${credentialNames.slice(0, 2).join(', ')}${credentialNames.length > 2 ? ` +${credentialNames.length - 2} more` : ''}`
            const missingCount = employee.credentials.filter((credential) => !credential.credentialId && credential.required).length
            const closestExpirationCredential = employee.credentials.find((credential) => (
              credential.expirationDate === employee.closestExpirationDate
            ))
            const renewalCount = activeCredentialRenewalCount(employee.credentials)
            return (
              <div className="licensing-row licensing-row--employee-summary" key={employee.employeeId} role="row">
                <div role="cell">
                  <strong>{legalEmployeeName(employee)}</strong>
                  <span>{employee.employeeNumber ?? 'ID pending'} | @{employee.username} | {employee.jobTitle || formatRole(employee.role)}</span>
                </div>
                <div role="cell">
                  <strong>{credentialsOnFile.length} on file{missingCount > 0 ? ` | ${missingCount} missing` : ''}</strong>
                  <span>{credentialPreview}</span>
                </div>
                <div role="cell">
                  <strong>{formatDate(employee.closestExpirationDate)}</strong>
                  <span>
                    {closestExpirationCredential
                      ? `${credentialDisplayName(closestExpirationCredential)} | ${closestExpirationCredential.daysRemaining} days remaining`
                      : 'No expiration on file'}
                  </span>
                </div>
                <div role="cell"><CredentialStatusPill color={employee.overallCompliance} label={complianceLabels[employee.overallCompliance]} /></div>
                <div role="cell">
                  <span className={`work-eligibility work-eligibility--${employee.workEligibility}`}>
                    {employeeIsArmedEligible(employee) ? 'Armed eligible' : employee.workEligibility === 'ineligible' ? 'Ineligible' : 'Unarmed only'}
                  </span>
                  {renewalCount > 0 ? <span>{renewalCount} renewal{renewalCount === 1 ? '' : 's'} in progress</span> : null}
                </div>
                <div className="licensing-row__actions" role="cell">
                  <button className="secondary-button secondary-button--small" onClick={() => setSelectedEmployeeId(employee.employeeId)} type="button">
                    <FolderOpen aria-hidden="true" size={15} />
                    Open credential profile
                  </button>
                </div>
              </div>
            )
          })}
        </div>
          {visibleEmployees.length === 0 ? (
          <div className="licensing-empty">
            <ClipboardCheck aria-hidden="true" size={26} />
            <strong>No licensing records match these filters.</strong>
            <span>Clear filters or choose a different summary card.</span>
          </div>
        ) : null}
      </section>

      {selectedEmployeeId && !selectedEmployee && centerQuery.isFetching ? (
        <ModalDialog
          busy
          busyLabel="Refreshing licensing profile..."
          description="The selected employee record is being refreshed."
          onClose={() => setSelectedEmployeeId(null)}
          title="Refreshing profile"
        >
          <p className="modal-warning">Loading the latest saved licensing information.</p>
        </ModalDialog>
      ) : null}
      {employeeBeingEditedId && employeeBeingEditedId !== 'new' && !employeeBeingEdited && centerQuery.isFetching ? (
        <ModalDialog
          busy
          busyLabel="Refreshing employee profile..."
          description="The employee profile is being refreshed before editing continues."
          onClose={() => setEmployeeBeingEditedId(null)}
          title="Refreshing employee"
        >
          <p className="modal-warning">Loading the latest saved employee information.</p>
        </ModalDialog>
      ) : null}
      {employeeBeingEditedId === 'new' || employeeBeingEdited ? (
        <EmployeeFormModal
          employee={employeeBeingEditedId === 'new' ? undefined : employeeBeingEdited ?? undefined}
          key={employeeBeingEditedId === 'new' ? 'new' : `${employeeBeingEdited?.employeeId}-${employeeBeingEdited?.displayName}-${employeeBeingEdited?.jobTitle ?? ''}-${employeeBeingEdited?.employmentStatus ?? ''}`}
          onClose={() => setEmployeeBeingEditedId(null)}
        />
      ) : null}
    </div>
  )
}
