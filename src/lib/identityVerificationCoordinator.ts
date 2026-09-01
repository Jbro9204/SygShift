export type IdentityVerificationMethod = 'authenticator' | 'security_key'

type PendingVerification = {
  promise: Promise<IdentityVerificationMethod>
  reject: (error: Error) => void
  resolve: (method: IdentityVerificationMethod) => void
}

type VerificationListener = (required: boolean) => void

let pendingVerification: PendingVerification | null = null
const listeners = new Set<VerificationListener>()

function notifyListeners(): void {
  const required = pendingVerification !== null
  listeners.forEach((listener) => listener(required))
}

export function subscribeToIdentityVerification(listener: VerificationListener): () => void {
  listeners.add(listener)
  listener(pendingVerification !== null)
  return () => listeners.delete(listener)
}

export function requestIdentityVerification(): Promise<IdentityVerificationMethod> {
  if (pendingVerification) return pendingVerification.promise

  let resolvePromise!: (method: IdentityVerificationMethod) => void
  let rejectPromise!: (error: Error) => void
  const promise = new Promise<IdentityVerificationMethod>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  pendingVerification = { promise, reject: rejectPromise, resolve: resolvePromise }
  notifyListeners()
  return promise
}

export function completeIdentityVerification(method: IdentityVerificationMethod): void {
  const pending = pendingVerification
  if (!pending) return
  pendingVerification = null
  pending.resolve(method)
  notifyListeners()
}

export function cancelIdentityVerification(): void {
  const pending = pendingVerification
  if (!pending) return
  pendingVerification = null
  pending.reject(new Error('Identity verification was canceled.'))
  notifyListeners()
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

export async function fetchWithIdentityVerification(
  makeRequest: () => Promise<Response>,
): Promise<Response> {
  const response = await makeRequest()
  if (!await responseRequiresIdentityVerification(response)) return response

  try {
    await requestIdentityVerification()
  } catch {
    return response
  }

  return makeRequest()
}
