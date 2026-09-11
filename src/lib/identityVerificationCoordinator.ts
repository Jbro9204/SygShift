export type IdentityVerificationMethod = 'authenticator' | 'security_key'
export type IdentityVerificationContext = 'general' | 'hr' | 'licensing'

type PendingVerification = {
  context: IdentityVerificationContext
  promise: Promise<IdentityVerificationMethod>
  reject: (error: Error) => void
  resolve: (method: IdentityVerificationMethod) => void
}

type VerificationListener = (required: boolean, context: IdentityVerificationContext) => void
type VerificationResolution = {
  canceled: boolean
  completedAt: number
  method: IdentityVerificationMethod | null
}

let pendingVerification: PendingVerification | null = null
let lastResolution: VerificationResolution | null = null
const listeners = new Set<VerificationListener>()
const verificationLockName = 'sygshift:identity-verification:v1'
const verificationChannelName = 'sygshift:identity-verification:v1'
let verificationChannel: BroadcastChannel | null | undefined

function getVerificationChannel(): BroadcastChannel | null {
  if (verificationChannel !== undefined) return verificationChannel
  verificationChannel = typeof window !== 'undefined' && 'BroadcastChannel' in window
    ? new BroadcastChannel(verificationChannelName)
    : null
  verificationChannel?.addEventListener('message', (event: MessageEvent<VerificationResolution>) => {
    const resolution = event.data
    if (!resolution || typeof resolution.completedAt !== 'number') return
    if (!lastResolution || resolution.completedAt >= lastResolution.completedAt) lastResolution = resolution
  })
  return verificationChannel
}

function publishResolution(resolution: VerificationResolution): void {
  lastResolution = resolution
  getVerificationChannel()?.postMessage(resolution)
}

function notifyListeners(): void {
  const required = pendingVerification !== null
  const context = pendingVerification?.context ?? 'general'
  listeners.forEach((listener) => listener(required, context))
}

export function subscribeToIdentityVerification(listener: VerificationListener): () => void {
  listeners.add(listener)
  listener(pendingVerification !== null, pendingVerification?.context ?? 'general')
  return () => listeners.delete(listener)
}

function requestLocalIdentityVerification(context: IdentityVerificationContext): Promise<IdentityVerificationMethod> {
  if (pendingVerification) {
    if (pendingVerification.context === 'general' && context !== 'general') {
      pendingVerification.context = context
      notifyListeners()
    }
    return pendingVerification.promise
  }

  let resolvePromise!: (method: IdentityVerificationMethod) => void
  let rejectPromise!: (error: Error) => void
  const promise = new Promise<IdentityVerificationMethod>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  pendingVerification = { context, promise, reject: rejectPromise, resolve: resolvePromise }
  notifyListeners()
  return promise
}

export async function requestIdentityVerification(
  context: IdentityVerificationContext = 'general',
): Promise<IdentityVerificationMethod> {
  if (pendingVerification) return requestLocalIdentityVerification(context)

  const requestedAt = Date.now()
  getVerificationChannel()
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks) return requestLocalIdentityVerification(context)

  return locks.request(verificationLockName, { mode: 'exclusive' }, async () => {
    // BroadcastChannel delivery can trail the lock release by one task. Give a
    // completed verification in another tab a brief chance to arrive before
    // deciding that this tab must show its own checkpoint.
    await new Promise((resolve) => window.setTimeout(resolve, 50))
    if (lastResolution && lastResolution.completedAt >= requestedAt) {
      if (lastResolution.canceled || !lastResolution.method) {
        throw new Error('Identity verification was canceled.')
      }
      return lastResolution.method
    }
    return requestLocalIdentityVerification(context)
  })
}

export function completeIdentityVerification(method: IdentityVerificationMethod): void {
  const pending = pendingVerification
  if (!pending) return
  pendingVerification = null
  publishResolution({ canceled: false, completedAt: Date.now(), method })
  pending.resolve(method)
  notifyListeners()
}

export function cancelIdentityVerification(): void {
  const pending = pendingVerification
  if (!pending) return
  pendingVerification = null
  publishResolution({ canceled: true, completedAt: Date.now(), method: null })
  pending.reject(new Error('Identity verification was canceled.'))
  notifyListeners()
}

export function identityVerificationContextForCode(value: unknown): IdentityVerificationContext {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (code === 'recent_hr_mfa_required' || code.startsWith('hr_')) return 'hr'
  if (code.startsWith('licensing_')) return 'licensing'
  return 'general'
}

export function isIdentityVerificationRequiredCode(value: unknown): boolean {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return code === 'recent_document_mfa_required' || code.endsWith('_mfa_required')
}

export async function responseRequiresIdentityVerification(response: Response): Promise<boolean> {
  if (response.status !== 403) return false
  const payload = await response.clone().json().catch(() => null) as { error?: unknown } | null
  return isIdentityVerificationRequiredCode(payload?.error)
}

async function responseIdentityVerificationContext(response: Response): Promise<IdentityVerificationContext | null> {
  if (response.status !== 403) return null
  const payload = await response.clone().json().catch(() => null) as { error?: unknown } | null
  return isIdentityVerificationRequiredCode(payload?.error)
    ? identityVerificationContextForCode(payload?.error)
    : null
}

export async function fetchWithIdentityVerification(
  makeRequest: () => Promise<Response>,
): Promise<Response> {
  const response = await makeRequest()
  const context = await responseIdentityVerificationContext(response)
  if (!context) return response

  try {
    await requestIdentityVerification(context)
  } catch {
    return response
  }

  return makeRequest()
}
