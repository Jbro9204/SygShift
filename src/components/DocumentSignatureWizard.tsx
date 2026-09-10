import { type DragEvent, type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CheckCircle2, ChevronLeft, ChevronRight, FileSignature, Search, ShieldCheck, UploadCloud, Users } from 'lucide-react'
import { ModalDialog } from './ModalDialog'
import { createSignatureEnvelope, sendSignatureEnvelope, type DocumentStudioPolicy } from '../data/documentStudio'
import {
  getHrDocumentWorkspace,
  uploadHrDocument,
  type HrDocumentUploadInput,
  type HrDocumentVault,
  type HrDocumentWorkspace,
} from '../data/hrDocuments'

type WizardStep = 'document' | 'people' | 'review' | 'security' | 'complete'
type RequiredAction = 'sign' | 'acknowledge' | 'approve' | 'certify' | 'review'

const actionLabels: Record<RequiredAction, string> = {
  acknowledge: 'Acknowledge receipt',
  approve: 'Approve',
  certify: 'Certify',
  review: 'Review only',
  sign: 'Sign',
}

const categoryOptions = ['Business document', 'Proposal', 'Employment document', 'Policy or acknowledgment', 'Training document', 'Other']

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function compatibleVaults(workspace: HrDocumentWorkspace, file: File | null): HrDocumentVault[] {
  return workspace.vaults.filter((vault) => vault.canManage && (!file || (
    Boolean(file.type) && vault.allowedMimeTypes.includes(file.type) && file.size <= vault.maximumFileSizeBytes
  )))
}

function automaticVault(workspace: HrDocumentWorkspace, file: File | null): HrDocumentVault | undefined {
  const compatible = compatibleVaults(workspace, file)
  return compatible.find((vault) => vault.code === 'hr-general') ?? compatible[0]
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export function DocumentSignatureWizard({
  onClose,
  onCompleted,
  policies,
  workspace,
}: {
  onClose: () => void
  onCompleted: () => Promise<unknown>
  policies: DocumentStudioPolicy[]
  workspace: HrDocumentWorkspace
}) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const sendStarted = useRef(false)
  const [step, setStep] = useState<WizardStep>('document')
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('Business document')
  const [description, setDescription] = useState('')
  const [employeeId, setEmployeeId] = useState('company')
  const [vaultCode, setVaultCode] = useState(() => automaticVault(workspace, null)?.code ?? '')
  const [recipientIds, setRecipientIds] = useState<string[]>([])
  const [recipientSearch, setRecipientSearch] = useState('')
  const [requiredAction, setRequiredAction] = useState<RequiredAction>('sign')
  const [message, setMessage] = useState('Please review and complete this protected document in SygShift.')
  const [expiresAt, setExpiresAt] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const [progress, setProgress] = useState(0)
  const [validation, setValidation] = useState<string | null>(null)
  const [uploadResult, setUploadResult] = useState<{ documentId: string } | null>(null)
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())

  const standardPolicy = policies.find((policy) => policy.active && policy.code === 'STANDARD_EMPLOYEE_ELECTRONIC_SIGNATURE')
    ?? policies.find((policy) => policy.active && policy.code === 'EMPLOYEE_ACK')
    ?? policies.find((policy) => policy.active && policy.executionMethod === 'electronic')
  const selectedVault = workspace.vaults.find((vault) => vault.code === vaultCode && vault.canManage)
  const eligibleEmployees = useMemo(() => workspace.employees.filter((employee) => ['active', 'leave'].includes(employee.status)), [workspace.employees])
  const filteredEmployees = useMemo(() => {
    const search = recipientSearch.trim().toLowerCase()
    return eligibleEmployees.filter((employee) => !search || `${employee.legalName} ${employee.employeeNumber ?? ''}`.toLowerCase().includes(search))
  }, [eligibleEmployees, recipientSearch])

  const upload = useMutation({
    mutationFn: (input: HrDocumentUploadInput) => uploadHrDocument(input, setProgress),
    onSuccess: (result) => {
      setUploadResult({ documentId: result.documentId })
      setStep('security')
    },
  })

  const scan = useQuery({
    enabled: Boolean(uploadResult),
    queryKey: ['signature-upload-scan', uploadResult?.documentId],
    queryFn: () => getHrDocumentWorkspace({ page: 1, pageSize: 20, search: title.trim().slice(0, 120) }),
    refetchInterval: (query) => {
      const document = query.state.data?.documents.find((item) => item.id === uploadResult?.documentId)
      return !document || ['quarantined', 'scan_pending'].includes(document.version?.scanState ?? '') ? 2_000 : false
    },
  })
  const uploadedDocument = scan.data?.documents.find((item) => item.id === uploadResult?.documentId)

  const send = useMutation({
    mutationFn: async () => {
      if (!uploadResult || !standardPolicy) throw new Error('The protected signing policy is unavailable.')
      const created = await createSignatureEnvelope({
        documentId: uploadResult.documentId,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        idempotencyKey,
        message: message.trim(),
        policyId: standardPolicy.id,
        recipients: recipientIds.map((recipientId) => ({
          authenticationTier: standardPolicy.authenticationTier,
          employeeId: recipientId,
          recipientRole: 'employee',
          requiredAction,
          routingOrder: 1,
        })),
        templateVersionId: null,
        title: title.trim(),
      })
      if (typeof created.id !== 'string') throw new Error('The document was prepared, but the signature request confirmation was invalid.')
      await sendSignatureEnvelope(created.id)
      return created.id
    },
    onSuccess: async () => {
      setStep('complete')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['document-studio'] }),
        queryClient.invalidateQueries({ queryKey: ['hr-documents'] }),
        queryClient.invalidateQueries({ queryKey: ['my-documents'] }),
        queryClient.invalidateQueries({ queryKey: ['my-notifications'] }),
        onCompleted(),
      ])
    },
  })

  useEffect(() => {
    if (step !== 'security' || !uploadedDocument || sendStarted.current) return
    if (uploadedDocument.version?.scanState === 'clean') {
      sendStarted.current = true
      send.mutate()
    }
  }, [send, step, uploadedDocument])

  function chooseFile(nextFile: File | null) {
    upload.reset()
    setValidation(null)
    setProgress(0)
    setFile(nextFile)
    setIdempotencyKey(crypto.randomUUID())
    if (!nextFile) return
    if (!title.trim()) setTitle(nextFile.name.replace(/\.[^.]+$/, ''))
    const vault = automaticVault(workspace, nextFile)
    setVaultCode(vault?.code ?? '')
    if (!vault) setValidation('This file type or size is not supported by any document area you can manage.')
  }

  function validateDocument(): boolean {
    if (!file) { setValidation('Choose the document you want to send.'); return false }
    if (!title.trim()) { setValidation('Add a clear document title.'); return false }
    if (!selectedVault) { setValidation('This file cannot be stored in an authorized document area.'); return false }
    if (!file.type || !selectedVault.allowedMimeTypes.includes(file.type)) { setValidation('This file type is not supported in the selected document area.'); return false }
    if (file.size > selectedVault.maximumFileSizeBytes) { setValidation(`This file exceeds the ${formatFileSize(selectedVault.maximumFileSizeBytes)} limit.`); return false }
    setValidation(null)
    return true
  }

  function continueFromDocument(event: FormEvent) {
    event.preventDefault()
    if (validateDocument()) setStep('people')
  }

  function continueFromPeople(event: FormEvent) {
    event.preventDefault()
    if (!recipientIds.length) { setValidation('Choose at least one employee.'); return }
    setValidation(null)
    setStep('review')
  }

  function startDelivery() {
    if (!file || !selectedVault || !standardPolicy || !recipientIds.length) return
    setValidation(null)
    setStep('security')
    upload.mutate({
      accessClassification: selectedVault.classification,
      category,
      description,
      employeeId: employeeId === 'company' ? null : employeeId,
      file,
      idempotencyKey,
      title,
      vaultCode: selectedVault.code,
    })
  }

  function toggleRecipient(id: string) {
    setRecipientIds((current) => current.includes(id) ? current.filter((value) => value !== id) : current.length < 25 ? [...current, id] : current)
    setValidation(null)
  }

  const scanState = uploadedDocument?.version?.scanState
  const processingError = upload.error || scan.error || send.error
  return <ModalDialog
    busy={upload.isPending || send.isPending}
    busyLabel={upload.isPending ? `Uploading protected document… ${progress}%` : 'Sending protected signature request…'}
    className="document-signature-wizard"
    description="Upload an outside document and send it to one or more SygShift employees without building a policy or template first."
    onClose={onClose}
    title="Send a document"
  >
    <div className="document-signature-wizard__body">
      <ol className="document-signature-wizard__steps" aria-label="Document delivery progress">
        {[
          ['document', 'Document'],
          ['people', 'People'],
          ['review', 'Review'],
          ['security', 'Send'],
        ].map(([value, label], index) => {
          const order = ['document', 'people', 'review', 'security', 'complete']
          const currentIndex = order.indexOf(step)
          const itemIndex = order.indexOf(value as WizardStep)
          return <li className={itemIndex === currentIndex ? 'current' : itemIndex < currentIndex ? 'complete' : ''} key={value}><span>{itemIndex < currentIndex ? <Check aria-hidden="true" size={15} /> : index + 1}</span><strong>{label}</strong></li>
        })}
      </ol>

      {step === 'document' ? <form className="document-signature-wizard__panel" onSubmit={continueFromDocument}>
        <header><UploadCloud aria-hidden="true"/><div><h3>Choose the document</h3><p>Upload a proposal, agreement, policy, or other supported outside document. SygShift files it securely and scans it before anything is sent.</p></div></header>
        <div className={`document-signature-wizard__dropzone${dragActive ? ' active' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }} onDragLeave={() => setDragActive(false)} onDragOver={(event) => event.preventDefault()} onDrop={(event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragActive(false); chooseFile(event.dataTransfer.files.item(0)) }}>
          <input accept={workspace.vaults.filter((vault) => vault.canManage).flatMap((vault) => vault.allowedMimeTypes).filter((value, index, all) => all.indexOf(value) === index).join(',')} hidden onChange={(event) => chooseFile(event.target.files?.item(0) ?? null)} ref={inputRef} type="file"/>
          <FileSignature aria-hidden="true" size={34}/><strong>{file?.name ?? 'Drop the document here'}</strong><span>{file ? formatFileSize(file.size) : 'PDF, Word, image, spreadsheet, or text file within your authorized limit'}</span><button className="secondary-button" onClick={() => inputRef.current?.click()} type="button">{file ? 'Choose another file' : 'Choose file'}</button>
        </div>
        <div className="document-signature-wizard__grid"><label>Document title<input maxLength={160} onChange={(event) => setTitle(event.target.value)} required value={title}/></label><label>What kind of document is this?<select onChange={(event) => setCategory(event.target.value)} value={category}>{categoryOptions.map((option) => <option key={option}>{option}</option>)}</select></label></div>
        <details className="document-signature-wizard__advanced"><summary>Optional filing details</summary><div className="document-signature-wizard__grid"><label>File with<select onChange={(event) => setEmployeeId(event.target.value)} value={employeeId}><option value="company">Company / shared records</option>{workspace.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.legalName}</option>)}</select></label><label>Protected document area<select onChange={(event) => setVaultCode(event.target.value)} value={vaultCode}>{compatibleVaults(workspace, file).map((vault) => <option key={vault.code} value={vault.code}>{vault.name}</option>)}</select></label><label className="wide">Internal description<textarea maxLength={1000} onChange={(event) => setDescription(event.target.value)} rows={3} value={description}/></label></div></details>
        {selectedVault ? <p className="document-signature-wizard__automatic"><ShieldCheck aria-hidden="true" size={17}/>SygShift will use <strong>{selectedVault.name}</strong> automatically. You do not have to choose a section.</p> : null}
        {validation ? <p className="form-error" role="alert">{validation}</p> : null}
        <footer><button className="secondary-button" onClick={onClose} type="button">Cancel</button><button className="primary-action" type="submit">Choose recipients<ChevronRight aria-hidden="true" size={17}/></button></footer>
      </form> : null}

      {step === 'people' ? <form className="document-signature-wizard__panel" onSubmit={continueFromPeople}>
        <header><Users aria-hidden="true"/><div><h3>Who needs to complete it?</h3><p>Choose up to 25 active SygShift employees. Each person receives a protected request in My Documents and a transactional email.</p></div></header>
        <label className="document-signature-wizard__action">What should they do?<select value={requiredAction} onChange={(event) => setRequiredAction(event.target.value as RequiredAction)}>{Object.entries(actionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="document-signature-wizard__search"><span>Find employees</span><div><Search aria-hidden="true" size={18}/><input maxLength={120} onChange={(event) => setRecipientSearch(event.target.value)} placeholder="Name or employee number" value={recipientSearch}/></div></label>
        <div className="document-signature-wizard__people" role="group" aria-label="Employees"><p>{recipientIds.length} selected</p>{filteredEmployees.map((employee) => <label key={employee.id}><input checked={recipientIds.includes(employee.id)} onChange={() => toggleRecipient(employee.id)} type="checkbox"/><span><strong>{employee.legalName}</strong><small>{employee.employeeNumber ?? 'Active SygShift employee'}</small></span></label>)}</div>
        {validation ? <p className="form-error" role="alert">{validation}</p> : null}
        <footer><button className="secondary-button" onClick={() => setStep('document')} type="button"><ChevronLeft aria-hidden="true" size={17}/>Back</button><button className="primary-action" type="submit">Review request<ChevronRight aria-hidden="true" size={17}/></button></footer>
      </form> : null}

      {step === 'review' ? <section className="document-signature-wizard__panel">
        <header><FileSignature aria-hidden="true"/><div><h3>Review and send</h3><p>SygShift will upload the original, complete its security scan, create the request, and send it. No separate template is required.</p></div></header>
        <dl className="document-signature-wizard__summary"><div><dt>Document</dt><dd>{title}<small>{file?.name} · {file ? formatFileSize(file.size) : ''}</small></dd></div><div><dt>Action</dt><dd>{actionLabels[requiredAction]}</dd></div><div><dt>Recipients</dt><dd>{recipientIds.map((id) => workspace.employees.find((employee) => employee.id === id)?.legalName).filter(Boolean).join(', ')}</dd></div><div><dt>Filed with</dt><dd>{employeeId === 'company' ? 'Company / shared records' : workspace.employees.find((employee) => employee.id === employeeId)?.legalName}</dd></div></dl>
        <div className="document-signature-wizard__grid"><label className="wide">Message <span>Optional</span><textarea maxLength={2000} onChange={(event) => setMessage(event.target.value)} rows={4} value={message}/></label><label>Due date <span>Optional</span><input onChange={(event) => setExpiresAt(event.target.value)} type="datetime-local" value={expiresAt}/></label></div>
        {!standardPolicy ? <p className="form-error" role="alert">The approved internal signing policy is unavailable. A Document Studio administrator must restore it before this request can be sent.</p> : null}
        <footer><button className="secondary-button" onClick={() => setStep('people')} type="button"><ChevronLeft aria-hidden="true" size={17}/>Back</button><button className="primary-action" disabled={!standardPolicy} onClick={startDelivery} type="button"><UploadCloud aria-hidden="true" size={17}/>Upload and send</button></footer>
      </section> : null}

      {step === 'security' ? <section className="document-signature-wizard__processing" aria-live="polite">
        <span className={`document-signature-wizard__processing-icon${processingError || ['rejected', 'scan_error'].includes(scanState ?? '') ? ' error' : ''}`}><ShieldCheck aria-hidden="true"/></span>
        <h3>{upload.isPending ? `Uploading document — ${progress}%` : send.isPending ? 'Sending the request' : processingError || ['rejected', 'scan_error'].includes(scanState ?? '') ? 'The request was not sent' : 'Completing security review'}</h3>
        <p>{upload.isPending ? 'The original is being transferred to private storage.' : send.isPending ? 'The clean document is being pinned to its recipients and immutable audit trail.' : processingError ? errorMessage(processingError, 'The document could not be prepared.') : scanState === 'rejected' ? 'The file did not pass security review and remains unavailable.' : scanState === 'scan_error' ? 'The file remains quarantined because security review could not complete.' : 'The document is private and unavailable to recipients until malware and integrity checks pass.'}</p>
        {upload.isPending ? <div aria-label={`Upload ${progress}% complete`} className="hr-document-progress"><span style={{ width: `${progress}%` }}/></div> : null}
        {send.isError ? <div className="document-signature-wizard__processing-actions"><button className="secondary-button" onClick={onClose} type="button">Close — document stays saved</button><button className="primary-action" onClick={() => send.mutate()} type="button">Try sending again</button></div> : processingError || ['rejected', 'scan_error'].includes(scanState ?? '') ? <button className="secondary-button" onClick={onClose} type="button">Close — document stays saved</button> : null}
      </section> : null}

      {step === 'complete' ? <section className="document-signature-wizard__processing complete" aria-live="polite"><span className="document-signature-wizard__processing-icon"><CheckCircle2 aria-hidden="true"/></span><h3>Document sent</h3><p>{recipientIds.length} {recipientIds.length === 1 ? 'employee has' : 'employees have'} been notified. The request is now tracked in Signature requests, and each recipient can complete it from My Documents.</p><button className="primary-action" onClick={onClose} type="button">Done</button></section> : null}
    </div>
  </ModalDialog>
}
