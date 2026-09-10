import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FilePenLine,
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
import { DocumentWorkbench } from '../components/DocumentWorkbench'
import { ModalDialog } from '../components/ModalDialog'
import { SecurePdfViewer } from '../components/SecurePdfViewer'
import {
  getHrDocumentBlob,
  getHrDocumentWorkspace,
  type HrDocumentRecord,
  type HrDocumentWorkspaceFilters,
} from '../data/hrDocuments'
import { formatOperationalDateTime } from '../lib/time'

type PageSize = 5 | 10 | 20
type AccessAction = 'preview' | 'download'
type WorkbenchRequest = { employeeOnly?: boolean; file?: File; title?: string }

const classificationLabels = {
  confidential: 'Confidential',
  highly_restricted: 'Highly restricted',
  restricted: 'Restricted',
} as const

const scanLabels = {
  clean: 'Ready',
  quarantined: 'Uploading',
  rejected: 'File not accepted',
  scan_error: 'Upload needs attention',
  scan_pending: 'Finishing upload',
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
  const [workbench, setWorkbench] = useState<WorkbenchRequest | null>(null)
  const [accessTarget, setAccessTarget] = useState<{ action: AccessAction; document: HrDocumentRecord } | null>(null)
  const workspaceQuery = useQuery({
    queryFn: () => getHrDocumentWorkspace(filters),
    queryKey: ['hr-documents', filters],
    refetchInterval: (query) => query.state.data?.documents.some((document) => (
      document.version?.scanState === 'quarantined' || document.version?.scanState === 'scan_pending'
    )) ? 2_000 : false,
  })
  const workspace = workspaceQuery.data
  const openForWork = useMutation({
    mutationFn: async (document: HrDocumentRecord) => {
      const result = await getHrDocumentBlob(document.id, 'download', 'Create an editable working copy.')
      return { file: new File([result.blob], result.filename || `${document.title}.pdf`, { type: result.blob.type || 'application/pdf' }), title: document.title }
    },
    onSuccess: (source) => setWorkbench(source),
  })

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
          <h1>Document Center</h1>
          <p>Open a PDF, complete it, and then download, send, or add it directly to an employee file.</p>
        </div>
        <div className="hr-documents-hero__security">
          <ShieldCheck aria-hidden="true" size={24} />
          <div><strong>One document workspace</strong><span>Files go to the right record and activity is recorded automatically</span></div>
        </div>
      </header>

      <nav aria-label="People and HR sections" className="hr-people-tabs">
        <Link to="/hr">Overview</Link>
        <Link to="/hr/people">People</Link>
        <Link className="active" to="/hr/documents">Document Center</Link>
        <Link to="/hr/documents/workflows">Requests &amp; assignments</Link>
      </nav>

      <DocumentStudioDashboard
        documents={workspace}
        onFileEmployeeDocument={() => setWorkbench({ employeeOnly: true })}
        onUploadDocument={() => setWorkbench({})}
        onUseDocument={(file, title) => setWorkbench({ file, title })}
      />

      {workspaceQuery.isPending ? (
        <DataStatePanel icon={Files} title="Loading documents">
          <p>Opening your document workspace.</p>
        </DataStatePanel>
      ) : null}
      {workspaceQuery.isError ? (
        <DataStatePanel icon={AlertTriangle} tone="error" title="Document inventory unavailable">
          <p>{workspaceQuery.error instanceof Error ? workspaceQuery.error.message : 'The document workspace could not be loaded.'}</p>
        </DataStatePanel>
      ) : null}

      {workspace ? (
        <>
          <section className="hr-documents-toolbar">
            <div className="hr-documents-toolbar__heading">
              <div><p className="eyebrow">Document inventory</p><h2>Employee records</h2><p>Legal names are used throughout this workspace.</p></div>
              {workspace.actor.canManageAny ? <button className="primary-action" onClick={() => setWorkbench({})} type="button"><UploadCloud aria-hidden="true" size={18} />Open a PDF</button> : null}
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
                        <span><small>Access</small><strong>{classificationLabels[document.accessClassification]}</strong><em className={`hr-scan-state hr-scan-state--${document.version?.scanState ?? 'scan_pending'}`}>{document.version ? scanLabels[document.version.scanState] : 'No file'}</em></span>
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
                            {document.canDownload && document.version?.mimeType === 'application/pdf' ? <button className="primary-action" disabled={openForWork.isPending} onClick={() => openForWork.mutate(document)} type="button"><FilePenLine aria-hidden="true" size={17} />Work on a copy</button> : null}
                            {document.canPreview ? <button className="secondary-button" onClick={() => setAccessTarget({ action: 'preview', document })} type="button"><Eye aria-hidden="true" size={17} />Preview</button> : null}
                            {document.canDownload ? <button className="secondary-button" onClick={() => setAccessTarget({ action: 'download', document })} type="button"><Download aria-hidden="true" size={17} />Download</button> : null}
                            {!document.canPreview && !document.canDownload ? <span>This file is still being prepared. It will be available here automatically.</span> : null}
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

          {workbench ? <DocumentWorkbench employeeOnly={workbench.employeeOnly} initialFile={workbench.file} initialTitle={workbench.title} onClose={() => setWorkbench(null)} onSaved={() => void queryClient.invalidateQueries({ queryKey: ['hr-documents'] })} workspace={workspace} /> : null}
          {accessTarget ? <DocumentAccessModal action={accessTarget.action} document={accessTarget.document} onClose={() => setAccessTarget(null)} /> : null}
          {openForWork.isError ? <div className="toast toast--error" role="alert">{openForWork.error instanceof Error ? openForWork.error.message : 'The working copy could not be opened.'}</div> : null}
        </>
      ) : null}
    </main>
  )
}

function DocumentAccessModal({ action, document, onClose }: { action: AccessAction; document: HrDocumentRecord; onClose: () => void }) {
  const started = useRef(false)
  const [preview, setPreview] = useState<{ mimeType: string; text?: string; url?: string } | null>(null)
  const accessMutation = useMutation({
    mutationFn: () => getHrDocumentBlob(document.id, action),
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

  useEffect(() => {
    if (started.current) return
    started.current = true
    accessMutation.mutate()
  }, [accessMutation])

  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url) }, [preview?.url])

  return (
    <ModalDialog busy={accessMutation.isPending} busyLabel={action === 'preview' ? 'Opening document…' : 'Preparing download…'} className="hr-document-modal hr-document-access-modal" description={`${document.employeeLegalName ?? 'Company record'} · ${document.category}`} onClose={onClose} title={`${action === 'preview' ? 'Preview' : 'Download'} ${document.title}`}>
      {preview ? (
        <div className="hr-document-preview">
          {preview.mimeType === 'application/pdf' && preview.url ? <SecurePdfViewer title={document.title} url={preview.url} /> : null}
          {preview.mimeType.startsWith('image/') && preview.url ? <img alt={`Preview of ${document.title}`} src={preview.url} /> : null}
          {preview.text !== undefined ? <pre>{preview.text}</pre> : null}
          <div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Close preview</button></div>
        </div>
      ) : (
        <div className="document-access-progress">
          <div className="hr-document-access-summary"><FileTypeIcon mimeType={document.version?.mimeType ?? null} /><div><strong>{document.version?.filename ?? document.title}</strong><span>{classificationLabels[document.accessClassification]} · Access is recorded in the audit history.</span></div></div>
          {accessMutation.isError ? <p className="form-error" role="alert">{accessMutation.error instanceof Error ? accessMutation.error.message : 'Document access could not be completed.'}</p> : null}
          <div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Close</button>{accessMutation.isError ? <button className="primary-action" disabled={accessMutation.isPending} onClick={() => accessMutation.mutate()} type="button">Try again</button> : null}</div>
        </div>
      )}
    </ModalDialog>
  )
}
