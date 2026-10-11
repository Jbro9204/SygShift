import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { appendProtectedSessionHeaders } from './protectedSessionHeaders'
import { getSharedIdentitySessionScope } from './sharedIdentitySession'

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
let sharedIdentityAuthStorage = createMemoryOnlyAuthStorage()

export type SharedIdentitySupabaseSessionFailureKind = 'invalid' | 'terminal' | 'transient'

export class SharedIdentitySupabaseSessionError extends Error {
  readonly kind: SharedIdentitySupabaseSessionFailureKind

  constructor(message: string, kind: SharedIdentitySupabaseSessionFailureKind) {
    super(message)
    this.name = 'SharedIdentitySupabaseSessionError'
    this.kind = kind
  }
}

const confirmedInvalidAuthCodes = new Set([
  'bad_jwt',
  'invalid_credentials',
  'invalid_refresh_token',
  'refresh_token_already_used',
  'refresh_token_not_found',
  'session_not_found',
])
const transientAuthStatuses = new Set([0, 408, 425, 429, 500, 502, 503, 504])

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
    || /\/rest\/v1\/rpc\/record_platform_presence$/i.test(pathname)
  const isSygSphereAvatarRequest = pathname.includes('/storage/v1/object/') && pathname.includes('/employee-photos/')
  const isStorageObjectRequest = pathname.includes('/storage/v1/object/')
  if (!isRestRequest && !isStorageObjectRequest) return init

  const sharedIdentityScope = getSharedIdentitySessionScope()
  const includeSharedIdentity = sharedIdentityScope === 'platform'
    ? isRestRequest || isStorageObjectRequest
    : sharedIdentityScope === 'sygsphere' && (isSygSphereRequest || isSygSphereAvatarRequest)

  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => {
    headers.set(key, value)
  })
  return {
    ...init,
    headers: appendProtectedSessionHeaders(headers, {
      includeSharedIdentity,
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

export function isActiveSupabaseClient(candidate: SupabaseClient): boolean {
  return candidate === getSupabaseClient()
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

export async function activateSharedIdentitySupabaseSession(
  accessToken: string,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error('The secure data connection has not been configured.')
  }
  const existingSharedIdentityClient = sharedIdentityClient
  const candidateStorage = existingSharedIdentityClient
    ? sharedIdentityAuthStorage
    : createMemoryOnlyAuthStorage()
  const candidateClient = existingSharedIdentityClient ?? createClient(supabaseUrl, supabasePublishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
      storage: candidateStorage,
      storageKey: 'sygshift-shared-identity-memory-session',
    },
    global: {
      fetch: (input, init) => fetch(input, attachTrustedDeviceHeader(input, init)),
    },
  })
  const candidateIsPartial = !existingSharedIdentityClient
  let candidateCommitted = false
  let setSessionOperation: PromiseLike<unknown> | null = null
  let setSessionSettled = false
  try {
    throwIfSecureAccessAborted(signal)
    const operation = candidateClient.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    })
    const trackedOperation = Promise.resolve(operation).then(
      (result) => {
        setSessionSettled = true
        return result
      },
      (error) => {
        setSessionSettled = true
        throw error
      },
    )
    setSessionOperation = trackedOperation
    const { error } = await waitForAuthOperation(trackedOperation, signal)
    if (error) {
      throw new SharedIdentitySupabaseSessionError(
        'The SygShift session could not be established.',
        sharedIdentitySupabaseSessionFailureKind(error),
      )
    }
    throwIfSecureAccessAborted(signal)

    if (candidateIsPartial) {
      sharedIdentityClient = candidateClient
      sharedIdentityAuthStorage = candidateStorage
      candidateCommitted = true
      try {
        void Promise.resolve(getNativeSupabaseClient().auth.signOut({ scope: 'local' })).catch(() => undefined)
      } catch {
        // Native-session cleanup must not roll back a validated shared session.
      }
    } else {
      candidateCommitted = true
    }
  } catch (error) {
    if (candidateIsPartial && !candidateCommitted) {
      retireSharedIdentitySupabaseClient(candidateClient, candidateStorage)
      if (setSessionOperation && !setSessionSettled) {
        void Promise.resolve(setSessionOperation).then(
          () => retireSharedIdentitySupabaseClient(candidateClient, candidateStorage),
          () => retireSharedIdentitySupabaseClient(candidateClient, candidateStorage),
        )
      }
    }
    if (error instanceof SharedIdentitySupabaseSessionError) throw error
    throw new SharedIdentitySupabaseSessionError(
      'The SygShift session could not be established.',
      sharedIdentitySupabaseSessionFailureKind(error),
    )
  }
}

export function deactivateSharedIdentitySupabaseSession(): void {
  const retiringClient = sharedIdentityClient
  const retiringStorage = sharedIdentityAuthStorage
  sharedIdentityClient = undefined
  sharedIdentityAuthStorage = createMemoryOnlyAuthStorage()
  if (retiringClient) retireSharedIdentitySupabaseClient(retiringClient, retiringStorage)
  else retiringStorage.clear()
}

export function isConfirmedInvalidSharedIdentitySupabaseSessionError(error: unknown): boolean {
  return sharedIdentitySupabaseSessionFailureKind(error) === 'invalid'
}

export function isTransientSharedIdentitySupabaseSessionError(error: unknown): boolean {
  return sharedIdentitySupabaseSessionFailureKind(error) === 'transient'
}

function sharedIdentitySupabaseSessionFailureKind(error: unknown): SharedIdentitySupabaseSessionFailureKind {
  if (error instanceof SharedIdentitySupabaseSessionError) return error.kind
  if (error instanceof DOMException && error.name === 'AbortError') return 'transient'

  const candidate = error as {
    code?: unknown
    message?: unknown
    status?: unknown
  } | null
  const code = typeof candidate?.code === 'string' ? candidate.code.toLowerCase() : ''
  const message = typeof candidate?.message === 'string' ? candidate.message.toLowerCase() : ''
  const status = typeof candidate?.status === 'number' ? candidate.status : null

  if (
    status === 401
    || status === 403
    || confirmedInvalidAuthCodes.has(code)
    || message.includes('invalid refresh token')
    || message.includes('refresh token not found')
    || message.includes('session has been revoked')
  ) return 'invalid'

  if (
    error instanceof TypeError
    || (status !== null && (transientAuthStatuses.has(status) || status >= 500))
    || code.startsWith('08')
    || message.includes('aborted')
    || message.includes('connection')
    || message.includes('failed to fetch')
    || message.includes('network')
    || message.includes('timed out')
    || message.includes('timeout')
  ) return 'transient'

  return 'terminal'
}

function throwIfSecureAccessAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw new DOMException('The secure-access request was interrupted.', 'AbortError')
}

async function waitForAuthOperation<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  throwIfSecureAccessAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => reject(new DOMException('The secure-access request was interrupted.', 'AbortError'))
    signal.addEventListener('abort', handleAbort, { once: true })
    void Promise.resolve(operation).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', handleAbort)
    })
  })
}

function retireSharedIdentitySupabaseClient(
  retiringClient: SupabaseClient,
  retiringStorage: ReturnType<typeof createMemoryOnlyAuthStorage>,
): void {
  retiringClient.auth.stopAutoRefresh()
  void retiringClient.auth.signOut({ scope: 'local' }).catch(() => undefined)
  retiringStorage.clear()
}
