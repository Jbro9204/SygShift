export interface PasswordSetOperation {
  operationId: string
  employeeId: string
  authUserId: string
  username: string
  status: 'prepared' | 'confirmed' | 'known_failed' | 'uncertain' | 'canceled'
  providerWriteAllowed: boolean
  providerUpdateVerified?: boolean
  requireChangeAtNextLogin: boolean
  expiresAt: null
  createdAt?: string
  finishedAt?: string | null
  errorCode?: string | null
}

export interface PasswordSetActor {
  actorEmployeeId: string
  actorAuthSessionId: string
  recentMfaAt?: string
  mfaMethod?: 'authenticator' | 'security_key'
  securityKeyTokenHash?: string | null
}

export interface PasswordSetInput {
  employeeId: string
  confirmationUsername: string
  password: string
  requireChangeAtNextLogin: boolean
  reason: string
  idempotencyKey: string
}

interface PasswordSetDependencies {
  rpc(name: string, payload: Record<string, unknown>): Promise<unknown>
  replacePassword(authUserId: string, password: string, operationId: string): Promise<{
    outcome: 'confirmed' | 'known_failed' | 'unknown'
    authUserId?: string
  }>
  digest(value: string): Promise<string>
}

export async function confirmEmployeePasswordSet(
  dependencies: Pick<PasswordSetDependencies, 'rpc'>,
  actor: PasswordSetActor,
  employeeId: string,
  operationId: string,
  confirmationUsername: string,
): Promise<PasswordSetOperation> {
  const operation = await readEmployeePasswordSet(dependencies, actor, employeeId, operationId)
  if (!operation || operation.username !== confirmationUsername) throw new Error('The exact password operation could not be verified.')
  if (operation.status === 'confirmed' || operation.providerUpdateVerified !== true) return operation
  return parsePasswordSetOperation(await dependencies.rpc('service_finish_employee_password_set', {
    ...actor, operationId, outcome: 'confirmed', providerAuthUserId: operation.authUserId,
  }), employeeId, operationId)
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const states = new Set(['prepared', 'confirmed', 'known_failed', 'uncertain', 'canceled'])

export async function cancelEmployeePasswordSet(
  dependencies: Pick<PasswordSetDependencies, 'rpc'>,
  actor: PasswordSetActor,
  employeeId: string,
  operationId: string,
  confirmationUsername: string,
  reason: string,
): Promise<PasswordSetOperation> {
  return parsePasswordSetOperation(await dependencies.rpc('service_cancel_employee_password_set', {
    ...actor, employeeId, operationId, confirmationUsername, reason,
  }), employeeId, operationId)
}

export function parsePasswordSetOperation(value: unknown, employeeId: string, operationId?: string): PasswordSetOperation {
  const record = value as Partial<PasswordSetOperation> | null
  if (!record || !uuid.test(record.operationId ?? '') || record.employeeId !== employeeId
    || (operationId && record.operationId !== operationId) || !uuid.test(record.authUserId ?? '')
    || typeof record.username !== 'string' || !/^[a-z0-9._-]{2,80}$/.test(record.username)
    || !states.has(record.status ?? '') || record.expiresAt !== null
    || typeof record.providerWriteAllowed !== 'boolean' || typeof record.requireChangeAtNextLogin !== 'boolean') {
    throw new Error('The password operation receipt could not be verified.')
  }
  return record as PasswordSetOperation
}

export async function readEmployeePasswordSet(
  dependencies: Pick<PasswordSetDependencies, 'rpc'>,
  actor: PasswordSetActor,
  employeeId: string,
  operationId?: string,
): Promise<PasswordSetOperation | null> {
  const value = await dependencies.rpc('service_get_employee_password_set', {
    ...actor, employeeId, ...(operationId ? { operationId } : {}),
  })
  return value === null ? null : parsePasswordSetOperation(value, employeeId, operationId)
}

export async function setEmployeePassword(
  dependencies: PasswordSetDependencies,
  actor: PasswordSetActor,
  input: PasswordSetInput,
): Promise<PasswordSetOperation> {
  // The durable request contains only non-secret intent. A replay never sends a
  // password to Auth again, even if a caller supplies different password text.
  const intent = {
    employeeId: input.employeeId,
    confirmationUsername: input.confirmationUsername,
    requireChangeAtNextLogin: input.requireChangeAtNextLogin,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  }
  const prepared = parsePasswordSetOperation(await dependencies.rpc('service_begin_employee_password_set', {
    ...actor, ...intent, requestHash: await dependencies.digest(JSON.stringify(intent)),
  }), input.employeeId, input.idempotencyKey)
  if (prepared.username !== input.confirmationUsername
    || prepared.requireChangeAtNextLogin !== input.requireChangeAtNextLogin) {
    throw new Error('The password operation did not match the reviewed account.')
  }
  if (!prepared.providerWriteAllowed) return prepared
  if (prepared.status !== 'prepared') throw new Error('The password operation was not prepared.')

  let provider: Awaited<ReturnType<PasswordSetDependencies['replacePassword']>>
  try {
    provider = await dependencies.replacePassword(prepared.authUserId, input.password, prepared.operationId)
  } catch {
    provider = { outcome: 'unknown' }
  }
  if (provider.outcome === 'confirmed' && provider.authUserId !== prepared.authUserId) {
    provider = { outcome: 'unknown' }
  }
  try {
    return parsePasswordSetOperation(await dependencies.rpc('service_finish_employee_password_set', {
      ...actor,
      operationId: prepared.operationId,
      outcome: provider.outcome,
      ...(provider.outcome === 'confirmed' ? { providerAuthUserId: provider.authUserId } : {}),
      ...(provider.outcome !== 'confirmed' ? { errorCode: provider.outcome === 'known_failed' ? 'password_provider_rejected' : 'password_provider_unconfirmed' } : {}),
    }), input.employeeId, prepared.operationId)
  } catch {
    // A lost finalization receipt is not permission to write the password again.
    // Read the exact durable operation; never infer success from a provider call.
    const current = await readEmployeePasswordSet(dependencies, actor, input.employeeId, prepared.operationId).catch(() => null)
    if (current) return current
    return { ...prepared, status: 'uncertain', providerWriteAllowed: false }
  }
}
