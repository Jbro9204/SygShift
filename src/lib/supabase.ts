import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { appendProtectedSessionHeaders } from './protectedSessionHeaders'

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
let sharedIdentityClient: SupabaseClient | undefined
const sharedIdentityAuthStorage = createMemoryOnlyAuthStorage()

export function createMemoryOnlyAuthStorage() {
  const values = new Map<string, string>()
  return {
    clear() {
      values.clear()
    },
    getItem(key: string) {
      return values.get(key) ?? null
    },
    removeItem(key: string) {
      values.delete(key)
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
  }
}

export function attachTrustedDeviceHeader(input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined {
  const target = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url

  let pathname = ''
  try {
    pathname = new URL(target).pathname
  } catch {
    return init
  }
  const isRestRequest = pathname.includes('/rest/v1/')
  const isSygSphereRequest = /\/rest\/v1\/rpc\/sygsphere_[a-z0-9_]+$/i.test(pathname)
  const isSygSphereAvatarRequest = pathname.includes('/storage/v1/object/') && pathname.includes('/employee-photos/')
  if (!isRestRequest && !isSygSphereAvatarRequest) return init

  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => {
    headers.set(key, value)
  })
  return {
    ...init,
    headers: appendProtectedSessionHeaders(headers, {
      includeSharedIdentity: isSygSphereRequest || isSygSphereAvatarRequest,
    }),
  }
}

export function getSupabaseClient(): SupabaseClient {
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error('The secure data connection has not been configured.')
  }

  if (sharedIdentityClient) return sharedIdentityClient

  return getNativeSupabaseClient()
}

function getNativeSupabaseClient(): SupabaseClient {
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

export async function activateSharedIdentitySupabaseSession(accessToken: string, refreshToken: string): Promise<void> {
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error('The secure data connection has not been configured.')
  }
  await getNativeSupabaseClient().auth.signOut({ scope: 'local' })
  sharedIdentityAuthStorage.clear()
  sharedIdentityClient = createClient(supabaseUrl, supabasePublishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: false,
      persistSession: true,
      storage: sharedIdentityAuthStorage,
      storageKey: 'sygshift-shared-identity-memory-session',
    },
    global: {
      fetch: (input, init) => fetch(input, attachTrustedDeviceHeader(input, init)),
    },
  })
  const { error } = await sharedIdentityClient.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  })
  if (error) {
    deactivateSharedIdentitySupabaseSession()
    throw new Error('The SygShift session could not be established.')
  }
}

export function deactivateSharedIdentitySupabaseSession(): void {
  sharedIdentityClient = undefined
  sharedIdentityAuthStorage.clear()
}
