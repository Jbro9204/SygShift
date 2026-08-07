import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  BadgeCheck,
  BellRing,
  ClipboardCheck,
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
import { ModalDialog } from '../components/ModalDialog'
import {
  formatEligibility,
  formatRole,
  getLicensingCenter,
  recordLicensingCommunication,
  upsertLicensingCredential,
  upsertLicensingEmployee,
  uploadCredentialDocument,
  type ComplianceColor,
  type CredentialStatus,
  type CredentialType,
  type LicensingCenter,
  type LicensingCredential,
  type LicensingEmployee,
  type LicensingRecord,
  type RenewalStatus,
} from '../data/licensing'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'
import { activeCredentialRenewalCount, groupLicensingRecordsByEmployee } from '../lib/licensingWorklist'

type SummaryFilter =
  | 'all'
  | 'compliant'
  | 'expiring90'
  | 'expiring60'
  | 'expiring30'
  | 'expired'
  | 'missing'
  | 'awaitingReview'
  | 'rejected'
  | 'renewals'
  | 'ineligible'

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

const summaryCards: Array<{
  key: SummaryFilter
  label: string
  helper: string
  tone: ComplianceColor
  value: keyof LicensingCenter['summary']
}> = [
  { helper: 'No immediate licensing action required', key: 'compliant', label: 'Fully compliant employees', tone: 'green', value: 'fullyCompliantEmployees' },
  { helper: 'Early renewal window', key: 'expiring90', label: 'Expiring within 90 days', tone: 'yellow', value: 'expiring90' },
  { helper: 'Follow-up window', key: 'expiring60', label: 'Expiring within 60 days', tone: 'yellow', value: 'expiring60' },
  { helper: 'Final warning window', key: 'expiring30', label: 'Expiring within 30 days', tone: 'red', value: 'expiring30' },
  { helper: 'Past expiration date', key: 'expired', label: 'Expired credentials', tone: 'red', value: 'expired' },
  { helper: 'Required but not on file', key: 'missing', label: 'Missing required credentials', tone: 'red', value: 'missingRequired' },
  { helper: 'Submitted or pending review', key: 'awaitingReview', label: 'Awaiting review', tone: 'yellow', value: 'awaitingReview' },
  { helper: 'Rejected or invalid documents', key: 'rejected', label: 'Rejected credentials', tone: 'red', value: 'rejected' },
  { helper: 'Renewal started or submitted', key: 'renewals', label: 'Renewals in progress', tone: 'yellow', value: 'renewalsInProgress' },
  { helper: 'Cannot work required assignments', key: 'ineligible', label: 'Ineligible employees', tone: 'red', value: 'ineligibleEmployees' },
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

function recordMatchesSummary(record: LicensingRecord, employee: LicensingEmployee | undefined, filter: SummaryFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'compliant') return employee?.overallCompliance === 'green'
  if (filter === 'expiring90') return typeof record.daysRemaining === 'number' && record.daysRemaining >= 61 && record.daysRemaining <= 90
  if (filter === 'expiring60') return typeof record.daysRemaining === 'number' && record.daysRemaining >= 31 && record.daysRemaining <= 60
  if (filter === 'expiring30') return typeof record.daysRemaining === 'number' && record.daysRemaining >= 0 && record.daysRemaining <= 30
  if (filter === 'expired') return record.statusLabel === 'Expired'
  if (filter === 'missing') return record.statusLabel === 'Missing Required Credential'
  if (filter === 'awaitingReview') return record.status === 'Under Review'
  if (filter === 'rejected') return record.status === 'Rejected'
  if (filter === 'renewals') return record.status === 'Renewal In Progress' || record.status === 'Renewal Submitted'
  if (filter === 'ineligible') return employee?.workEligibility === 'ineligible'
  return true
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

function CredentialChoiceOptions({ credentials }: { credentials: LicensingCredential[] }) {
  const guardLicenses = credentials.filter((credential) => isGuardLicenseCode(credential.credentialTypeCode))
  const otherCredentials = credentials.filter((credential) => !isGuardLicenseCode(credential.credentialTypeCode))
  const option = (credential: LicensingCredential) => (
    <option key={credential.credentialTypeId} value={credential.credentialTypeId}>
      {credentialDisplayName(credential)} - {credential.credentialId ? credential.statusLabel : 'Add new'}
    </option>
  )

  return (
    <>
      {guardLicenses.length > 0 ? <optgroup label="Guard Licenses">{guardLicenses.map(option)}</optgroup> : null}
      {otherCredentials.length > 0 ? <optgroup label="Other Credentials">{otherCredentials.map(option)}</optgroup> : null}
    </>
  )
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
  const selectedType = credentialTypes.find((type) => type.id === credential.credentialTypeId)

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
    mutationFn: uploadCredentialDocument,
    onSuccess: async () => {
      setSelectedFile(null)
      await queryClient.invalidateQueries({ queryKey: ['licensing-center'], refetchType: 'active' })
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
    documentMutation.mutate({
      credentialId: currentCredentialId,
      employeeId: employee.employeeId,
      file: selectedFile,
    })
  }

  return (
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
        <div>
          <strong>Credential documents</strong>
          <span>{credential.documentCount} active document{credential.documentCount === 1 ? '' : 's'} on file</span>
        </div>
        <label className="file-picker">
          <Upload aria-hidden="true" size={17} />
          <span>{selectedFile ? selectedFile.name : 'Choose document'}</span>
          <input
            accept=".pdf,image/*"
            onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
            type="file"
          />
        </label>
        <button className="secondary-button" disabled={!selectedFile || !currentCredentialId || documentMutation.isPending} onClick={uploadDocument} type="button">
          <Upload aria-hidden="true" size={17} />
          {documentMutation.isPending ? 'Uploading...' : 'Upload document'}
        </button>
        {!currentCredentialId ? <p className="form-note">Save the credential first, then attach documents.</p> : null}
        {documentMutation.isSuccess ? <div className="form-feedback form-feedback--success" role="status">Document uploaded and retained in credential history.</div> : null}
        {documentMutation.isError ? <div className="inline-alert" role="alert">{documentMutation.error.message}</div> : null}
      </section>
    </ModalDialog>
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
  center,
  employee,
  onClose,
  onEditEmployee,
}: {
  center: LicensingCenter
  employee: LicensingEmployee
  onClose: () => void
  onEditEmployee: (employee: LicensingEmployee) => void
}) {
  const [editingCredentialTypeId, setEditingCredentialTypeId] = useState<string | null>(null)
  const [communicatingCredentialTypeId, setCommunicatingCredentialTypeId] = useState<string | null>(null)
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
  const firstAction = employee.credentials.find((credential) => credential.complianceColor === 'red')
    ?? employee.credentials.find((credential) => credential.complianceColor === 'yellow')
  const addCredentialTarget = credentialChoices.find((credential) => !credential.credentialId)
    ?? firstAction
    ?? credentialChoices[0]
    ?? null
  const [selectedCredentialTypeId, setSelectedCredentialTypeId] = useState(firstAction?.credentialTypeId ?? addCredentialTarget?.credentialTypeId ?? '')
  const selectedCredential = credentialChoices.find((credential) => credential.credentialTypeId === selectedCredentialTypeId)
    ?? firstAction
    ?? credentialChoices[0]
    ?? null

  useEffect(() => {
    if (credentialChoices.length === 0) {
      if (selectedCredentialTypeId) setSelectedCredentialTypeId('')
      return
    }

    const selectionStillExists = credentialChoices.some((credential) => credential.credentialTypeId === selectedCredentialTypeId)
    if (!selectionStillExists) {
      setSelectedCredentialTypeId(firstAction?.credentialTypeId ?? addCredentialTarget?.credentialTypeId ?? credentialChoices[0].credentialTypeId)
    }
  }, [addCredentialTarget?.credentialTypeId, credentialChoices, firstAction?.credentialTypeId, selectedCredentialTypeId])

  function openCredentialEditor(credentialTypeId: string | null | undefined = selectedCredential?.credentialTypeId) {
    const targetCredential = credentialChoices.find((credential) => credential.credentialTypeId === credentialTypeId)
      ?? addCredentialTarget
    if (!targetCredential) return
    setSelectedCredentialTypeId(targetCredential.credentialTypeId)
    setEditingCredentialTypeId(targetCredential.credentialTypeId)
  }

  return (
    <ModalDialog
      className="modal-dialog--licensing-profile"
      description={`${employee.employeeNumber ?? 'ID pending'} • @${employee.username}`}
      onClose={onClose}
      title={`Licensing profile - ${employee.displayName}`}
    >
      <section className="licensing-profile-summary">
        <article className={`licensing-profile-summary__status licensing-profile-summary__status--${employee.overallCompliance}`}>
          <span>Overall status</span>
          <strong>{complianceLabels[employee.overallCompliance]}</strong>
        </article>
        <article>
          <span>Shift eligibility</span>
          <strong>{formatEligibility(employee.workEligibility)}</strong>
        </article>
        <article>
          <span>Required</span>
          <strong>{employee.requiredCredentialCount}</strong>
        </article>
        <article>
          <span>Verified</span>
          <strong>{employee.verifiedCredentialCount}</strong>
        </article>
        <article>
          <span>Missing</span>
          <strong>{employee.missingCredentialCount}</strong>
        </article>
        <article>
          <span>Closest expiration</span>
          <strong>{formatDate(employee.closestExpirationDate)}</strong>
        </article>
      </section>

      <section className="licensing-profile-context">
        <div>
          <span>Position</span>
          <strong>{employee.jobTitle || formatRole(employee.role)}</strong>
        </div>
        <div>
          <span>Status</span>
          <strong>{employmentStatusLabels[employee.employmentStatus]}</strong>
        </div>
        <div>
          <span>Future shifts affected</span>
          <strong>{employee.affectedFutureShiftCount}</strong>
        </div>
        <div>
          <span>Last communication</span>
          <strong>{formatTimestamp(employee.lastEmployeeNotification)}</strong>
        </div>
      </section>

      {firstAction ? (
        <section className={`licensing-alert licensing-alert--${firstAction.complianceColor}`}>
          <AlertTriangle aria-hidden="true" size={20} />
          <div>
            <strong>Top action: {credentialDisplayName(firstAction)}</strong>
            <span>{firstAction.statusLabel}</span>
          </div>
        </section>
      ) : null}

      <div className="licensing-profile-actions">
        <button className="primary-action" disabled={!addCredentialTarget} onClick={() => openCredentialEditor(addCredentialTarget?.credentialTypeId)} type="button">
          <FileText aria-hidden="true" size={17} />
          Add credential / license
        </button>
        <button className="secondary-button" onClick={() => onEditEmployee(employee)} type="button">
          <Pencil aria-hidden="true" size={17} />
          Edit employee profile
        </button>
      </div>

      <section className="licensing-add-credential-panel" aria-label="Add credential or license">
        <div>
          <span className="eyebrow">Add or update</span>
          <h3>Add credential / license</h3>
          <p>
            Choose the license or credential type, then open the form to add numbers, dates, notes,
            and supporting documents.
          </p>
        </div>
        <label className="select-field">
          <span>Choose credential/license</span>
          <select
            disabled={credentialChoices.length === 0}
            onChange={(event) => setSelectedCredentialTypeId(event.target.value)}
            value={selectedCredential?.credentialTypeId ?? ''}
          >
            <CredentialChoiceOptions credentials={credentialChoices} />
          </select>
        </label>
        <button className="primary-action" disabled={!selectedCredential} onClick={() => openCredentialEditor()} type="button">
          <FileText aria-hidden="true" size={17} />
          Open add/update form
        </button>
      </section>

      <section className="licensing-credential-workspace" aria-label="Employee credential workspace">
        <div className="licensing-credential-picker">
          <div>
            <span className="eyebrow">Review records</span>
            <h3>Credential/license records</h3>
            <p>Select any existing or missing record to review the current status before editing.</p>
          </div>
          <label className="select-field">
            <span>Credential or license</span>
            <select
              onChange={(event) => setSelectedCredentialTypeId(event.target.value)}
              value={selectedCredential?.credentialTypeId ?? ''}
            >
              <CredentialChoiceOptions credentials={credentialChoices} />
            </select>
          </label>
          <div className="licensing-credential-picker-list" aria-label="Credential quick pick list">
            {credentialChoices.map((credential) => (
              <button
                className={[
                  'licensing-credential-picker-row',
                  `licensing-credential-picker-row--${credential.complianceColor}`,
                  selectedCredential?.credentialTypeId === credential.credentialTypeId ? 'is-active' : '',
                ].filter(Boolean).join(' ')}
                key={credential.credentialTypeId}
                onClick={() => setSelectedCredentialTypeId(credential.credentialTypeId)}
                type="button"
              >
                <span>{credentialDisplayName(credential)}</span>
                <CredentialStatusPill color={credential.complianceColor} label={credential.credentialId ? credential.statusLabel : 'Add new'} />
              </button>
            ))}
          </div>
        </div>

        <article className={`licensing-selected-credential licensing-selected-credential--${selectedCredential?.complianceColor ?? 'gray'}`}>
          {selectedCredential ? (
            <>
              <div className="licensing-selected-credential__heading">
                <div>
                  <span>{isGuardLicenseCode(selectedCredential.credentialTypeCode) ? 'Guard Licenses' : selectedCredential.category}</span>
                  <h3>{credentialDisplayName(selectedCredential)}</h3>
                </div>
                <CredentialStatusPill color={selectedCredential.complianceColor} label={selectedCredential.statusLabel} />
              </div>
              <dl className="licensing-selected-credential__details">
                <div><dt>Credential #</dt><dd>{selectedCredential.credentialNumber || '—'}</dd></div>
                <div><dt>Issuing authority</dt><dd>{selectedCredential.issuingAuthority || '—'}</dd></div>
                <div><dt>Issue date</dt><dd>{formatDate(selectedCredential.issueDate)}</dd></div>
                <div><dt>Expiration</dt><dd>{formatDate(selectedCredential.expirationDate)}</dd></div>
                <div><dt>Days remaining</dt><dd>{selectedCredential.daysRemaining ?? '—'}</dd></div>
                <div><dt>Renewal</dt><dd>{selectedCredential.renewalStatus?.replaceAll('_', ' ') ?? '—'}</dd></div>
                <div><dt>Documents</dt><dd>{selectedCredential.documentCount}</dd></div>
                <div><dt>Last notice</dt><dd>{formatTimestamp(selectedCredential.lastEmployeeNotification)}</dd></div>
              </dl>
              {selectedCredential.rejectionReason ? <p className="credential-rejection-note">{selectedCredential.rejectionReason}</p> : null}
              <div className="licensing-selected-credential__actions">
                <button className="primary-action" onClick={() => setEditingCredentialTypeId(selectedCredential.credentialTypeId)} type="button">
                  <Pencil aria-hidden="true" size={17} />
                  {selectedCredential.credentialId ? 'Manage selected credential' : 'Add this credential/license'}
                </button>
                {selectedCredential.credentialId ? (
                  <button className="secondary-button" onClick={() => setCommunicatingCredentialTypeId(selectedCredential.credentialTypeId)} type="button">
                    <Mail aria-hidden="true" size={17} />
                    Message about credential
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <div className="licensing-empty">
              <ClipboardCheck aria-hidden="true" size={26} />
              <strong>No credential types are available.</strong>
              <span>Add an active credential type before adding documents or expiration details.</span>
            </div>
          )}
        </article>

      </section>

      {editingCredential ? (
        <CredentialEditModal
          credential={editingCredential}
          credentialTypes={center.credentialTypes}
          employee={employee}
          key={`${employee.employeeId}-${editingCredential.credentialTypeId}-${editingCredential.credentialId ?? 'missing'}-${editingCredential.status}-${editingCredential.credentialNumber ?? ''}-${editingCredential.expirationDate ?? ''}`}
          onClose={() => setEditingCredentialTypeId(null)}
        />
      ) : null}
      {communicatingCredential ? (
        <CommunicationModal
          credential={communicatingCredential}
          employee={employee}
          onClose={() => setCommunicatingCredentialTypeId(null)}
        />
      ) : null}
    </ModalDialog>
  )
}

export function LicensingCenterPage() {
  const [summaryFilter, setSummaryFilter] = useState<SummaryFilter>('all')
  const [search, setSearch] = useState('')
  const [complianceFilter, setComplianceFilter] = useState<'all' | ComplianceColor>('all')
  const [credentialTypeFilter, setCredentialTypeFilter] = useState('all')
  const [employmentStatusFilter, setEmploymentStatusFilter] = useState<'all' | LicensingEmployee['employmentStatus']>('all')
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null)
  const [employeeBeingEditedId, setEmployeeBeingEditedId] = useState<string | null | 'new'>(null)

  const centerQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: getLicensingCenter,
    queryKey: ['licensing-center'],
  })

  const employeeById = useMemo(() => new Map((centerQuery.data?.employees ?? []).map((employee) => [employee.employeeId, employee])), [centerQuery.data?.employees])
  const visibleRecords = useMemo(() => {
    const term = normalized(search.trim())
    return (centerQuery.data?.records ?? []).filter((record) => {
      const employee = employeeById.get(record.employeeId)
      const searchable = [
        record.employeeName,
        record.employeeNumber,
        record.credentialName,
        record.credentialNumber,
        record.status,
        record.statusLabel,
        record.jobTitle,
        record.primaryLocation,
      ].map(normalized).join(' ')
      return recordMatchesSummary(record, employee, summaryFilter)
        && (complianceFilter === 'all' || record.complianceColor === complianceFilter)
        && (credentialTypeFilter === 'all' || record.credentialTypeId === credentialTypeFilter)
        && (employmentStatusFilter === 'all' || record.employmentStatus === employmentStatusFilter)
        && (!term || searchable.includes(term))
    })
  }, [centerQuery.data?.records, complianceFilter, credentialTypeFilter, employeeById, employmentStatusFilter, search, summaryFilter])
  const visibleEmployeeRows = useMemo(() => groupLicensingRecordsByEmployee(
    centerQuery.data?.employees ?? [],
    visibleRecords,
  ), [centerQuery.data?.employees, visibleRecords])

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
  const selectedEmployee = selectedEmployeeId
    ? center.employees.find((employee) => employee.employeeId === selectedEmployeeId) ?? null
    : null
  const employeeBeingEdited = employeeBeingEditedId && employeeBeingEditedId !== 'new'
    ? center.employees.find((employee) => employee.employeeId === employeeBeingEditedId) ?? null
    : null

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

      <section className="licensing-summary-grid" aria-label="Licensing status summary">
        {summaryCards.map((card) => (
          <button
            className={[
              'licensing-summary-card',
              `licensing-summary-card--${card.tone}`,
              summaryFilter === card.key ? 'is-active' : '',
            ].filter(Boolean).join(' ')}
            key={card.key}
            onClick={() => setSummaryFilter(summaryFilter === card.key ? 'all' : card.key)}
            type="button"
          >
            <span>{card.label}</span>
            <strong>{center.summary[card.value]}</strong>
            <small>{card.helper}</small>
          </button>
        ))}
      </section>

      <section className="licensing-toolbar" aria-label="Licensing filters">
        <label className="search-field search-field--wide">
          <Search aria-hidden="true" size={20} />
          <span className="visually-hidden">Search licensing records</span>
          <input onChange={(event) => setSearch(event.target.value)} placeholder="Search credential, license number, employee, status, or location" type="search" value={search} />
        </label>
        <label className="select-field licensing-toolbar__filter licensing-toolbar__filter--compliance">
          <span>Status</span>
          <select onChange={(event) => setComplianceFilter(event.target.value as typeof complianceFilter)} value={complianceFilter}>
            <option value="all">All statuses</option>
            <option value="green">Green</option>
            <option value="yellow">Yellow</option>
            <option value="red">Red</option>
            <option value="gray">Gray</option>
          </select>
        </label>
        <label className="select-field licensing-toolbar__filter licensing-toolbar__filter--credential">
          <span>Credential</span>
          <select onChange={(event) => setCredentialTypeFilter(event.target.value)} value={credentialTypeFilter}>
            <option value="all">All types</option>
            <optgroup label="Guard Licenses">
              {center.credentialTypes.filter((type) => isGuardLicenseCode(type.code)).map((type) => (
                <option key={type.id} value={type.id}>{type.code === 'denver_security_guard_license' ? 'Standard Guard License' : 'Armed Guard License / Endorsement'}</option>
              ))}
            </optgroup>
            <optgroup label="Other Credentials">
              {center.credentialTypes.filter((type) => !isGuardLicenseCode(type.code)).map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
            </optgroup>
          </select>
        </label>
        <label className="select-field licensing-toolbar__filter licensing-toolbar__filter--employment">
          <span>Employment status</span>
          <select onChange={(event) => setEmploymentStatusFilter(event.target.value as typeof employmentStatusFilter)} value={employmentStatusFilter}>
            <option value="all">All statuses</option>
            <option value="onboarding">Onboarding</option>
            <option value="active">Active</option>
            <option value="leave">On leave</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
        <button className="secondary-button licensing-toolbar__clear" onClick={() => {
          setSummaryFilter('all')
          setSearch('')
          setComplianceFilter('all')
          setCredentialTypeFilter('all')
          setEmploymentStatusFilter('all')
        }} type="button">
          <X aria-hidden="true" size={17} />
          Clear filters
        </button>
      </section>

      <section className="licensing-work-queue" aria-label="Coordinator work queue">
        <article className="licensing-queue-card licensing-queue-card--red">
          <AlertTriangle aria-hidden="true" size={20} />
          <div><span>Immediate action</span><strong>{center.summary.expired + center.summary.missingRequired + center.summary.rejected + center.summary.ineligibleEmployees}</strong></div>
        </article>
        <article className="licensing-queue-card licensing-queue-card--red">
          <BellRing aria-hidden="true" size={20} />
          <div><span>Due soon</span><strong>{center.summary.expiring30}</strong></div>
        </article>
        <article className="licensing-queue-card licensing-queue-card--yellow">
          <FileText aria-hidden="true" size={20} />
          <div><span>Follow-up</span><strong>{center.summary.expiring60 + center.summary.renewalsInProgress}</strong></div>
        </article>
        <article className="licensing-queue-card licensing-queue-card--yellow">
          <BadgeCheck aria-hidden="true" size={20} />
          <div><span>Upcoming</span><strong>{center.summary.expiring90}</strong></div>
        </article>
      </section>

      <section className="licensing-table-panel" aria-label="Licensing records">
        <div className="licensing-table-panel__heading">
          <div>
            <h2>Credential worklist</h2>
            <p>{visibleEmployeeRows.length} employee{visibleEmployeeRows.length === 1 ? '' : 's'} match the current filters.</p>
          </div>
          {summaryFilter !== 'all' ? <CredentialStatusPill color="yellow" label="Summary filter active" /> : null}
        </div>
        <div className="licensing-table" role="table" aria-label="Credential compliance records">
          <div className="licensing-row licensing-row--header" role="row">
            <span role="columnheader">Employee</span>
            <span role="columnheader">Licenses &amp; Credentials</span>
            <span role="columnheader">Next Expiration</span>
            <span role="columnheader">Overall Status</span>
            <span role="columnheader">Renewals</span>
            <span role="columnheader">Shift Eligibility</span>
            <span role="columnheader">Action</span>
          </div>
          {visibleEmployeeRows.map(({ employee, records }) => {
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
                  <strong>{employee.displayName}</strong>
                  <span>{employee.employeeNumber ?? 'ID pending'} | {employee.jobTitle || formatRole(employee.role)}</span>
                </div>
                <div role="cell">
                  <strong>{credentialsOnFile.length} on file{missingCount > 0 ? ` | ${missingCount} missing` : ''}</strong>
                  <span>{credentialPreview}</span>
                  {records.length < employee.credentials.length ? <span>{records.length} match current filters</span> : null}
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
                <div role="cell"><span className="plain-value">{renewalCount > 0 ? `${renewalCount} in progress` : 'No active renewal'}</span></div>
                <div role="cell">
                  <span className={`work-eligibility work-eligibility--${employee.workEligibility}`}>
                    {formatEligibility(employee.workEligibility)}
                  </span>
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
        {visibleEmployeeRows.length === 0 ? (
          <div className="licensing-empty">
            <ClipboardCheck aria-hidden="true" size={26} />
            <strong>No licensing records match these filters.</strong>
            <span>Clear filters or choose a different summary card.</span>
          </div>
        ) : null}
      </section>

      {selectedEmployee ? (
        <EmployeeLicensingProfile
          center={center}
          employee={selectedEmployee}
          onClose={() => setSelectedEmployeeId(null)}
          onEditEmployee={(employee) => setEmployeeBeingEditedId(employee.employeeId)}
        />
      ) : null}
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
