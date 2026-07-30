import { describe, expect, it } from 'vitest'
import { resolveSupabaseConfig } from './supabase'

describe('supabase browser configuration', () => {
  it('uses the public fallback when Vite env vars are absent from the build host', () => {
    expect(resolveSupabaseConfig({}).isConfigured).toBe(true)
  })

  it('allows tests and explicit blank config to exercise the setup-warning state', () => {
    expect(resolveSupabaseConfig({
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_PUBLISHABLE_KEY: '',
    }).isConfigured).toBe(false)
  })
})
