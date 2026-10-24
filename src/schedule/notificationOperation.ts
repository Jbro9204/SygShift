const STORAGE_PREFIX = 'sygshift:schedule-notification-operation:v1:'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type PersistedScheduleNotificationOperation = {
  attempted: boolean
  operationId: string
  ownerEmployeeId: string
  scheduleId: string
  weekStartsOn: string
}

const fallbackOperations = new Map<string, PersistedScheduleNotificationOperation>()
const sessionStorageBackedKeys = new Set<string>()

function operationKey(ownerEmployeeId: string, scheduleId: string): string {
  return `${STORAGE_PREFIX}${ownerEmployeeId}:${scheduleId}`
}

function validOperation(
  value: unknown,
  ownerEmployeeId: string,
  scheduleId: string,
  weekStartsOn: string,
): value is PersistedScheduleNotificationOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<PersistedScheduleNotificationOperation>
  return candidate.ownerEmployeeId === ownerEmployeeId
    && candidate.scheduleId === scheduleId
    && candidate.weekStartsOn === weekStartsOn
    && typeof candidate.attempted === 'boolean'
    && typeof candidate.operationId === 'string'
    && UUID_PATTERN.test(candidate.operationId)
}

function readOperation(
  ownerEmployeeId: string,
  scheduleId: string,
  weekStartsOn: string,
): PersistedScheduleNotificationOperation | null {
  const key = operationKey(ownerEmployeeId, scheduleId)
  if (typeof window !== 'undefined') {
    try {
      const raw = window.sessionStorage.getItem(key)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (validOperation(parsed, ownerEmployeeId, scheduleId, weekStartsOn)) {
          fallbackOperations.set(key, parsed)
          sessionStorageBackedKeys.add(key)
          return parsed
        }
        window.sessionStorage.removeItem(key)
        fallbackOperations.delete(key)
        sessionStorageBackedKeys.delete(key)
        return null
      }
      if (sessionStorageBackedKeys.has(key)) {
        fallbackOperations.delete(key)
        sessionStorageBackedKeys.delete(key)
        return null
      }
    } catch {
      // The in-memory copy still gives this document stable retry identity.
    }
  }
  const fallback = fallbackOperations.get(key)
  return fallback && fallback.weekStartsOn === weekStartsOn ? fallback : null
}

function writeOperation(operation: PersistedScheduleNotificationOperation): void {
  const key = operationKey(operation.ownerEmployeeId, operation.scheduleId)
  fallbackOperations.set(key, operation)
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(key, JSON.stringify(operation))
    sessionStorageBackedKeys.add(key)
  } catch {
    // In-memory persistence is the safe fallback for the current document.
  }
}

function removeOperation(
  ownerEmployeeId: string,
  scheduleId: string,
  weekStartsOn: string,
  operationId: string,
): void {
  const key = operationKey(ownerEmployeeId, scheduleId)
  const current = readOperation(ownerEmployeeId, scheduleId, weekStartsOn)
  if (current?.operationId !== operationId) return
  fallbackOperations.delete(key)
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(key)
    sessionStorageBackedKeys.delete(key)
  } catch {
    // The in-memory copy has still been cleared for this document.
  }
}

export function acquireScheduleNotificationOperation(
  ownerEmployeeId: string,
  scheduleId: string,
  weekStartsOn: string,
  createOperationId: () => string = () => crypto.randomUUID(),
): PersistedScheduleNotificationOperation {
  const current = readOperation(ownerEmployeeId, scheduleId, weekStartsOn)
  if (current) return current

  const operationId = createOperationId()
  if (!UUID_PATTERN.test(operationId)) throw new Error('A valid schedule-notification operation could not be created.')
  const created = { attempted: false, operationId, ownerEmployeeId, scheduleId, weekStartsOn }
  writeOperation(created)
  return created
}

export function markScheduleNotificationOperationStarted(
  ownerEmployeeId: string,
  scheduleId: string,
  weekStartsOn: string,
  operationId: string,
): void {
  const current = readOperation(ownerEmployeeId, scheduleId, weekStartsOn)
  if (!current || current.operationId !== operationId || current.attempted) return
  writeOperation({ ...current, attempted: true })
}

export function completeScheduleNotificationOperation(
  ownerEmployeeId: string,
  scheduleId: string,
  weekStartsOn: string,
  operationId: string,
): void {
  removeOperation(ownerEmployeeId, scheduleId, weekStartsOn, operationId)
}

export function abandonUnstartedScheduleNotificationOperation(
  ownerEmployeeId: string,
  scheduleId: string,
  weekStartsOn: string,
  operationId: string,
): void {
  const current = readOperation(ownerEmployeeId, scheduleId, weekStartsOn)
  if (current?.operationId === operationId && !current.attempted) {
    removeOperation(ownerEmployeeId, scheduleId, weekStartsOn, operationId)
  }
}
