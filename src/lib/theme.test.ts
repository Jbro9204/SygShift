import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, getCurrentTheme, THEME_STORAGE_KEY } from './theme'

afterEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.style.removeProperty('color-scheme')
  vi.restoreAllMocks()
})

describe('SygShift theme preference', () => {
  it('uses and applies a saved preference', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')

    expect(getCurrentTheme()).toBe('dark')
    applyTheme('dark')

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })

  it('falls back safely when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(getCurrentTheme()).toBe('light')
  })

  it('persists an explicit selection', () => {
    applyTheme('light')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })
})
