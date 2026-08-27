import type { Site, SitePost } from '../data/workforce'
import { formatDualClockTime } from '../lib/time'

export type SiteStatusFilter = 'active' | 'inactive' | 'all'

export function siteAddress(site: Site): string {
  const cityRegion = [site.city, site.region].filter(Boolean).join(', ')
  return (
    [site.address_line_1, cityRegion, site.postal_code]
      .filter(Boolean)
      .join(' ') || 'Address pending review'
  )
}

export function siteCoverageLabel(site: Site): string {
  const activePosts = site.posts.filter((post) => post.active)
  const armed = activePosts.filter((post) => post.requires_armed).length
  const unarmed = activePosts.length - armed
  if (armed && unarmed) return `${armed} armed · ${unarmed} unarmed`
  if (armed) return `${armed} armed ${armed === 1 ? 'post' : 'posts'}`
  if (unarmed) return `${unarmed} unarmed ${unarmed === 1 ? 'post' : 'posts'}`
  return 'No active coverage'
}

export function postCountLabel(count: number, expanded = false): string {
  return `${count} ${count === 1 ? 'post' : 'posts'} ${expanded ? '−' : '+'}`
}

export function postCoverageTime(post: SitePost): string {
  if (post.default_start_time && post.default_end_time) {
    return `${formatDualClockTime(post.default_start_time)} – ${formatDualClockTime(post.default_end_time)}`
  }
  if (post.default_start_time) {
    return `${formatDualClockTime(post.default_start_time)} – end set per shift`
  }
  if (post.default_end_time) {
    return `Start set per shift – ${formatDualClockTime(post.default_end_time)}`
  }
  return 'Time set per shift'
}

export function filterSites(
  sites: Site[],
  search: string,
  status: SiteStatusFilter,
): Site[] {
  const term = search.trim().toLocaleLowerCase()
  return sites.filter((site) => {
    if (status === 'active' && !site.active) return false
    if (status === 'inactive' && site.active) return false
    const searchable = [
      site.name,
      site.code,
      site.address_line_1,
      site.city,
      site.region,
      site.postal_code,
      site.time_zone,
      ...site.posts.map((post) => post.name),
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
    return !term || searchable.includes(term)
  })
}
