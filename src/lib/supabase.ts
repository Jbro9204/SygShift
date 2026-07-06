import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getTrustedDeviceToken } from './trustedDeviceToken'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey)

let client: SupabaseClient | undefined

function attachTrustedDeviceHeader(input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined {
  const trustedToken = getTrustedDeviceToken()
  if (!trustedToken) return init

  const target = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url

  if (!target.includes('/rest/v1/')) return init

  const headers = new Headers(init?.headers)
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
