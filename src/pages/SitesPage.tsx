import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Building2, DatabaseZap, MapPin, Search, ShieldAlert } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { getSites } from '../data/workforce'
import { isSupabaseConfigured } from '../lib/supabase'

function formatPostTime(value: string | null): string {
  if (!value) return 'Time set per shift'
  const [hours, minutes] = value.split(':').map(Number)
  const suffix = hours >= 12 ? 'PM' : 'AM'
  const hour = hours % 12 || 12
  return `${hour}:${String(minutes).padStart(2, '0')} ${suffix}`
}
export function SitesPage() {
  const [search, setSearch] = useState('')
  const sitesQuery = useQuery({
    queryKey: ['sites-with-posts'],
    queryFn: getSites,
    enabled: isSupabaseConfigured,
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
          <section className="workforce-toolbar workforce-toolbar--single" aria-label="Site controls">
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
          </section>

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
                    <span className={site.active ? 'status-badge status-badge--active' : 'status-badge status-badge--inactive'}>
                      {site.active ? 'Active' : 'Inactive'}
                    </span>
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
                            {post.default_end_time ? ` – ${formatPostTime(post.default_end_time)}` : ''}
                          </span>
                        </div>
                        <span className={post.requires_armed ? 'qualification qualification--armed' : 'qualification'}>
                          {post.requires_armed ? 'Armed' : 'Unarmed'}
                        </span>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  )
}
