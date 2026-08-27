import { type FormEvent, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Building2,
  ChevronDown,
  ChevronUp,
  DatabaseZap,
  Edit3,
  MapPin,
  Plus,
  Search,
  ShieldAlert,
  Trash2,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { getSessionContext } from '../data/auth'
import {
  deleteUnusedPost,
  deleteUnusedSite,
  getRecentlyDeletedSitesAndPosts,
  getSites,
  upsertPost,
  upsertSite,
  type PostMutationInput,
  type RecentlyDeletedRecord,
  type Site,
  type SiteMutationInput,
  type SitePost,
} from '../data/workforce'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'
import {
  filterSites,
  postCountLabel,
  postCoverageTime,
  siteAddress,
  siteCoverageLabel,
  type SiteStatusFilter,
} from './sitesDirectory'

function formatDateTime(value: string): string {
  return formatOperationalDateTime(value, { includeTimeZoneName: true })
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'America/Denver',
    year: 'numeric',
  }).format(new Date(value))
}

function optionalField(data: FormData, key: string): string | null {
  const value = String(data.get(key) ?? '').trim()
  return value || null
}

function siteFormPayload(
  form: HTMLFormElement,
  siteId?: string,
): SiteMutationInput {
  const data = new FormData(form)
  return {
    active: data.get('active') === 'on',
    addressLine1: optionalField(data, 'addressLine1'),
    city: optionalField(data, 'city'),
    code: optionalField(data, 'code'),
    name: String(data.get('name') ?? '').trim(),
    postalCode: optionalField(data, 'postalCode'),
    region: optionalField(data, 'region'),
    siteId,
    timeZone: optionalField(data, 'timeZone') ?? 'America/Denver',
  }
}

function postFormPayload(
  form: HTMLFormElement,
  siteId: string,
  postId?: string,
): PostMutationInput {
  const data = new FormData(form)
  return {
    active: data.get('active') === 'on',
    defaultEndTime: optionalField(data, 'defaultEndTime'),
    defaultStartTime: optionalField(data, 'defaultStartTime'),
    name: String(data.get('name') ?? '').trim(),
    postId,
    requiresArmed: data.get('requiresArmed') === 'on',
    siteId,
  }
}

function SiteEditorModal({
  busy,
  error,
  onClose,
  onSubmit,
  site,
}: {
  busy: boolean
  error: Error | null
  onClose: () => void
  onSubmit: (payload: SiteMutationInput) => void
  site?: Site
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSubmit(siteFormPayload(event.currentTarget, site?.id))
  }
  return (
    <ModalDialog
      busy={busy}
      busyLabel="Saving site..."
      className="modal-dialog--site-editor"
      description="Create or update the operating location used by schedules and posts."
      onClose={onClose}
      title={site ? `Edit ${site.name}` : 'Add site'}
    >
      <form className="request-form site-editor-form" onSubmit={submit}>
        <fieldset className="site-editor-section">
          <legend>Site identity</legend>
          <div className="form-grid form-grid--two">
            <label>
              <span>Site name</span>
              <input defaultValue={site?.name ?? ''} name="name" required />
            </label>
            <label>
              <span>
                Site code <small>Optional</small>
              </span>
              <input defaultValue={site?.code ?? ''} name="code" />
            </label>
          </div>
          <label className="check-field">
            <input
              defaultChecked={site?.active ?? true}
              name="active"
              type="checkbox"
            />
            Active site
          </label>
        </fieldset>
        <fieldset className="site-editor-section">
          <legend>Location</legend>
          <div className="form-grid form-grid--two">
            <label>
              <span>Address</span>
              <input
                defaultValue={site?.address_line_1 ?? ''}
                name="addressLine1"
              />
            </label>
            <label>
              <span>City</span>
              <input defaultValue={site?.city ?? ''} name="city" />
            </label>
          </div>
          <div className="form-grid form-grid--three">
            <label>
              <span>State/region</span>
              <input defaultValue={site?.region ?? ''} name="region" />
            </label>
            <label>
              <span>Postal code</span>
              <input defaultValue={site?.postal_code ?? ''} name="postalCode" />
            </label>
            <label>
              <span>Time zone</span>
              <input
                defaultValue={site?.time_zone ?? 'America/Denver'}
                name="timeZone"
                required
              />
            </label>
          </div>
        </fieldset>
        {error ? (
          <div className="inline-alert" role="alert">
            {error.message}
          </div>
        ) : null}
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="primary-action" disabled={busy} type="submit">
            {busy ? 'Saving...' : 'Save site'}
          </button>
        </div>
      </form>
    </ModalDialog>
  )
}

function PostEditorModal({
  busy,
  error,
  onClose,
  onSubmit,
  post,
  site,
}: {
  busy: boolean
  error: Error | null
  onClose: () => void
  onSubmit: (payload: PostMutationInput) => void
  post?: SitePost
  site: Site
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSubmit(postFormPayload(event.currentTarget, site.id, post?.id))
  }
  return (
    <ModalDialog
      busy={busy}
      busyLabel="Saving post..."
      className="modal-dialog--site-editor"
      description={
        post
          ? `Update the post at ${site.name}.`
          : `Add a post to ${site.name}.`
      }
      onClose={onClose}
      title={post ? `Edit ${post.name}` : 'Add post'}
    >
      <form className="request-form site-editor-form" onSubmit={submit}>
        <div className="post-parent-context">
          <span>Parent site</span>
          <strong>
            {site.name}
            {site.code ? ` · ${site.code}` : ''}
          </strong>
        </div>
        <div className="form-grid form-grid--three">
          <label>
            <span>Post name</span>
            <input defaultValue={post?.name ?? ''} name="name" required />
          </label>
          <label>
            <span>
              Default start <small>Optional</small>
            </span>
            <input
              defaultValue={post?.default_start_time ?? ''}
              name="defaultStartTime"
              type="time"
            />
          </label>
          <label>
            <span>
              Default end <small>Optional</small>
            </span>
            <input
              defaultValue={post?.default_end_time ?? ''}
              name="defaultEndTime"
              type="time"
            />
          </label>
        </div>
        <p className="form-note">
          Default coverage times can be changed when creating an individual
          shift.
        </p>
        <div className="site-editor-checks">
          <label className="check-field">
            <input
              defaultChecked={post?.requires_armed ?? false}
              name="requiresArmed"
              type="checkbox"
            />
            Armed post
          </label>
          <label className="check-field">
            <input
              defaultChecked={post?.active ?? true}
              name="active"
              type="checkbox"
            />
            Active post
          </label>
        </div>
        {error ? (
          <div className="inline-alert" role="alert">
            {error.message}
          </div>
        ) : null}
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="primary-action" disabled={busy} type="submit">
            {busy ? 'Saving...' : 'Save post'}
          </button>
        </div>
      </form>
    </ModalDialog>
  )
}

function ManageSiteModal({
  busy,
  error,
  onAddPost,
  onClose,
  onDelete,
  onEdit,
  site,
}: {
  busy: boolean
  error: Error | null
  onAddPost: () => void
  onClose: () => void
  onDelete: () => void
  onEdit: () => void
  site: Site
}) {
  const hasPosts = site.posts.length > 0
  return (
    <ModalDialog
      busy={busy}
      busyLabel="Deleting site..."
      className="modal-dialog--site-manager"
      description="Work with this location or review its protected deletion controls."
      onClose={onClose}
      title={`Manage ${site.name}`}
    >
      <div className="site-manager-summary">
        <div>
          <span>Site code</span>
          <strong>{site.code || 'Not assigned'}</strong>
        </div>
        <div>
          <span>Status</span>
          <strong>{site.active ? 'Active' : 'Inactive'}</strong>
        </div>
        <div>
          <span>Posts</span>
          <strong>{site.posts.length}</strong>
        </div>
      </div>
      <div className="site-manager-actions">
        <button className="secondary-button" onClick={onEdit} type="button">
          <Edit3 aria-hidden="true" size={17} />
          Edit site
        </button>
        <button className="secondary-button" onClick={onAddPost} type="button">
          <Plus aria-hidden="true" size={17} />
          Add post
        </button>
      </div>
      <section
        className="site-danger-zone"
        aria-labelledby={`delete-site-${site.id}`}
      >
        <div>
          <p className="eyebrow">Protected action</p>
          <h3 id={`delete-site-${site.id}`}>Delete unused site</h3>
          <p>
            {hasPosts
              ? 'Delete or otherwise resolve this site’s posts before deleting the site.'
              : 'Deletion succeeds only when the site has no protected schedule, event, credential, or historical references.'}
          </p>
        </div>
        <button
          className="secondary-button danger-button"
          disabled={busy || hasPosts}
          onClick={onDelete}
          type="button"
        >
          <Trash2 aria-hidden="true" size={17} />
          Delete site
        </button>
      </section>
      {error ? (
        <div className="inline-alert" role="alert">
          {error.message}
        </div>
      ) : null}
      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose} type="button">
          Close
        </button>
      </div>
    </ModalDialog>
  )
}

function RecentlyDeletedModal({
  error,
  loading,
  onClose,
  records,
}: {
  error: Error | null
  loading: boolean
  onClose: () => void
  records: RecentlyDeletedRecord[]
}) {
  return (
    <ModalDialog
      className="modal-dialog--recently-deleted"
      description="Deleted site and post metadata remains available for 14 days."
      onClose={onClose}
      title="Recently deleted sites and posts"
    >
      <div className="retention-summary">
        <strong>14-day retention</strong>
        <span>No restoration controls are available in this workflow.</span>
      </div>
      {loading ? (
        <p className="form-note" role="status">
          Loading deleted site and post metadata.
        </p>
      ) : error ? (
        <div className="inline-alert" role="alert">
          {error.message}
        </div>
      ) : records.length ? (
        <div className="recently-deleted-list recently-deleted-list--modal">
          {records.map((record) => (
            <article key={record.id}>
              <div>
                <strong>{record.displayName}</strong>
                <small>{record.recordType === 'site' ? 'Site' : 'Post'}</small>
              </div>
              <span>
                Deleted {formatDateTime(record.deletedAt)} · retained through{' '}
                {formatDate(record.expiresAt)}
              </span>
            </article>
          ))}
        </div>
      ) : (
        <div className="site-retention-empty">
          <strong>No retained records</strong>
          <span>
            No deleted site or post metadata is currently in the 14-day window.
          </span>
        </div>
      )}
      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose} type="button">
          Close
        </button>
      </div>
    </ModalDialog>
  )
}

function ExpandedSite({
  canManage,
  deleteBusy,
  onAddPost,
  onDeletePost,
  onEditPost,
  onEditSite,
  site,
}: {
  canManage: boolean
  deleteBusy: boolean
  onAddPost: () => void
  onDeletePost: (post: SitePost) => void
  onEditPost: (post: SitePost) => void
  onEditSite: () => void
  site: Site
}) {
  return (
    <div
      className="site-expanded"
      id={`site-details-${site.id}`}
      role="region"
      aria-label={`${site.name} details`}
    >
      <div className="site-expanded__heading">
        <div>
          <p className="eyebrow">Site information</p>
          <h3>{site.name}</h3>
        </div>
        {canManage ? (
          <div className="site-expanded__actions">
            <button
              className="secondary-button"
              onClick={onEditSite}
              type="button"
            >
              <Edit3 aria-hidden="true" size={17} />
              Edit site
            </button>
            <button
              className="primary-action"
              onClick={onAddPost}
              type="button"
            >
              <Plus aria-hidden="true" size={17} />
              Add post
            </button>
          </div>
        ) : null}
      </div>
      <dl className="site-detail-grid">
        <div>
          <dt>Site code</dt>
          <dd>{site.code || 'Not assigned'}</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd>{site.address_line_1 || 'Address pending review'}</dd>
        </div>
        <div>
          <dt>City</dt>
          <dd>{site.city || 'Not provided'}</dd>
        </div>
        <div>
          <dt>State/region</dt>
          <dd>{site.region || 'Not provided'}</dd>
        </div>
        <div>
          <dt>Postal code</dt>
          <dd>{site.postal_code || 'Not provided'}</dd>
        </div>
        <div>
          <dt>Time zone</dt>
          <dd>{site.time_zone}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{site.active ? 'Active' : 'Inactive'}</dd>
        </div>
      </dl>
      <section className="site-posts" aria-labelledby={`site-posts-${site.id}`}>
        <div className="site-posts__heading">
          <div>
            <p className="eyebrow">Posts</p>
            <h3 id={`site-posts-${site.id}`}>Coverage posts</h3>
          </div>
          <span>
            {site.posts.length} {site.posts.length === 1 ? 'post' : 'posts'}
          </span>
        </div>
        {site.posts.length === 0 ? (
          <div className="site-posts__empty">
            <p>No posts have been added to this site.</p>
            {canManage ? (
              <button
                className="secondary-button"
                onClick={onAddPost}
                type="button"
              >
                <Plus aria-hidden="true" size={16} />
                Add post
              </button>
            ) : null}
          </div>
        ) : (
          <div className="site-post-directory">
            {site.posts.map((post) => (
              <article className="site-post-row" key={post.id}>
                <div className="site-post-row__identity">
                  <strong>{post.name}</strong>
                  <span>{post.active ? 'Active post' : 'Inactive post'}</span>
                </div>
                <div className="site-post-row__time">
                  <span>Default coverage</span>
                  <strong>{postCoverageTime(post)}</strong>
                </div>
                <div className="site-post-row__requirements">
                  <span
                    className={
                      post.requires_armed
                        ? 'qualification qualification--armed'
                        : 'qualification'
                    }
                  >
                    {post.requires_armed ? 'Armed required' : 'Unarmed'}
                  </span>
                  <span
                    className={
                      post.active
                        ? 'status-badge status-badge--active'
                        : 'status-badge status-badge--inactive'
                    }
                  >
                    {post.active ? 'Active' : 'Inactive'}
                  </span>
                </div>
                {canManage ? (
                  <div className="site-post-row__actions">
                    <button
                      aria-label={`Edit ${post.name}`}
                      className="secondary-button secondary-button--small"
                      onClick={() => onEditPost(post)}
                      type="button"
                    >
                      <Edit3 aria-hidden="true" size={15} />
                      Edit
                    </button>
                    <button
                      aria-label={`Delete ${post.name}`}
                      className="secondary-button danger-button secondary-button--small"
                      disabled={deleteBusy}
                      onClick={() => onDeletePost(post)}
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={15} />
                      Delete
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export function SitesPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<SiteStatusFilter>('all')
  const [expandedSiteId, setExpandedSiteId] = useState<string | null>(null)
  const [siteEditor, setSiteEditor] = useState<Site | 'new' | null>(null)
  const [postEditor, setPostEditor] = useState<{
    site: Site
    post?: SitePost
  } | null>(null)
  const [managedSite, setManagedSite] = useState<Site | null>(null)
  const [showRecentlyDeleted, setShowRecentlyDeleted] = useState(false)

  const sessionQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: getSessionContext,
    queryKey: ['session-context', 'sites'],
  })
  const sitesQuery = useQuery({
    queryKey: ['sites-with-posts'],
    queryFn: getSites,
    enabled: isSupabaseConfigured,
  })
  const canManageSites = Boolean(
    sessionQuery.data?.permissions.includes('sites.manage'),
  )
  const recentlyDeletedQuery = useQuery({
    enabled: Boolean(canManageSites),
    queryFn: getRecentlyDeletedSitesAndPosts,
    queryKey: ['recently-deleted-sites-posts'],
  })
  const filteredSites = useMemo(
    () => filterSites(sitesQuery.data ?? [], search, statusFilter),
    [search, sitesQuery.data, statusFilter],
  )

  const siteMutation = useMutation({
    mutationFn: upsertSite,
    onSuccess: async (sites) => {
      queryClient.setQueryData(['sites-with-posts'], sites)
      setSiteEditor(null)
      await queryClient.invalidateQueries({
        queryKey: ['sites-with-posts'],
        refetchType: 'active',
      })
    },
  })
  const postMutation = useMutation({
    mutationFn: upsertPost,
    onSuccess: async (sites, input) => {
      queryClient.setQueryData(['sites-with-posts'], sites)
      setExpandedSiteId(input.siteId)
      setPostEditor(null)
      await queryClient.invalidateQueries({
        queryKey: ['sites-with-posts'],
        refetchType: 'active',
      })
    },
  })
  const deleteSiteMutation = useMutation({
    mutationFn: deleteUnusedSite,
    onSuccess: async (sites) => {
      queryClient.setQueryData(['sites-with-posts'], sites)
      setManagedSite(null)
      setExpandedSiteId(null)
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['sites-with-posts'],
          refetchType: 'active',
        }),
        queryClient.invalidateQueries({
          queryKey: ['recently-deleted-sites-posts'],
          refetchType: 'active',
        }),
      ])
    },
  })
  const deletePostMutation = useMutation({
    mutationFn: deleteUnusedPost,
    onSuccess: async (sites) => {
      queryClient.setQueryData(['sites-with-posts'], sites)
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['sites-with-posts'],
          refetchType: 'active',
        }),
        queryClient.invalidateQueries({
          queryKey: ['recently-deleted-sites-posts'],
          refetchType: 'active',
        }),
      ])
    },
  })

  function openSiteEditor(site: Site | 'new') {
    siteMutation.reset()
    setSiteEditor(site)
  }
  function openPostEditor(site: Site, post?: SitePost) {
    postMutation.reset()
    setPostEditor({ post, site })
  }
  function deletePost(site: Site, post: SitePost) {
    deletePostMutation.reset()
    if (
      window.confirm(
        `Delete ${post.name} from ${site.name}? This only succeeds if the post has no protected shift or credential history.`,
      )
    )
      deletePostMutation.mutate(post.id)
  }

  return (
    <div className="page page--workforce sites-page">
      <section className="page-intro workforce-intro sites-page__intro">
        <div>
          <p className="eyebrow">Workforce</p>
          <h1>Sites &amp; Posts</h1>
          <p className="page-summary">
            Manage operating locations, coverage posts, armed requirements, and
            normal coverage times from one organized directory.
          </p>
        </div>
        {canManageSites ? (
          <button
            className="primary-action"
            onClick={() => openSiteEditor('new')}
            type="button"
          >
            <Plus aria-hidden="true" size={18} />
            Add Site
          </button>
        ) : null}
      </section>
      {!isSupabaseConfigured ? (
        <DataStatePanel
          icon={DatabaseZap}
          title="Site registry ready for reviewed data"
          tone="setup"
        >
          <p>
            Source names and locations will appear only after duplicate and
            ambiguous workbook entries are reviewed. No site will be silently
            merged or guessed.
          </p>
          <ul>
            <li>One searchable list of active and historical sites</li>
            <li>Reusable posts with clear armed requirements</li>
            <li>Mountain Time defaults with site-level time-zone support</li>
          </ul>
        </DataStatePanel>
      ) : sitesQuery.isPending ? (
        <DataStatePanel icon={Building2} title="Loading sites and posts">
          <p>Retrieving the locations your account is permitted to view.</p>
        </DataStatePanel>
      ) : sitesQuery.isError ? (
        <DataStatePanel
          icon={ShieldAlert}
          title="Sites unavailable"
          tone="error"
        >
          <p>{sitesQuery.error.message}</p>
        </DataStatePanel>
      ) : (
        <>
          <section
            className="workforce-toolbar site-management-toolbar"
            aria-label="Site directory controls"
          >
            <label className="search-field search-field--wide">
              <Search aria-hidden="true" size={20} />
              <span className="visually-hidden">Search sites and posts</span>
              <input
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search sites, posts, codes, cities, or addresses"
                type="search"
                value={search}
              />
            </label>
            <label className="select-field site-status-filter">
              <span>Site status</span>
              <select
                onChange={(event) =>
                  setStatusFilter(event.target.value as SiteStatusFilter)
                }
                value={statusFilter}
              >
                <option value="all">All sites</option>
                <option value="active">Active sites</option>
                <option value="inactive">Inactive sites</option>
              </select>
            </label>
            {canManageSites ? (
              <button
                className="secondary-button site-retention-button"
                onClick={() => setShowRecentlyDeleted(true)}
                type="button"
              >
                Recently Deleted <span>14 days</span>
              </button>
            ) : null}
          </section>
          {deletePostMutation.isError ? (
            <div className="inline-alert sites-page__alert" role="alert">
              {deletePostMutation.error.message}
            </div>
          ) : null}
          {filteredSites.length === 0 ? (
            <DataStatePanel
              icon={Building2}
              title="No sites match these controls"
            >
              <p>
                Clear the search or change the site-status filter to see other
                locations.
              </p>
            </DataStatePanel>
          ) : (
            <section className="site-directory" aria-label="Site directory">
              <div className="site-directory__header" aria-hidden="true">
                <span>Site</span>
                <span>Location</span>
                <span>Coverage</span>
                <span>Status</span>
                <span>Posts</span>
                <span>Actions</span>
              </div>
              <ul className="site-directory__list">
                {filteredSites.map((site) => {
                  const expanded = site.id === expandedSiteId
                  return (
                    <li
                      className={
                        expanded
                          ? 'site-directory__item site-directory__item--expanded'
                          : 'site-directory__item'
                      }
                      key={site.id}
                    >
                      <div className="site-directory__row">
                        <div className="site-directory__site">
                          <strong>{site.name}</strong>
                          <span>{site.code || 'No site code'}</span>
                        </div>
                        <div className="site-directory__location">
                          <MapPin aria-hidden="true" size={16} />
                          <span>{siteAddress(site)}</span>
                        </div>
                        <div className="site-directory__coverage">
                          <span>{siteCoverageLabel(site)}</span>
                        </div>
                        <div className="site-directory__status">
                          <span
                            className={
                              site.active
                                ? 'status-badge status-badge--active'
                                : 'status-badge status-badge--inactive'
                            }
                          >
                            {site.active ? 'Active' : 'Inactive'}
                          </span>
                        </div>
                        <div className="site-directory__posts">
                          <button
                            aria-controls={`site-details-${site.id}`}
                            aria-expanded={expanded}
                            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${site.name} posts`}
                            className="site-expand-button"
                            onClick={() =>
                              setExpandedSiteId(expanded ? null : site.id)
                            }
                            type="button"
                          >
                            <span>
                              {postCountLabel(site.posts.length, expanded)}
                            </span>
                            {expanded ? (
                              <ChevronUp aria-hidden="true" size={17} />
                            ) : (
                              <ChevronDown aria-hidden="true" size={17} />
                            )}
                          </button>
                        </div>
                        <div className="site-directory__actions">
                          {canManageSites ? (
                            <button
                              aria-label={`Manage ${site.name}`}
                              className="secondary-button secondary-button--small"
                              onClick={() => {
                                deleteSiteMutation.reset()
                                setManagedSite(site)
                              }}
                              type="button"
                            >
                              Manage
                            </button>
                          ) : null}
                        </div>
                      </div>
                      {expanded ? (
                        <ExpandedSite
                          canManage={canManageSites}
                          deleteBusy={deletePostMutation.isPending}
                          onAddPost={() => openPostEditor(site)}
                          onDeletePost={(post) => deletePost(site, post)}
                          onEditPost={(post) => openPostEditor(site, post)}
                          onEditSite={() => openSiteEditor(site)}
                          site={site}
                        />
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </>
      )}
      {siteEditor ? (
        <SiteEditorModal
          busy={siteMutation.isPending}
          error={siteMutation.isError ? siteMutation.error : null}
          onClose={() => setSiteEditor(null)}
          onSubmit={(payload) => siteMutation.mutate(payload)}
          site={siteEditor === 'new' ? undefined : siteEditor}
        />
      ) : null}
      {postEditor ? (
        <PostEditorModal
          busy={postMutation.isPending}
          error={postMutation.isError ? postMutation.error : null}
          onClose={() => setPostEditor(null)}
          onSubmit={(payload) => postMutation.mutate(payload)}
          post={postEditor.post}
          site={postEditor.site}
        />
      ) : null}
      {managedSite ? (
        <ManageSiteModal
          busy={deleteSiteMutation.isPending}
          error={deleteSiteMutation.isError ? deleteSiteMutation.error : null}
          onAddPost={() => {
            const site = managedSite
            setManagedSite(null)
            openPostEditor(site)
          }}
          onClose={() => {
            setManagedSite(null)
            deleteSiteMutation.reset()
          }}
          onDelete={() => {
            if (
              window.confirm(
                `Delete ${managedSite.name}? This cannot be undone and succeeds only if no protected operational history exists.`,
              )
            )
              deleteSiteMutation.mutate(managedSite.id)
          }}
          onEdit={() => {
            const site = managedSite
            setManagedSite(null)
            openSiteEditor(site)
          }}
          site={managedSite}
        />
      ) : null}
      {showRecentlyDeleted ? (
        <RecentlyDeletedModal
          error={
            recentlyDeletedQuery.isError ? recentlyDeletedQuery.error : null
          }
          loading={recentlyDeletedQuery.isPending}
          onClose={() => setShowRecentlyDeleted(false)}
          records={recentlyDeletedQuery.data ?? []}
        />
      ) : null}
    </div>
  )
}
