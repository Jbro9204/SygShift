export const THEME_STORAGE_KEY = 'sygshift.theme'

export type SygShiftTheme = 'light' | 'dark'

function systemTheme(): SygShiftTheme {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function getCurrentTheme(): SygShiftTheme {
  const documentTheme = document.documentElement.dataset.theme
  if (documentTheme === 'light' || documentTheme === 'dark') return documentTheme

  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme
  } catch {
    // The system preference remains a safe fallback when storage is unavailable.
  }

  return systemTheme()
}

export function applyTheme(theme: SygShiftTheme, persist = true): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    theme === 'dark' ? '#0d1013' : '#10100f',
  )

  if (!persist) return
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Theme selection still applies to this page when storage is unavailable.
  }
}
