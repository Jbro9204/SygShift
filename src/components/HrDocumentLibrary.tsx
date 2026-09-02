import { type FormEvent, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BookOpenCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileCheck2,
  Files,
  FilterX,
  Search,
  ShieldCheck,
} from 'lucide-react'
import { DataStatePanel } from './DataStatePanel'
import {
  getHrDocumentLibrary,
  type HrDocumentLibraryAudience,
  type HrDocumentLibraryFilters,
} from '../data/hrDocumentLibrary'

type PageSize = 5 | 10 | 20

const audienceLabels: Record<HrDocumentLibraryAudience, string> = {
  all_employees: 'Employee access',
  supervisors_and_hr: 'Supervisors & HR',
  hr_only: 'HR only',
}

const sensitivityLabels = {
  standard: 'Standard record',
  restricted: 'Restricted record',
  highly_restricted: 'Highly restricted',
} as const

export function HrDocumentLibrary({ mode = 'employee' }: { mode?: 'employee' | 'studio' }) {
  const [searchInput, setSearchInput] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [filters, setFilters] = useState<HrDocumentLibraryFilters>({ page: 1, pageSize: 10 })
  const query = useQuery({
    queryFn: () => getHrDocumentLibrary(filters),
    queryKey: ['hr-document-library', filters],
  })
  const workspace = query.data

  useEffect(() => {
    if (workspace && (filters.page ?? 1) > Math.max(workspace.pagination.totalPages, 1)) {
      setFilters((current) => ({ ...current, page: Math.max(workspace.pagination.totalPages, 1) }))
    }
  }, [filters.page, workspace])

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setExpandedId(null)
    setFilters((current) => ({ ...current, page: 1, search: searchInput.trim() || undefined }))
  }

  function updateFilter<Key extends keyof HrDocumentLibraryFilters>(
    key: Key,
    value: HrDocumentLibraryFilters[Key],
  ) {
    setExpandedId(null)
    setFilters((current) => ({ ...current, [key]: value, page: 1 }))
  }

  function clearFilters() {
    setSearchInput('')
    setExpandedId(null)
    setFilters({ page: 1, pageSize: filters.pageSize ?? 10 })
  }

  const hasFilters = Boolean(filters.search || filters.category || filters.audience)

  return (
    <section className={`hr-template-library hr-template-library--${mode}`}>
      <header className="hr-template-library__header">
        <div>
          <p className="eyebrow">Controlled forms library</p>
          <h2>Find the right document</h2>
          <p>Search by form name, code, purpose, or everyday terms such as PTO, emergency contact, injury, complaint, or payroll correction.</p>
        </div>
        <div className="hr-template-library__version"><BookOpenCheck aria-hidden="true" size={22}/><span><strong>Guardianship index</strong><small>Version {workspace?.libraryVersion ?? '1.0'}</small></span></div>
      </header>

      {query.isPending ? <DataStatePanel icon={Files} title="Loading the document library"><p>Finding the forms available for your role.</p></DataStatePanel> : null}
      {query.isError ? <DataStatePanel icon={Search} tone="error" title="Document library unavailable"><p>{query.error instanceof Error ? query.error.message : 'The document library could not be loaded.'}</p></DataStatePanel> : null}

      {workspace ? <>
        <div className="hr-template-library__metrics">
          <article><Files aria-hidden="true"/><span>Forms you can find</span><strong>{workspace.summary.visibleCount}</strong></article>
          <article><BookOpenCheck aria-hidden="true"/><span>Categories</span><strong>{workspace.summary.categoryCount}</strong></article>
          <article><FileCheck2 aria-hidden="true"/><span>Files released</span><strong>{workspace.summary.availableCount}</strong></article>
        </div>

        <div className="hr-template-library__notice">
          <ShieldCheck aria-hidden="true" size={20}/>
          <div><strong>One index, permission-aware results</strong><span>Blank-form discovery is separated from completed employee records. Protected files become available only after security review and authorized release.</span></div>
        </div>

        <div className="hr-template-library__filters">
          <form onSubmit={submitSearch}>
            <label htmlFor={`hr-template-search-${mode}`}>Search library</label>
            <div><Search aria-hidden="true" size={18}/><input id={`hr-template-search-${mode}`} maxLength={120} onChange={(event) => setSearchInput(event.target.value)} placeholder="What do you need help with?" value={searchInput}/></div>
            <button className="secondary-button" type="submit">Search</button>
          </form>
          <label>Category<select onChange={(event) => updateFilter('category', event.target.value || undefined)} value={filters.category ?? ''}><option value="">All categories</option>{workspace.categories.map((category) => <option key={category.name} value={category.name}>{category.name} ({category.count})</option>)}</select></label>
          {(workspace.permissions.canSeeSupervisor || workspace.permissions.canSeeHr) ? <label>Audience<select onChange={(event) => updateFilter('audience', (event.target.value || undefined) as HrDocumentLibraryAudience | undefined)} value={filters.audience ?? ''}><option value="">Everything I can access</option><option value="all_employees">Employee access</option>{workspace.permissions.canSeeSupervisor ? <option value="supervisors_and_hr">Supervisors &amp; HR</option> : null}{workspace.permissions.canSeeHr ? <option value="hr_only">HR only</option> : null}</select></label> : null}
          <label>Rows<select onChange={(event) => updateFilter('pageSize', Number(event.target.value) as PageSize)} value={filters.pageSize ?? 10}><option value={5}>5</option><option value={10}>10</option><option value={20}>20</option></select></label>
          {hasFilters ? <button className="secondary-button hr-template-library__clear" onClick={clearFilters} type="button"><FilterX aria-hidden="true" size={17}/>Clear</button> : null}
        </div>

        <div className="hr-template-library__result-summary" aria-live="polite"><span><strong>{workspace.summary.matchingCount}</strong> matching forms</span><span>{workspace.pagination.totalCount ? `Page ${workspace.pagination.page} of ${workspace.pagination.totalPages}` : 'No pages'}</span></div>

        {workspace.items.length ? <div className="hr-template-library__list">
          {workspace.items.map((item) => {
            const expanded = expandedId === item.id
            return <article className="hr-template-library__item" key={item.id}>
              <button aria-expanded={expanded} className="hr-template-library__summary" onClick={() => setExpandedId(expanded ? null : item.id)} type="button">
                <span className="hr-template-library__code">{item.code}</span>
                <span className="hr-template-library__identity"><strong>{item.title}</strong><small>{item.category}</small></span>
                <span className={`hr-template-library__availability is-${item.availability}`}>{item.availability === 'available' ? 'File available' : 'Indexed'}</span>
                <ChevronDown aria-hidden="true" className={expanded ? 'rotated' : ''} size={20}/>
              </button>
              {expanded ? <div className="hr-template-library__details">
                <div><small>What this document is for</small><p>{item.purpose}</p></div>
                <dl>
                  <div><dt>Record class</dt><dd>{item.recordClass}</dd></div>
                  <div><dt>Intended audience</dt><dd>{audienceLabels[item.audience]}</dd></div>
                  <div><dt>Handling</dt><dd>{sensitivityLabels[item.sensitivity]}</dd></div>
                  <div><dt>Controlled source</dt><dd>{item.sourceFilename}</dd></div>
                </dl>
                <p className="hr-template-library__access-note">{item.availability === 'available' ? 'The controlled file has passed security review. Preview and download access will follow its assigned document permissions.' : 'The form is indexed now. Its file will not be released until the protected upload, malware scan, version, and recovery controls pass.'}</p>
              </div> : null}
            </article>
          })}
        </div> : <DataStatePanel icon={Search} title="No forms match these filters"><p>Try a broader term, another category, or clear the filters.</p></DataStatePanel>}

        <div className="hr-template-library__pagination">
          <button className="secondary-button" disabled={workspace.pagination.page <= 1} onClick={() => setFilters((current) => ({ ...current, page: Math.max(1, (current.page ?? 1) - 1) }))} type="button"><ChevronLeft aria-hidden="true" size={17}/>Previous</button>
          <span>{workspace.pagination.totalCount ? `${workspace.pagination.page} of ${workspace.pagination.totalPages}` : 'No pages'}</span>
          <button className="secondary-button" disabled={workspace.pagination.page >= workspace.pagination.totalPages} onClick={() => setFilters((current) => ({ ...current, page: (current.page ?? 1) + 1 }))} type="button">Next<ChevronRight aria-hidden="true" size={17}/></button>
        </div>
      </> : null}
    </section>
  )
}
