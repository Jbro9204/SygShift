import { type FormEvent, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowDownAZ,
  ArrowUpAZ,
  Bookmark,
  BriefcaseBusiness,
  ChevronLeft,
  ChevronRight,
  CircleUserRound,
  Search,
  ShieldCheck,
  UserRoundCheck,
  UsersRound,
  X,
} from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  deleteHrisPeopleView,
  getHrisPeopleWorkspace,
  saveHrisPeopleView,
  type HrisPeopleQuery,
  type HrisPeopleSavedView,
} from '../data/hrisPeople'
import { formatOperationalDateTime } from '../lib/time'

const statusLabels: Record<string, string> = {
  active: 'Active',
  inactive: 'Inactive',
  leave: 'On leave',
  onboarding: 'Onboarding',
  separated: 'Separated',
}

const accountLabels: Record<string, string> = {
  active: 'Account active',
  disabled: 'Account disabled',
  not_created: 'No account',
  pending: 'Activation pending',
}

const readinessLabels: Record<string, string> = {
  employee_number_missing: 'Employee number needed',
  hire_date_missing: 'Verified hire date needed',
  separation_date_missing: 'Verified separation date needed',
}

function titleCase(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

function formatDate(value: string | null): string {
  if (!value) return 'Not recorded'
  const [year, month, day] = value.split('-')
  return `${month}/${day}/${year}`
}

function queryFromView(view: HrisPeopleSavedView): HrisPeopleQuery {
  return {
    direction: view.direction,
    employmentType: view.employmentType,
    page: 1,
    pageSize: view.pageSize,
    role: view.role,
    search: view.search ?? '',
    sort: view.sort,
    status: view.status,
  }
}

export function HrisPeopleWorkspacePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const isOverview = location.pathname === '/hr'
  const [searchInput, setSearchInput] = useState('')
  const [query, setQuery] = useState<HrisPeopleQuery>({
    direction: 'asc',
    employmentType: 'all',
    page: 1,
    pageSize: isOverview ? 5 : 10,
    role: 'all',
    search: '',
    sort: 'legal_name',
    status: 'active',
  })
  const [saveViewOpen, setSaveViewOpen] = useState(false)
  const [viewName, setViewName] = useState('')

  useEffect(() => {
    setQuery((current) => ({ ...current, page: 1, pageSize: isOverview ? 5 : current.pageSize === 5 ? 10 : current.pageSize }))
  }, [isOverview])

  const workspaceQuery = useQuery({
    queryFn: () => getHrisPeopleWorkspace(query),
    queryKey: ['hris-people', query],
  })

  const saveViewMutation = useMutation({
    mutationFn: () => saveHrisPeopleView(viewName, query),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hris-people'] })
      setSaveViewOpen(false)
      setViewName('')
    },
  })

  const deleteViewMutation = useMutation({
    mutationFn: deleteHrisPeopleView,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['hris-people'] }),
  })

  const workspace = workspaceQuery.data

  useEffect(() => {
    if (workspace && (query.page ?? 1) > workspace.totalPages) {
      setQuery((current) => ({ ...current, page: workspace.totalPages }))
    }
  }, [query.page, workspace])

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setQuery((current) => ({ ...current, page: 1, search: searchInput.trim() }))
  }

  function updateFilter(key: keyof HrisPeopleQuery, value: string | number) {
    setQuery((current) => ({ ...current, [key]: value, page: 1 }))
  }

  function openEmployee(employeeId: string) {
    navigate(`/hr/people/${employeeId}`)
  }

  return (
    <main className="hr-people-page">
      <header className="hr-people-hero">
        <div>
          <p className="eyebrow">HR &amp; Finance</p>
          <h1>People &amp; HR</h1>
          <p>Review legal workforce records from one controlled workspace. Existing employee access, schedules, time, and payroll remain unchanged.</p>
        </div>
        <div className="hr-people-hero__security">
          <ShieldCheck aria-hidden="true" size={23} />
          <div><strong>Protected HR workspace</strong><span>MFA and assigned HR permission required</span></div>
        </div>
      </header>

      <nav aria-label="People and HR sections" className="hr-people-tabs">
        <Link className={isOverview ? 'active' : ''} to="/hr">Overview</Link>
        <Link className={!isOverview ? 'active' : ''} to="/hr/people">People</Link>
        {workspace?.canManage ? <Link to="/hr/identity-readiness">Data Readiness</Link> : null}
      </nav>

      {workspaceQuery.isPending ? <DataStatePanel icon={UsersRound} title="Loading People and HR"><p>Checking legal workforce records and protected access controls.</p></DataStatePanel> : null}
      {workspaceQuery.isError ? <DataStatePanel icon={AlertTriangle} tone="error" title="People and HR unavailable"><p>{workspaceQuery.error instanceof Error ? workspaceQuery.error.message : 'The protected HR workspace could not be loaded.'}</p></DataStatePanel> : null}

      {workspace ? (
        <>
          {isOverview ? (
            <>
              <section aria-label="Workforce overview" className="hr-people-summary">
                <article><UserRoundCheck aria-hidden="true" /><span>Active</span><strong>{workspace.summary.active}</strong><small>Current employees</small></article>
                <article><BriefcaseBusiness aria-hidden="true" /><span>Onboarding</span><strong>{workspace.summary.onboarding}</strong><small>Joining the workforce</small></article>
                <article><CircleUserRound aria-hidden="true" /><span>On leave</span><strong>{workspace.summary.leave}</strong><small>Current leave status</small></article>
                <article className={workspace.summary.attention > 0 ? 'attention' : ''}><AlertTriangle aria-hidden="true" /><span>Needs attention</span><strong>{workspace.summary.attention}</strong><small>Record-readiness signals</small></article>
              </section>

              <section className="hr-people-overview-grid">
                <article className="hr-people-panel">
                  <div className="hr-people-panel__heading"><div><p className="eyebrow">Priority work</p><h2>Items to review</h2></div><span>{workspace.priorityQueue.length}</span></div>
                  {workspace.priorityQueue.length === 0 ? <p className="hr-people-empty">No priority employee-record items are waiting.</p> : (
                    <div className="hr-people-queue">
                      {workspace.priorityQueue.map((item) => (
                        <button key={item.employeeId} onClick={() => openEmployee(item.employeeId)} type="button">
                          <span><strong>{item.legalName}</strong><small>{item.reason}</small></span><ChevronRight aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  )}
                </article>
                <article className="hr-people-panel">
                  <div className="hr-people-panel__heading"><div><p className="eyebrow">Active workforce</p><h2>Employee snapshot</h2></div><Link to="/hr/people">View all</Link></div>
                  <div className="hr-people-compact-list">
                    {workspace.items.map((employee) => (
                      <button key={employee.employeeId} onClick={() => openEmployee(employee.employeeId)} type="button">
                        <span><strong>{employee.legalName}</strong><small>{employee.jobTitle || titleCase(employee.primaryRole)}</small></span><span className={`hr-account-pill hr-account-pill--${employee.accountStatus}`}>{accountLabels[employee.accountStatus]}</span>
                      </button>
                    ))}
                  </div>
                </article>
              </section>
            </>
          ) : (
            <section className="hr-people-workspace">
              <div className="hr-people-workspace__heading">
                <div><p className="eyebrow">Employee records</p><h2>People</h2><p>Legal names are used throughout this protected HR workspace.</p></div>
                <div className="hr-people-workspace__actions"><span>{workspace.totalCount} matching</span><button className="secondary-button" onClick={() => setSaveViewOpen(true)} type="button"><Bookmark aria-hidden="true" size={17} />Save view</button></div>
              </div>

              {workspace.savedViews.length > 0 ? (
                <div className="hr-saved-views" aria-label="Saved people views">
                  <span>Saved views</span>
                  {workspace.savedViews.map((view) => (
                    <div key={view.id}><button onClick={() => { setSearchInput(view.search ?? ''); setQuery(queryFromView(view)) }} type="button">{view.name}</button><button aria-label={`Delete ${view.name}`} disabled={deleteViewMutation.isPending} onClick={() => deleteViewMutation.mutate(view.id)} type="button"><X aria-hidden="true" size={14} /></button></div>
                  ))}
                </div>
              ) : null}

              <div className="hr-people-filters">
                <form onSubmit={submitSearch}><label htmlFor="hr-people-search">Search</label><div><Search aria-hidden="true" size={18} /><input id="hr-people-search" onChange={(event) => setSearchInput(event.target.value)} placeholder="Legal name, employee number, or username" value={searchInput} /></div><button className="secondary-button" type="submit">Search</button></form>
                <label>Status<select onChange={(event) => updateFilter('status', event.target.value)} value={query.status}><option value="active">Active</option><option value="onboarding">Onboarding</option><option value="leave">On leave</option><option value="inactive">Inactive</option><option value="separated">Separated</option><option value="all">All statuses</option></select></label>
                <label>Employment<select onChange={(event) => updateFilter('employmentType', event.target.value)} value={query.employmentType}><option value="all">All types</option>{workspace.options.employmentTypes.map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}</select></label>
                <label>Role<select onChange={(event) => updateFilter('role', event.target.value)} value={query.role}><option value="all">All roles</option>{workspace.options.roles.map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}</select></label>
                <label>Sort<select onChange={(event) => updateFilter('sort', event.target.value)} value={query.sort}><option value="legal_name">Legal name</option><option value="employee_number">Employee number</option><option value="status">Status</option><option value="hired_on">Hire date</option></select></label>
                <button aria-label="Reverse sort direction" className="hr-sort-button" onClick={() => updateFilter('direction', query.direction === 'asc' ? 'desc' : 'asc')} type="button">{query.direction === 'asc' ? <ArrowDownAZ aria-hidden="true" /> : <ArrowUpAZ aria-hidden="true" />}</button>
              </div>

              {workspace.items.length === 0 ? <DataStatePanel icon={Search} title="No people match these filters"><p>Clear the search or choose another filter.</p></DataStatePanel> : (
                <div className="hr-people-list" role="list">
                  {workspace.items.map((employee) => (
                    <button className="hr-people-row" key={employee.employeeId} onClick={() => openEmployee(employee.employeeId)} role="listitem" type="button">
                      <span className="hr-people-row__identity"><span aria-hidden="true">{employee.legalName.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span><span><strong>{employee.legalName}</strong><small>{employee.employeeNumber || 'Employee number pending'} · @{employee.username}</small></span></span>
                      <span><small>Employment</small><strong>{titleCase(employee.employmentType)}</strong><small>{employee.jobTitle || titleCase(employee.primaryRole)}</small></span>
                      <span><small>Status</small><strong>{statusLabels[employee.status]}</strong><small>Hired {formatDate(employee.hiredOn)}</small></span>
                      <span><small>Account</small><strong>{accountLabels[employee.accountStatus]}</strong><small>{employee.lastSignInAt ? `Last sign-in ${formatOperationalDateTime(employee.lastSignInAt)}` : 'No sign-in recorded'}</small></span>
                      <span className="hr-people-row__signals">{employee.readinessSignals.length === 0 ? <em>Record ready</em> : employee.readinessSignals.map((signal) => <em key={signal}>{readinessLabels[signal] ?? titleCase(signal)}</em>)}</span>
                      <ChevronRight aria-hidden="true" />
                    </button>
                  ))}
                </div>
              )}

              <div className="hr-people-pagination">
                <label>Rows<select onChange={(event) => updateFilter('pageSize', Number(event.target.value))} value={query.pageSize}><option value={10}>10</option><option value={15}>15</option><option value={25}>25</option></select></label>
                <span>Page {workspace.page} of {workspace.totalPages}</span>
                <div><button aria-label="Previous page" className="secondary-button" disabled={workspace.page <= 1} onClick={() => setQuery((current) => ({ ...current, page: Math.max((current.page ?? 1) - 1, 1) }))} type="button"><ChevronLeft aria-hidden="true" /></button><button aria-label="Next page" className="secondary-button" disabled={workspace.page >= workspace.totalPages} onClick={() => setQuery((current) => ({ ...current, page: Math.min((current.page ?? 1) + 1, workspace.totalPages) }))} type="button"><ChevronRight aria-hidden="true" /></button></div>
              </div>
            </section>
          )}
        </>
      ) : null}

      {saveViewOpen ? (
        <ModalDialog busy={saveViewMutation.isPending} busyLabel="Saving view…" className="hr-save-view-modal" description="Store the current search, filters, sort, and row count for your account only." onClose={() => { saveViewMutation.reset(); setSaveViewOpen(false) }} title="Save current People view">
          <form onSubmit={(event) => { event.preventDefault(); saveViewMutation.mutate() }}>
            <label>View name<input autoFocus maxLength={80} onChange={(event) => setViewName(event.target.value)} placeholder="Example: Active hourly employees" required value={viewName} /></label>
            {saveViewMutation.isError ? <div className="error-message" role="alert">{saveViewMutation.error instanceof Error ? saveViewMutation.error.message : 'The view could not be saved.'}</div> : null}
            <div className="modal-actions"><button className="secondary-button" onClick={() => setSaveViewOpen(false)} type="button">Cancel</button><button className="primary-action" disabled={!viewName.trim()} type="submit">Save view</button></div>
          </form>
        </ModalDialog>
      ) : null}
    </main>
  )
}
