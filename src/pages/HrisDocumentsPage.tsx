import { type DragEvent, type FormEvent, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FileImage,
  FileSpreadsheet,
  FileText,
  Files,
  Search,
  ShieldCheck,
  UploadCloud,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { DataStatePanel } from '../components/DataStatePanel'
import { DocumentStudioDashboard } from '../components/DocumentStudioDashboard'
import { ModalDialog } from '../components/ModalDialog'
import { SecurePdfViewer } from '../components/SecurePdfViewer'
import {
  getHrDocumentBlob,
  getHrDocumentWorkspace,
  uploadHrDocument,
  type HrDocumentRecord,
  type HrDocumentUploadInput,
  type HrDocumentWorkspace,
  type HrDocumentWorkspaceFilters,
} from '../data/hrDocuments'
import { formatOperationalDateTime } from '../lib/time'

type PageSize = 5 | 10 | 20
type AccessAction = 'preview' | 'download'

const classificationLabels = {
  confidential: 'Confidential',
  highly_restricted: 'Highly restricted',
  restricted: 'Restricted',
} as const

const scanLabels = {
  clean: 'Security review complete',
  quarantined: 'Quarantined',
  rejected: 'Rejected',
  scan_error: 'Security review failed',
  scan_pending: 'Security review pending',
} as const

function formatDate(value: string | null): string {
  if (!value) return 'Not recorded'
  const [year, month, day] = value.split('-')
  return `${month}/${day}/${year}`
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function FileTypeIcon({ mimeType }: { mimeType: string | null }) {
  if (mimeType?.startsWith('image/')) return <FileImage aria-hidden="true" />
  if (mimeType?.includes('spreadsheet') || mimeType?.includes('excel')) return <FileSpreadsheet aria-hidden="true" />
  return <FileText aria-hidden="true" />
}

export function HrisDocumentsPage() {
  const queryClient = useQueryClient()
  const [searchInput, setSearchInput] = useState('')
  const [filters, setFilters] = useState<HrDocumentWorkspaceFilters>({
    includeArchived: false,
    page: 1,
    pageSize: 10,
    search: '',
  })
  const [expandedDocumentId, setExpandedDocumentId] = useState<string | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [accessTarget, setAccessTarget] = useState<{ action: AccessAction; document: HrDocumentRecord } | null>(null)
  const workspaceQuery = useQuery({
    queryFn: () => getHrDocumentWorkspace(filters),
    queryKey: ['hr-documents', filters],
  })
  const workspace = workspaceQuery.data

  useEffect(() => {
    if (workspace && (filters.page ?? 1) > Math.max(workspace.pagination.totalPages, 1)) {
      setFilters((current) => ({ ...current, page: Math.max(workspace.pagination.totalPages, 1) }))
    }
  }, [filters.page, workspace])

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFilters((current) => ({ ...current, page: 1, search: searchInput.trim() }))
  }

  function updateFilter(key: keyof HrDocumentWorkspaceFilters, value: string | number | boolean | undefined) {
    setExpandedDocumentId(null)
    setFilters((current) => ({ ...current, [key]: value, page: 1 }))
  }

  return (
    <main className="hr-documents-page">
      <header className="hr-documents-hero">
        <div>
          <p className="eyebrow">HR &amp; Finance</p>
          <h1>Document Studio</h1>
          <p>Create, route, sign, retain, and retrieve protected records from one controlled document system.</p>
        </div>
        <div className="hr-documents-hero__security">
          <ShieldCheck aria-hidden="true" size={24} />
          <div><strong>Protected document workspace</strong><span>Recent MFA and assigned vault permission required</span></div>
        </div>
      </header>

      <nav aria-label="People and HR sections" className="hr-people-tabs">
        <Link to="/hr">Overview</Link>
        <Link to="/hr/people">People</Link>
        <Link className="active" to="/hr/documents">Document Studio</Link>
        <Link to="/hr/documents/workflows">Requests &amp; assignments</Link>
      </nav>

      <DocumentStudioDashboard documents={workspace} />

      {workspaceQuery.isPending ? (
        <DataStatePanel icon={Files} title="Loading protected documents">
          <p>Checking your HR permissions and authorized document vaults.</p>
        </DataStatePanel>
      ) : null}
      {workspaceQuery.isError ? (
        <DataStatePanel icon={AlertTriangle} tone="error" title="Protected inventory unavailable">
          <p>{workspaceQuery.error instanceof Error ? workspaceQuery.error.message : 'The protected document workspace could not be loaded.'}</p>
        </DataStatePanel>
      ) : null}

      {workspace ? (
        <>
          <section className="hr-documents-toolbar">
            <div className="hr-documents-toolbar__heading">
              <div><p className="eyebrow">Document inventory</p><h2>Employee records</h2><p>Legal names are used throughout this workspace.</p></div>
              {workspace.actor.canManageAny ? <button className="primary-action" onClick={() => setUploadOpen(true)} type="button"><UploadCloud aria-hidden="true" size={18} />Upload document</button> : null}
            </div>
            <div className="hr-documents-filters">
              <form onSubmit={submitSearch}>
                <label htmlFor="hr-document-search">Search</label>
                <div><Search aria-hidden="true" size={18} /><input id="hr-document-search" onChange={(event) => setSearchInput(event.target.value)} placeholder="Title, category, employee, or file" value={searchInput} /></div>
                <button className="secondary-button" type="submit">Search</button>
              </form>
              <label>Employee<select onChange={(event) => updateFilter('employeeId', event.target.value || undefined)} value={filters.employeeId ?? ''}><option value="">All authorized employees</option>{workspace.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.legalName}{employee.employeeNumber ? ` · ${employee.employeeNumber}` : ''}</option>)}</select></label>
              <label>Vault<select onChange={(event) => updateFilter('vaultCode', event.target.value || undefined)} value={filters.vaultCode ?? ''}><option value="">All authorized vaults</option>{workspace.vaults.filter((vault) => vault.canView).map((vault) => <option key={vault.code} value={vault.code}>{vault.name}</option>)}</select></label>
              <label>Rows<select onChange={(event) => updateFilter('pageSize', Number(event.target.value) as PageSize)} value={filters.pageSize ?? 10}><option value={5}>5</option><option value={10}>10</option><option value={20}>20</option></select></label>
              <label className="hr-documents-archive-filter"><input checked={Boolean(filters.includeArchived)} onChange={(event) => updateFilter('includeArchived', event.target.checked)} type="checkbox" /><Archive aria-hidden="true" size={17} />Include archived</label>
            </div>
          </section>

          <section className="hr-documents-inventory">
            <div className="hr-documents-inventory__summary"><span><strong>{workspace.pagination.totalCount}</strong> matching documents</span><span>Page {workspace.pagination.totalCount === 0 ? 0 : workspace.pagination.page} of {workspace.pagination.totalPages}</span></div>
            {workspace.documents.length === 0 ? (
              <DataStatePanel icon={Search} title="No documents match these filters"><p>Clear the search or choose another employee or vault.</p></DataStatePanel>
            ) : (
              <div className="hr-documents-list">
                {workspace.documents.map((document) => {
                  const isExpanded = expandedDocumentId === document.id
                  return (
                    <article className="hr-document-row" key={document.id}>
                      <button aria-expanded={isExpanded} className="hr-document-row__summary" onClick={() => setExpandedDocumentId(isExpanded ? null : document.id)} type="button">
                        <span className="hr-document-row__icon"><FileTypeIcon mimeType={document.version?.mimeType ?? null} /></span>
                        <span className="hr-document-row__identity"><strong>{document.title}</strong><small>{document.employeeLegalName ?? 'Company record'}{document.employeeNumber ? ` · ${document.employeeNumber}` : ''}</small></span>
                        <span><small>Category</small><strong>{document.category}</strong><em>{document.vaultCode}</em></span>
                        <span><small>Security</small><strong>{classificationLabels[document.accessClassification]}</strong><em className={`hr-scan-state hr-scan-state--${document.version?.scanState ?? 'scan_pending'}`}>{document.version ? scanLabels[document.version.scanState] : 'No version'}</em></span>
                        <span><small>Version</small><strong>{document.version ? `Version ${document.version.versionNumber}` : 'Pending'}</strong><em>{document.version ? formatOperationalDateTime(document.version.uploadedAt) : 'No upload recorded'}</em></span>
                        <ChevronDown aria-hidden="true" className={isExpanded ? 'rotated' : ''} />
                      </button>
                      {isExpanded ? (
                        <div className="hr-document-row__details">
                          <dl>
                            <div><dt>Description</dt><dd>{document.description || 'No description recorded'}</dd></div>
                            <div><dt>Effective date</dt><dd>{formatDate(document.effectiveDate)}</dd></div>
                            <div><dt>Expiration date</dt><dd>{formatDate(document.expirationDate)}</dd></div>
                            <div><dt>File</dt><dd>{document.version ? `${document.version.filename} · ${formatFileSize(document.version.sizeBytes)}` : 'No released file'}</dd></div>
                          </dl>
                          <div className="hr-document-row__actions">
                            {document.canPreview ? <button className="secondary-button" onClick={() => setAccessTarget({ action: 'preview', document })} type="button"><Eye aria-hidden="true" size={17} />Preview</button> : null}
                            {document.canDownload ? <button className="secondary-button" onClick={() => setAccessTarget({ action: 'download', document })} type="button"><Download aria-hidden="true" size={17} />Download</button> : null}
                            {!document.canPreview && !document.canDownload ? <span>File access remains unavailable until the security review is complete.</span> : null}
                          </div>
                        </div>
                      ) : null}
                    </article>
                  )
                })}
              </div>
            )}
            <div className="hr-documents-pagination">
              <button className="secondary-button" disabled={workspace.pagination.page <= 1} onClick={() => setFilters((current) => ({ ...current, page: Math.max(1, (current.page ?? 1) - 1) }))} type="button"><ChevronLeft aria-hidden="true" size={17} />Previous</button>
              <span>{workspace.pagination.totalCount === 0 ? 'No pages' : `${workspace.pagination.page} of ${workspace.pagination.totalPages}`}</span>
              <button className="secondary-button" disabled={workspace.pagination.page >= workspace.pagination.totalPages} onClick={() => setFilters((current) => ({ ...current, page: (current.page ?? 1) + 1 }))} type="button">Next<ChevronRight aria-hidden="true" size={17} /></button>
            </div>
          </section>

          {uploadOpen ? <DocumentUploadModal onClose={() => setUploadOpen(false)} onUploaded={() => void queryClient.invalidateQueries({ queryKey: ['hr-documents'] })} workspace={workspace} /> : null}
          {accessTarget ? <DocumentAccessModal action={accessTarget.action} document={accessTarget.document} onClose={() => setAccessTarget(null)} /> : null}
        </>
      ) : null}
    </main>
  )
}

function DocumentUploadModal({ onClose, onUploaded, workspace }: { onClose: () => void; onUploaded: () => void; workspace: HrDocumentWorkspace }) {
  const manageableVaults = workspace.vaults.filter((vault) => vault.canManage)
  const [employeeId, setEmployeeId] = useState('')
  const [vaultCode, setVaultCode] = useState(manageableVaults[0]?.code ?? '')
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('Employment document')
  const [description, setDescription] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [dragActive, setDragActive] = useState(false)
  const [progress, setProgress] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const selectedVault = manageableVaults.find((vault) => vault.code === vaultCode)

  const uploadMutation = useMutation({
    mutationFn: (input: HrDocumentUploadInput) => uploadHrDocument(input, setProgress),
    onSuccess: () => {
      onUploaded()
      onClose()
    },
  })

  function chooseFile(nextFile: File | null) {
    uploadMutation.reset()
    setProgress(0)
    setFile(nextFile)
    setIdempotencyKey(crypto.randomUUID())
    if (nextFile && !title.trim()) setTitle(nextFile.name.replace(/\.[^.]+$/, ''))
  }

  function validateFile(): string | null {
    if (!file) return 'Choose a file to upload.'
    if (!selectedVault) return 'Choose an authorized document vault.'
    if (!file.type || !selectedVault.allowedMimeTypes.includes(file.type)) return 'This file type is not allowed in the selected vault.'
    if (file.size > selectedVault.maximumFileSizeBytes) return `The selected file exceeds the ${formatFileSize(selectedVault.maximumFileSizeBytes)} limit.`
    return null
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fileError = validateFile()
    if (fileError || !file || !selectedVault || !employeeId || !title.trim() || !category.trim()) return
    setProgress(0)
    uploadMutation.mutate({
      accessClassification: selectedVault.classification,
      category,
      description,
      employeeId,
      file,
      idempotencyKey,
      title,
      vaultCode,
    })
  }

  function acceptDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragActive(false)
    chooseFile(event.dataTransfer.files.item(0))
  }

  const fileError = validateFile()
  const formReady = Boolean(file && employeeId && title.trim() && category.trim() && !fileError)

  return (
    <ModalDialog busy={uploadMutation.isPending} busyLabel={`Uploading protected document… ${progress}%`} className="hr-document-modal" description="Select the employee and authorized vault, then upload one supported file." onClose={onClose} title="Upload HR document">
      <form className="hr-document-upload-form" onSubmit={submit}>
        <div className="hr-document-upload-form__fields">
          <label>Employee<select onChange={(event) => setEmployeeId(event.target.value)} required value={employeeId}><option value="">Choose an employee</option>{workspace.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.legalName}{employee.employeeNumber ? ` · ${employee.employeeNumber}` : ''}</option>)}</select></label>
          <label>Document vault<select onChange={(event) => { setVaultCode(event.target.value); chooseFile(null) }} required value={vaultCode}>{manageableVaults.map((vault) => <option key={vault.code} value={vault.code}>{vault.name}</option>)}</select></label>
          <label>Document title<input maxLength={160} onChange={(event) => setTitle(event.target.value)} required value={title} /></label>
          <label>Category<input maxLength={100} onChange={(event) => setCategory(event.target.value)} required value={category} /></label>
          <label className="wide">Description <span>Optional</span><textarea maxLength={1000} onChange={(event) => setDescription(event.target.value)} rows={3} value={description} /></label>
        </div>
        <div className={`hr-document-dropzone${dragActive ? ' active' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }} onDragLeave={() => setDragActive(false)} onDragOver={(event) => event.preventDefault()} onDrop={acceptDrop}>
          <input accept={selectedVault?.allowedMimeTypes.join(',')} hidden onChange={(event) => chooseFile(event.target.files?.item(0) ?? null)} ref={fileInputRef} type="file" />
          <UploadCloud aria-hidden="true" size={32} />
          <strong>{file ? file.name : 'Drop one document here'}</strong>
          <span>{file ? formatFileSize(file.size) : 'or choose a supported file from this device'}</span>
          <button className="secondary-button" onClick={() => fileInputRef.current?.click()} type="button">Choose file</button>
          {selectedVault ? <small>Maximum {formatFileSize(selectedVault.maximumFileSizeBytes)} · {classificationLabels[selectedVault.classification]}</small> : null}
        </div>
        {file && fileError ? <p className="form-error" role="alert">{fileError}</p> : null}
        {uploadMutation.isError ? <p className="form-error" role="alert">{uploadMutation.error instanceof Error ? uploadMutation.error.message : 'The upload could not be completed. You can retry safely.'}</p> : null}
        {uploadMutation.isPending ? <div aria-label={`Upload ${progress}% complete`} className="hr-document-progress"><span style={{ width: `${progress}%` }} /></div> : null}
        <div className="modal-actions"><button className="secondary-button" disabled={uploadMutation.isPending} onClick={onClose} type="button">Cancel</button><button className="primary-action" disabled={!formReady || uploadMutation.isPending} type="submit">Upload securely</button></div>
      </form>
    </ModalDialog>
  )
}

function DocumentAccessModal({ action, document, onClose }: { action: AccessAction; document: HrDocumentRecord; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<{ mimeType: string; text?: string; url?: string } | null>(null)
  const accessMutation = useMutation({
    mutationFn: () => getHrDocumentBlob(document.id, action, reason),
    onSuccess: async ({ blob, filename }) => {
      if (action === 'download') {
        const url = URL.createObjectURL(blob)
        const anchor = window.document.createElement('a')
        anchor.href = url
        anchor.download = filename
        anchor.click()
        URL.revokeObjectURL(url)
        onClose()
        return
      }
      if (blob.type.startsWith('text/')) {
        setPreview({ mimeType: blob.type, text: await blob.text() })
      } else {
        setPreview({ mimeType: blob.type, url: URL.createObjectURL(blob) })
      }
    },
  })

  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url) }, [preview?.url])

  return (
    <ModalDialog busy={accessMutation.isPending} busyLabel={`Preparing protected ${action}…`} className="hr-document-modal hr-document-access-modal" description={`${document.employeeLegalName ?? 'Company record'} · ${document.category}`} onClose={onClose} title={`${action === 'preview' ? 'Preview' : 'Download'} ${document.title}`}>
      {preview ? (
        <div className="hr-document-preview">
          {preview.mimeType === 'application/pdf' && preview.url ? <SecurePdfViewer title={document.title} url={preview.url} /> : null}
          {preview.mimeType.startsWith('image/') && preview.url ? <img alt={`Preview of ${document.title}`} src={preview.url} /> : null}
          {preview.text !== undefined ? <pre>{preview.text}</pre> : null}
          <div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Close preview</button></div>
        </div>
      ) : (
        <form className="hr-document-access-form" onSubmit={(event) => { event.preventDefault(); if (reason.trim().length >= 8) accessMutation.mutate() }}>
          <div className="hr-document-access-summary"><FileTypeIcon mimeType={document.version?.mimeType ?? null} /><div><strong>{document.version?.filename ?? document.title}</strong><span>{classificationLabels[document.accessClassification]} · Access is recorded in the audit history.</span></div></div>
          <label>Business reason<textarea autoFocus maxLength={500} minLength={8} onChange={(event) => setReason(event.target.value)} placeholder="Explain why this document is needed." required rows={3} value={reason} /></label>
          {accessMutation.isError ? <p className="form-error" role="alert">{accessMutation.error instanceof Error ? accessMutation.error.message : 'Document access could not be completed.'}</p> : null}
          <div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Cancel</button><button className="primary-action" disabled={reason.trim().length < 8 || accessMutation.isPending} type="submit">{action === 'preview' ? 'Open protected preview' : 'Download protected file'}</button></div>
        </form>
      )}
    </ModalDialog>
  )
}
