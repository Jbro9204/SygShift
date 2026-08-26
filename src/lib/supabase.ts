import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getTrustedDeviceToken } from './trustedDeviceToken'

const defaultSupabaseUrl = 'https://eqkdfrbwtioiqtjsyglg.supabase.co'
const defaultSupabasePublishableKey = 'sb_publishable_-uU9fD3XIeZ58r815-fl_Q_g4IIRPQ5'

type SupabaseBuildEnv = {
  PROD?: boolean
  VITE_SUPABASE_URL?: string
  VITE_SUPABASE_PUBLISHABLE_KEY?: string
}

export function resolveSupabaseConfig(env: SupabaseBuildEnv) {
  const configuredUrl = env.VITE_SUPABASE_URL?.trim()
  const configuredPublishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
  const recoverBlankProductionConfig = env.PROD === true
  const supabaseUrl = (
    configuredUrl
    || (env.VITE_SUPABASE_URL === undefined || recoverBlankProductionConfig ? defaultSupabaseUrl : '')
  ).replace(/\/$/, '')
  const supabasePublishableKey = configuredPublishableKey
    || (env.VITE_SUPABASE_PUBLISHABLE_KEY === undefined || recoverBlankProductionConfig ? defaultSupabasePublishableKey : '')

  return {
    supabaseUrl,
    supabasePublishableKey,
    isConfigured: Boolean(supabaseUrl && supabasePublishableKey),
  }
}

const supabaseConfig = resolveSupabaseConfig(import.meta.env)
const supabaseUrl = supabaseConfig.supabaseUrl
const supabasePublishableKey = supabaseConfig.supabasePublishableKey

export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey)

let client: SupabaseClient | undefined

export function attachTrustedDeviceHeader(input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined {
  const trustedToken = getTrustedDeviceToken()
  if (!trustedToken) return init

  const target = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url

  if (!target.includes('/rest/v1/')) return init

  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => {
    headers.set(key, value)
  })
  headers.set('x-sygshift-trusted-device', trustedToken)
  return { ...init, headers }
}

export function getSupabaseClient(): SupabaseClient {
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error('The secure data connection has not been configured.')
  }

  client ??= createClient(supabaseUrl, supabasePublishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true,
    },
    global: {
      fetch: (input, init) => fetch(input, attachTrustedDeviceHeader(input, init)),
    },
  })

  return client
}
