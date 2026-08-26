import { describe, expect, it } from 'vitest'
import { resolveSupabaseConfig } from './supabase'

describe('supabase browser configuration', () => {
  it('uses the public fallback when Vite env vars are absent from the build host', () => {
    expect(resolveSupabaseConfig({}).isConfigured).toBe(true)
  })

  it('uses the public fallback when the release environment supplies blank values', () => {
    const config = resolveSupabaseConfig({
      PROD: true,
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_PUBLISHABLE_KEY: '',
    })

    expect(config.isConfigured).toBe(true)
    expect(config.supabaseUrl).toBe('https://eqkdfrbwtioiqtjsyglg.supabase.co')
    expect(config.supabasePublishableKey).toBe('sb_publishable_-uU9fD3XIeZ58r815-fl_Q_g4IIRPQ5')
  })

  it('keeps explicit blank local configuration available for disconnected-state tests', () => {
    expect(resolveSupabaseConfig({
      PROD: false,
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_PUBLISHABLE_KEY: '',
    }).isConfigured).toBe(false)
  })
})
