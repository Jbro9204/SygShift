export const INTERNAL_NAVIGATION_STORAGE_KEY = 'sygshift.internal-navigation.v1'

export interface InternalNavigationEntry {
  href: string
  scrollY: number
}

const MAX_INTERNAL_HISTORY = 40

export function internalHref(pathname: string, search = '', hash = ''): string {
  return `${pathname}${search}${hash}`
}

export function isSafeInternalHref(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/login')
}

export function parseInternalHistory(value: string | null): InternalNavigationEntry[] {
  if (!value) return []

  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is InternalNavigationEntry => (
      typeof entry === 'object'
      && entry !== null
      && 'href' in entry
      && typeof entry.href === 'string'
      && isSafeInternalHref(entry.href)
      && 'scrollY' in entry
      && typeof entry.scrollY === 'number'
      && Number.isFinite(entry.scrollY)
      && entry.scrollY >= 0
    )).slice(-MAX_INTERNAL_HISTORY)
  } catch {
    return []
  }
}

export function recordInternalLocation(
  entries: InternalNavigationEntry[],
  href: string,
  previousScrollY: number,
): InternalNavigationEntry[] {
  if (!isSafeInternalHref(href)) return entries

  const next = [...entries]
  const last = next.at(-1)
  if (last?.href === href) return next
  if (last) last.scrollY = Math.max(0, previousScrollY)
  next.push({ href, scrollY: 0 })
  return next.slice(-MAX_INTERNAL_HISTORY)
}

export function previousInternalLocation(
  entries: InternalNavigationEntry[],
  currentHref: string,
): { entries: InternalNavigationEntry[]; target: InternalNavigationEntry | null } {
  const next = [...entries]
  while (next.length > 0 && next.at(-1)?.href === currentHref) next.pop()
  const target = next.pop() ?? null
  return { entries: next, target }
}
