import { type FormEvent, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, DatabaseZap, Edit3, MapPin, Plus, Search, ShieldAlert, Trash2 } from 'lucide-react'
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
  type Site,
  type SiteMutationInput,
  type SitePost,
} from '../data/workforce'
import { isSupabaseConfigured } from '../lib/supabase'

function formatPostTime(value: string | null): string {
  if (!value) return 'Time set per shift'
  const [hours, minutes] = value.split(':').map(Number)
  const suffix = hours >= 12 ? 'PM' : 'AM'
  const hour = hours % 12 || 12
  return `${hour}:${String(minutes).padStart(2, '0')} ${suffix}`
}

function optionalField(data: FormData, key: string): string | null {
  const value = String(data.get(key) ?? '').trim()
  return value || null
}

function siteFormPayload(form: HTMLFormElement, siteId?: string): SiteMutationInput {
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

function postFormPayload(form: HTMLFormElement, siteId: string, postId?: string): PostMutationInput {
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
        <div className="form-grid form-grid--two">
          <label><span>Site name</span><input defaultValue={site?.name ?? ''} name="name" required /></label>
          <label><span>Site code</span><input defaultValue={site?.code ?? ''} name="code" placeholder="Optional" /></label>
        </div>
        <div className="form-grid form-grid--two">
          <label><span>Address</span><input defaultValue={site?.address_line_1 ?? ''} name="addressLine1" /></label>
          <label><span>City</span><input defaultValue={site?.city ?? ''} name="city" /></label>
        </div>
        <div className="form-grid form-grid--three">
          <label><span>State/region</span><input defaultValue={site?.region ?? ''} name="region" /></label>
          <label><span>Postal code</span><input defaultValue={site?.postal_code ?? ''} name="postalCode" /></label>
          <label><span>Time zone</span><input defaultValue={site?.time_zone ?? 'America/Denver'} name="timeZone" required /></label>
        </div>
        <label className="check-field">
          <input defaultChecked={site?.active ?? true} name="active" type="checkbox" />
          Active site
        </label>
        {error ? <div className="inline-alert" role="alert">{error.message}</div> : null}
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">Cancel</button>
          <button className="primary-action" disabled={busy} type="submit">{busy ? 'Saving...' : 'Save site'}</button>
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
      description={`Post belongs to ${site.name}.`}
      onClose={onClose}
      title={post ? `Edit ${post.name}` : 'Add post'}
    >
      <form className="request-form site-editor-form" onSubmit={submit}>
        <div className="form-grid form-grid--three">
          <label><span>Post name</span><input defaultValue={post?.name ?? ''} name="name" required /></label>
          <label><span>Default start</span><input defaultValue={post?.default_start_time ?? ''} name="defaultStartTime" type="time" /></label>
          <label><span>Default end</span><input defaultValue={post?.default_end_time ?? ''} name="defaultEndTime" type="time" /></label>
        </div>
        <div className="site-editor-checks">
          <label className="check-field">
            <input defaultChecked={post?.requires_armed ?? false} name="requiresArmed" type="checkbox" />
            Armed post
          </label>
          <label className="check-field">
            <input defaultChecked={post?.active ?? true} name="active" type="checkbox" />
            Active post
          </label>
        </div>
        {error ? <div className="inline-alert" role="alert">{error.message}</div> : null}
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">Cancel</button>
          <button className="primary-action" disabled={busy} type="submit">{busy ? 'Saving...' : 'Save post'}</button>
        </div>
      </form>
    </ModalDialog>
  )
}

export function SitesPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [siteEditor, setSiteEditor] = useState<Site | 'new' | null>(null)
  const [postEditor, setPostEditor] = useState<{ site: Site; post?: SitePost } | null>(null)

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
  const canManageSites = Boolean(sessionQuery.data?.permissions.includes('sites.manage'))
  const recentlyDeletedQuery = useQuery({
    enabled: Boolean(canManageSites),
    queryFn: getRecentlyDeletedSitesAndPosts,
    queryKey: ['recently-deleted-sites-posts'],
  })

  const filteredSites = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return (sitesQuery.data ?? []).filter((site) => {
      const searchable = [site.name, site.code, site.city, ...site.posts.map((post) => post.name)]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase()
      return !term || searchable.includes(term)
    })
  }, [search, sitesQuery.data])

  const siteMutation = useMutation({
    mutationFn: upsertSite,
    onSuccess: async (sites) => {
      queryClient.setQueryData(['sites-with-posts'], sites)
      setSiteEditor(null)
      await queryClient.invalidateQueries({ queryKey: ['sites-with-posts'], refetchType: 'active' })
    },
  })
  const postMutation = useMutation({
    mutationFn: upsertPost,
    onSuccess: async (sites) => {
      queryClient.setQueryData(['sites-with-posts'], sites)
      setPostEditor(null)
      await queryClient.invalidateQueries({ queryKey: ['sites-with-posts'], refetchType: 'active' })
    },
  })
  const deleteSiteMutation = useMutation({
    mutationFn: deleteUnusedSite,
    onSuccess: async (sites) => {
      queryClient.setQueryData(['sites-with-posts'], sites)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sites-with-posts'], refetchType: 'active' }),
        queryClient.invalidateQueries({ queryKey: ['recently-deleted-sites-posts'], refetchType: 'active' }),
      ])
    },
  })
  const deletePostMutation = useMutation({
    mutationFn: deleteUnusedPost,
    onSuccess: async (sites) => {
      queryClient.setQueryData(['sites-with-posts'], sites)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sites-with-posts'], refetchType: 'active' }),
        queryClient.invalidateQueries({ queryKey: ['recently-deleted-sites-posts'], refetchType: 'active' }),
      ])
    },
  })

  return (
    <div className="page page--workforce">
      <section className="page-intro workforce-intro">
        <div>
          <p className="eyebrow">Workforce</p>
          <h1>Sites &amp; posts</h1>
          <p className="page-summary">
            A clean operating list of every location and post, with armed requirements and normal
            coverage times visible before anyone is assigned.
          </p>
        </div>
      </section>

      {!isSupabaseConfigured ? (
        <DataStatePanel icon={DatabaseZap} title="Site registry ready for reviewed data" tone="setup">
          <p>
            Source names and locations will appear only after duplicate and ambiguous workbook entries
            are reviewed. No site will be silently merged or guessed.
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
        <DataStatePanel icon={ShieldAlert} title="Sites unavailable" tone="error">
          <p>{sitesQuery.error.message}</p>
        </DataStatePanel>
      ) : (
        <>
          <section className="workforce-toolbar workforce-toolbar--single site-management-toolbar" aria-label="Site controls">
            <label className="search-field search-field--wide">
              <Search aria-hidden="true" size={20} />
              <span className="visually-hidden">Search sites and posts</span>
              <input
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search sites, posts, codes, or cities"
                type="search"
                value={search}
              />
            </label>
            {canManageSites ? (
              <button className="primary-action" onClick={() => setSiteEditor('new')} type="button">
                <Plus aria-hidden="true" size={18} />
                Add site
              </button>
            ) : null}
          </section>

          {deleteSiteMutation.isError ? <div className="inline-alert" role="alert">{deleteSiteMutation.error.message}</div> : null}
          {deletePostMutation.isError ? <div className="inline-alert" role="alert">{deletePostMutation.error.message}</div> : null}

          {filteredSites.length === 0 ? (
            <DataStatePanel icon={Building2} title="No sites match this search">
              <p>Clear or change the search to see other locations.</p>
            </DataStatePanel>
          ) : (
            <section className="site-grid" aria-label="Site registry">
              {filteredSites.map((site) => (
                <article className="site-card" key={site.id}>
                  <header>
                    <div>
                      <p>{site.code || 'No site code'}</p>
                      <h2>{site.name}</h2>
                    </div>
                    <div className="site-card__status">
                      <span className={site.active ? 'status-badge status-badge--active' : 'status-badge status-badge--inactive'}>
                        {site.active ? 'Active' : 'Inactive'}
                      </span>
                      {canManageSites ? (
                        <div className="site-card__actions">
                          <button className="icon-button" aria-label={`Edit ${site.name}`} onClick={() => setSiteEditor(site)} type="button">
                            <Edit3 aria-hidden="true" size={17} />
                          </button>
                          <button
                            className="icon-button icon-button--danger"
                            aria-label={`Delete ${site.name}`}
                            disabled={deleteSiteMutation.isPending || site.posts.length > 0}
                            onClick={() => {
                              if (window.confirm(`Delete ${site.name}? This only succeeds if it has no posts or operational history.`)) {
                                deleteSiteMutation.mutate(site.id)
                              }
                            }}
                            type="button"
                          >
                            <Trash2 aria-hidden="true" size={17} />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </header>
                  <div className="site-location">
                    <MapPin aria-hidden="true" size={19} />
                    <span>
                      {[site.address_line_1, site.city, site.region, site.postal_code]
                        .filter(Boolean)
                        .join(', ') || 'Address pending review'}
                    </span>
                  </div>
                  <div className="post-list">
                    <div className="post-list__heading">
                      <h3>Posts</h3>
                      <span>{site.posts.length}</span>
                    </div>
                    {site.posts.length === 0 ? (
                      <p className="post-list__empty">No posts have been approved for this site.</p>
                    ) : site.posts.map((post) => (
                      <div className="post-row" key={post.id}>
                        <div>
                          <strong>{post.name}</strong>
                          <span>
                            {formatPostTime(post.default_start_time)}
                            {post.default_end_time ? ` - ${formatPostTime(post.default_end_time)}` : ''}
                          </span>
                        </div>
                        <div className="post-row__right">
                          <span className={post.requires_armed ? 'qualification qualification--armed' : 'qualification'}>
                            {post.requires_armed ? 'Armed' : 'Unarmed'}
                          </span>
                          {canManageSites ? (
                            <div className="post-row__actions">
                              <button className="icon-button" aria-label={`Edit ${post.name}`} onClick={() => setPostEditor({ post, site })} type="button">
                                <Edit3 aria-hidden="true" size={16} />
                              </button>
                              <button
                                className="icon-button icon-button--danger"
                                aria-label={`Delete ${post.name}`}
                                disabled={deletePostMutation.isPending}
                                onClick={() => {
                                  if (window.confirm(`Delete ${post.name}? This only succeeds if it has no shift history.`)) {
                                    deletePostMutation.mutate(post.id)
                                  }
                                }}
                                type="button"
                              >
                                <Trash2 aria-hidden="true" size={16} />
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                    {canManageSites ? (
                      <button className="secondary-button secondary-button--small post-list__add" onClick={() => setPostEditor({ site })} type="button">
                        <Plus aria-hidden="true" size={16} />
                        Add post
                      </button>
                    ) : null}
                    {canManageSites && site.posts.length > 0 ? (
                      <p className="form-note">Delete posts before deleting an unused site.</p>
                    ) : null}
                  </div>
                </article>
              ))}
            </section>
          )}

          {canManageSites ? (
            <section className="recently-deleted-panel" aria-labelledby="recently-deleted-sites-title">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Retention</p>
                  <h2 id="recently-deleted-sites-title">Recently deleted sites and posts</h2>
                </div>
                <span className="status-pill">14 days</span>
              </div>
              {recentlyDeletedQuery.isPending ? (
                <p className="form-note">Loading deleted site/post metadata.</p>
              ) : recentlyDeletedQuery.isError ? (
                <div className="inline-alert" role="alert">{recentlyDeletedQuery.error.message}</div>
              ) : recentlyDeletedQuery.data?.length ? (
                <div className="recently-deleted-list">
                  {recentlyDeletedQuery.data.map((record) => (
                    <article key={record.id}>
                      <strong>{record.displayName}</strong>
                      <span>{record.recordType} deleted {new Date(record.deletedAt).toLocaleString()} - retained until {new Date(record.expiresAt).toLocaleDateString()}</span>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="form-note">No deleted site or post metadata is currently in the 14-day retention window.</p>
              )}
            </section>
          ) : null}
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
    </div>
  )
}
