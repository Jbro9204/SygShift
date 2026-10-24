import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import { getSoundPreferences } from '../lib/notificationSounds'
import { ensureSygShiftServiceWorker } from '../lib/pwaInstall'

const PUSH_OWNERSHIP_LOCK = 'sygshift:push-ownership:v2'
const PUSH_OWNERSHIP_CHANNEL = 'sygshift:push-ownership:v2'
const PUSH_OWNERSHIP_EPOCH_KEY = 'sygshift.push-ownership-epoch:v2'
const PUSH_COORDINATION_PROBE_KEY = 'sygshift.push-ownership-probe:v2'

const uuidSchema = z.string().uuid()
const pushOwnerEvidenceSchema = z.object({
  confirmed: z.boolean(),
  changed: z.boolean(),
  enabled: z.boolean(),
  endpoint: z.string(),
  operationId: z.string().uuid().nullable(),
  ownerOperationId: z.string().uuid().nullable(),
  actorEmployeeId: z.string().uuid(),
  actorAuthUserId: z.string().uuid(),
  actorAuthSessionId: z.string().uuid(),
  ownerEmployeeId: z.string().uuid().nullable(),
  ownerAuthUserId: z.string().uuid().nullable(),
  ownerAuthSessionId: z.string().uuid().nullable(),
})

type PushOwnerEvidence = z.infer<typeof pushOwnerEvidenceSchema>
type PushIntent = 'enable' | 'disable' | 'restore' | 'clear'
type PushIdentity = {
  employeeId: string | null
  authUserId: string
  authSessionId: string
}
type PushEpoch = {
  id: string
  intent: PushIntent
  employeeId: string | null
}
type PushCoordinator = {
  channel: BroadcastChannel
  locks: LockManager
  storage: Storage
}

let coordinationChannel: BroadcastChannel | null = null
let observedEpochId: string | null = null

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

function parseSessionId(accessToken: string): string | null {
  try {
    const encodedPayload = accessToken.split('.')[1]
    if (!encodedPayload) return null
    const base64 = encodedPayload.replaceAll('-', '+').replaceAll('_', '/')
      .padEnd(Math.ceil(encodedPayload.length / 4) * 4, '=')
    const payload = JSON.parse(globalThis.atob(base64)) as { session_id?: unknown }
    return uuidSchema.safeParse(payload.session_id).success ? String(payload.session_id) : null
  } catch {
    return null
  }
}

function receivePushEpoch(event: MessageEvent<PushEpoch>): void {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(event.data)
  if (parsed.success) observedEpochId = parsed.data.id
}

function requirePushCoordinator(): PushCoordinator {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks || typeof globalThis.BroadcastChannel !== 'function') {
    throw new Error('This browser cannot safely coordinate device notifications across open SygShift tabs.')
  }

  let storage: Storage
  try {
    storage = window.localStorage
    const probe = crypto.randomUUID()
    storage.setItem(PUSH_COORDINATION_PROBE_KEY, probe)
    if (storage.getItem(PUSH_COORDINATION_PROBE_KEY) !== probe) throw new Error('Push coordination storage was not retained.')
    storage.removeItem(PUSH_COORDINATION_PROBE_KEY)
  } catch {
    throw new Error('Device notifications cannot be changed while secure browser storage is unavailable.')
  }

  try {
    if (!coordinationChannel) {
      coordinationChannel = new BroadcastChannel(PUSH_OWNERSHIP_CHANNEL)
      coordinationChannel.addEventListener('message', receivePushEpoch)
    }
  } catch {
    coordinationChannel = null
    throw new Error('This browser cannot safely coordinate device notifications across open SygShift tabs.')
  }
  return { channel: coordinationChannel, locks, storage }
}

function claimPushEpoch(coordinator: PushCoordinator, intent: PushIntent, employeeId: string | null): PushEpoch {
  const epoch: PushEpoch = { id: crypto.randomUUID(), intent, employeeId }
  const serialized = JSON.stringify(epoch)
  try {
    coordinator.storage.setItem(PUSH_OWNERSHIP_EPOCH_KEY, serialized)
    if (coordinator.storage.getItem(PUSH_OWNERSHIP_EPOCH_KEY) !== serialized) {
      throw new Error('Push ownership epoch was not retained.')
    }
    observedEpochId = epoch.id
    coordinator.channel.postMessage(epoch)
    return epoch
  } catch {
    throw new Error('Device notifications cannot be changed while cross-tab coordination is unavailable.')
  }
}

function pushEpochIsCurrent(coordinator: PushCoordinator, epoch: PushEpoch): boolean {
  try {
    const stored = JSON.parse(coordinator.storage.getItem(PUSH_OWNERSHIP_EPOCH_KEY) ?? 'null') as { id?: unknown } | null
    return stored?.id === epoch.id && (observedEpochId === null || observedEpochId === epoch.id)
  } catch {
    return false
  }
}

function assertCurrentEpoch(coordinator: PushCoordinator, epoch: PushEpoch): void {
  if (!pushEpochIsCurrent(coordinator, epoch)) {
    throw new Error('The signed-in account changed while device notifications were updating. Review the setting for the current account.')
  }
}

async function capturePushIdentity(
  client: ReturnType<typeof getSupabaseClient>,
  employeeId: string | null,
): Promise<PushIdentity> {
  const { data, error } = await client.auth.getSession()
  const authUserId = data.session?.user.id
  const authSessionId = data.session ? parseSessionId(data.session.access_token) : null
  if (error || !data.session || !authUserId || !authSessionId || !uuidSchema.safeParse(authUserId).success) {
    throw new Error('The signed-in session could not be confirmed for device notifications.')
  }
  return { employeeId, authUserId, authSessionId }
}

async function assertIdentityStillCurrent(
  client: ReturnType<typeof getSupabaseClient>,
  identity: PushIdentity,
): Promise<void> {
  const current = await capturePushIdentity(client, identity.employeeId)
  if (current.authUserId !== identity.authUserId || current.authSessionId !== identity.authSessionId) {
    throw new Error('The signed-in account changed while device notifications were updating. Review the setting for the current account.')
  }
}

function validateEvidence(
  value: unknown,
  identity: PushIdentity,
  endpoint: string,
  operationId: string | null | undefined,
): PushOwnerEvidence {
  const evidence = pushOwnerEvidenceSchema.parse(value)
  if (
    evidence.endpoint !== endpoint
    || evidence.actorAuthUserId !== identity.authUserId
    || evidence.actorAuthSessionId !== identity.authSessionId
    || (identity.employeeId !== null && evidence.actorEmployeeId !== identity.employeeId)
    || (operationId !== undefined && evidence.operationId !== operationId)
  ) {
    throw new Error('The device notification result did not match the signed-in account.')
  }
  return evidence
}

async function readPushOwnerEvidence(
  client: ReturnType<typeof getSupabaseClient>,
  identity: PushIdentity,
  endpoint: string,
): Promise<PushOwnerEvidence> {
  const { data, error } = await client.rpc('get_my_push_subscription_guarded', {
    target_endpoint: endpoint,
    target_expected_auth_user_id: identity.authUserId,
    target_expected_auth_session_id: identity.authSessionId,
  })
  if (error) throw new Error('Device notification status could not be checked.')
  return validateEvidence(data, identity, endpoint, undefined)
}

async function writePushOwnerEvidence(
  client: ReturnType<typeof getSupabaseClient>,
  identity: PushIdentity & { employeeId: string },
  endpoint: string,
  subscription: PushSubscriptionJSON,
  enabled: boolean,
  expectedOwnerOperationId: string | null,
  operationId: string,
): Promise<PushOwnerEvidence> {
  const { data, error } = await client.rpc('set_my_push_subscription_guarded', {
    target_subscription: subscription,
    target_enabled: enabled,
    target_expected_employee_id: identity.employeeId,
    target_expected_auth_user_id: identity.authUserId,
    target_expected_auth_session_id: identity.authSessionId,
    target_expected_owner_operation_id: expectedOwnerOperationId,
    target_operation_id: operationId,
  })
  if (error) throw new Error(error.message || `Device notifications could not be ${enabled ? 'enabled' : 'disabled'}.`)
  return validateEvidence(data, identity, endpoint, operationId)
}

async function setServiceWorkerOwner(
  employeeId: string | null,
  coordinator: PushCoordinator,
  epoch: PushEpoch,
): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration('/')
  assertCurrentEpoch(coordinator, epoch)
  if (!registration?.active) throw new Error('The notification service is not ready. Reload SygShift and try again.')
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel()
    const timer = window.setTimeout(() => {
      channel.port1.close()
      reject(new Error('The notification service did not confirm the account change.'))
    }, 1500)
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer)
      channel.port1.close()
      if (event.data?.saved === true) resolve()
      else reject(new Error('The notification service did not confirm the account change.'))
    }
    try {
      assertCurrentEpoch(coordinator, epoch)
      const sound = getSoundPreferences()
      registration.active!.postMessage({
        type: 'sygshift:push-owner',
        employeeId,
        muted: sound.muted || !sound.notification || sound.volume === 0,
      }, [channel.port2])
    } catch (error) {
      window.clearTimeout(timer)
      channel.port1.close()
      reject(error)
    }
  })
  assertCurrentEpoch(coordinator, epoch)
}

async function runPushMutation<T>(
  intent: PushIntent,
  employeeId: string | null,
  operation: (coordinator: PushCoordinator, epoch: PushEpoch) => Promise<T>,
): Promise<T> {
  const coordinator = requirePushCoordinator()
  // Announcing before waiting for the origin-wide lock immediately fences an
  // older tab whose network response is still outstanding.
  const epoch = claimPushEpoch(coordinator, intent, employeeId)
  return coordinator.locks.request(PUSH_OWNERSHIP_LOCK, { mode: 'exclusive' }, async () => {
    assertCurrentEpoch(coordinator, epoch)
    return operation(coordinator, epoch)
  })
}

async function runPushRead<T>(operation: () => Promise<T>): Promise<T> {
  const coordinator = requirePushCoordinator()
  return coordinator.locks.request(PUSH_OWNERSHIP_LOCK, { mode: 'exclusive' }, operation)
}

export async function getDevicePushEnabled(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== 'granted') return false
  return runPushRead(async () => {
    const client = getSupabaseClient()
    const identity = await capturePushIdentity(client, null)
    const subscription = await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription()
    if (!subscription) return false
    const evidence = await readPushOwnerEvidence(client, identity, subscription.endpoint)
    await assertIdentityStillCurrent(client, identity)
    if (!evidence.confirmed) throw new Error('Device notification status could not be confirmed for this account.')
    return evidence.enabled
      && evidence.ownerEmployeeId === evidence.actorEmployeeId
      && evidence.ownerAuthUserId === identity.authUserId
      && evidence.ownerAuthSessionId === identity.authSessionId
  })
}

export async function enableDevicePush(employeeId: string): Promise<void> {
  if (!pushSupported()) throw new Error('This browser does not support device notifications. On iPhone or iPad, add SygShift to your Home Screen and open it there.')
  return runPushMutation('enable', employeeId, async (coordinator, epoch) => {
    const client = getSupabaseClient()
    const identity = await capturePushIdentity(client, employeeId) as PushIdentity & { employeeId: string }
    assertCurrentEpoch(coordinator, epoch)

    // Permission remains directly connected to the employee's click.
    const permission = await Notification.requestPermission()
    assertCurrentEpoch(coordinator, epoch)
    await assertIdentityStillCurrent(client, identity)
    if (permission !== 'granted') throw new Error('Notifications are blocked. Allow notifications in this site’s browser settings, then try again.')

    const response = await fetch('/api/v1/notifications/push/config')
    assertCurrentEpoch(coordinator, epoch)
    await assertIdentityStillCurrent(client, identity)
    const config = z.object({ configured: z.boolean(), publicKey: z.string().nullable() }).parse(await response.json())
    if (!response.ok || !config.configured || !config.publicKey) throw new Error('Device notification delivery is not configured yet.')

    await ensureSygShiftServiceWorker()
    assertCurrentEpoch(coordinator, epoch)
    const registration = await navigator.serviceWorker.ready
    assertCurrentEpoch(coordinator, epoch)
    await assertIdentityStillCurrent(client, identity)
    const key = Uint8Array.from(atob(config.publicKey.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0))
    const subscription = await registration.pushManager.getSubscription()
      || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    assertCurrentEpoch(coordinator, epoch)
    await assertIdentityStillCurrent(client, identity)

    const currentEvidence = await readPushOwnerEvidence(client, identity, subscription.endpoint)
    assertCurrentEpoch(coordinator, epoch)
    await assertIdentityStillCurrent(client, identity)
    if (!currentEvidence.confirmed) throw new Error('Device notification ownership could not be confirmed before enabling it.')
    const evidence = await writePushOwnerEvidence(
      client,
      identity,
      subscription.endpoint,
      subscription.toJSON(),
      true,
      currentEvidence.ownerOperationId,
      epoch.id,
    )
    assertCurrentEpoch(coordinator, epoch)
    await assertIdentityStillCurrent(client, identity)
    if (
      !evidence.confirmed || !evidence.enabled
      || evidence.ownerEmployeeId !== employeeId
      || evidence.ownerAuthUserId !== identity.authUserId
      || evidence.ownerAuthSessionId !== identity.authSessionId
    ) throw new Error('Device notifications were not confirmed for the signed-in account.')

    await setServiceWorkerOwner(employeeId, coordinator, epoch)
    assertCurrentEpoch(coordinator, epoch)
    try { localStorage.setItem(`sygshift.push-enabled:${employeeId}`, 'true') } catch { /* Server ownership remains authoritative. */ }
  })
}

export async function disableDevicePush(employeeId: string): Promise<void> {
  if (!pushSupported()) return
  return runPushMutation('disable', employeeId, async (coordinator, epoch) => {
    const client = getSupabaseClient()
    const identity = await capturePushIdentity(client, employeeId) as PushIdentity & { employeeId: string }
    assertCurrentEpoch(coordinator, epoch)
    const subscription = await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription()
    assertCurrentEpoch(coordinator, epoch)
    await assertIdentityStillCurrent(client, identity)

    if (subscription) {
      const currentEvidence = await readPushOwnerEvidence(client, identity, subscription.endpoint)
      assertCurrentEpoch(coordinator, epoch)
      await assertIdentityStillCurrent(client, identity)
      if (!currentEvidence.confirmed) throw new Error('Device notification ownership could not be confirmed before disabling it.')
      const evidence = await writePushOwnerEvidence(
        client,
        identity,
        subscription.endpoint,
        { endpoint: subscription.endpoint },
        false,
        currentEvidence.ownerOperationId,
        epoch.id,
      )
      assertCurrentEpoch(coordinator, epoch)
      await assertIdentityStillCurrent(client, identity)
      // A stale tab may receive a valid RPC response after another account has
      // taken ownership. Only exact server CAS evidence authorizes removing the
      // origin-wide browser subscription.
      if (
        !evidence.confirmed || evidence.enabled
        || evidence.ownerEmployeeId !== employeeId
        || evidence.ownerAuthUserId !== identity.authUserId
        || evidence.ownerAuthSessionId !== identity.authSessionId
      ) throw new Error('Device notifications were not disabled because this browser is now owned by another signed-in account.')
      assertCurrentEpoch(coordinator, epoch)
      const unsubscribed = await subscription.unsubscribe()
      assertCurrentEpoch(coordinator, epoch)
      if (!unsubscribed) throw new Error('The browser did not confirm that device notifications were removed. Please try again.')
    }

    await setServiceWorkerOwner(null, coordinator, epoch)
    assertCurrentEpoch(coordinator, epoch)
    try { localStorage.removeItem(`sygshift.push-enabled:${employeeId}`) } catch { /* Server preference is already saved. */ }
  })
}

export async function restorePushSession(employeeId: string): Promise<void> {
  if (!pushSupported()) return
  try {
    await runPushMutation('restore', employeeId, async (coordinator, epoch) => {
      const client = getSupabaseClient()
      const identity = await capturePushIdentity(client, employeeId) as PushIdentity & { employeeId: string }
      assertCurrentEpoch(coordinator, epoch)
      if (localStorage.getItem(`sygshift.push-enabled:${employeeId}`) !== 'true' || Notification.permission !== 'granted') {
        await setServiceWorkerOwner(null, coordinator, epoch)
        return
      }
      let subscription = await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription()
      assertCurrentEpoch(coordinator, epoch)
      await assertIdentityStillCurrent(client, identity)
      if (!subscription) {
        // A superseded disable can cross the final unsubscribe boundary after a
        // newer tab has announced its epoch but before that tab acquires the
        // origin-wide lock. Recreate the browser subscription here so the newer
        // restore/enable intent repairs availability instead of inheriting the
        // old tab's removal.
        const response = await fetch('/api/v1/notifications/push/config')
        assertCurrentEpoch(coordinator, epoch)
        await assertIdentityStillCurrent(client, identity)
        const config = z.object({ configured: z.boolean(), publicKey: z.string().nullable() }).parse(await response.json())
        if (!response.ok || !config.configured || !config.publicKey) return
        await ensureSygShiftServiceWorker()
        assertCurrentEpoch(coordinator, epoch)
        const registration = await navigator.serviceWorker.ready
        assertCurrentEpoch(coordinator, epoch)
        await assertIdentityStillCurrent(client, identity)
        const key = Uint8Array.from(atob(config.publicKey.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0))
        subscription = await registration.pushManager.getSubscription()
          || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
        assertCurrentEpoch(coordinator, epoch)
        await assertIdentityStillCurrent(client, identity)
      }

      let evidence = await readPushOwnerEvidence(client, identity, subscription.endpoint)
      assertCurrentEpoch(coordinator, epoch)
      await assertIdentityStillCurrent(client, identity)
      if (!evidence.confirmed || !evidence.enabled) {
        evidence = await writePushOwnerEvidence(
          client,
          identity,
          subscription.endpoint,
          subscription.toJSON(),
          true,
          evidence.ownerOperationId,
          epoch.id,
        )
        assertCurrentEpoch(coordinator, epoch)
        await assertIdentityStillCurrent(client, identity)
      }
      if (
        !evidence.confirmed || !evidence.enabled
        || evidence.ownerEmployeeId !== employeeId
        || evidence.ownerAuthUserId !== identity.authUserId
        || evidence.ownerAuthSessionId !== identity.authSessionId
      ) return
      await setServiceWorkerOwner(employeeId, coordinator, epoch)
    })
  } catch { /* Push availability never blocks login or operational workflows. */ }
}

export async function clearPushSession(): Promise<void> {
  if (!pushSupported()) return
  try {
    await runPushMutation('clear', null, async (coordinator, epoch) => {
      await setServiceWorkerOwner(null, coordinator, epoch)
    })
  } catch { /* Sign-out remains available when browser push coordination is unavailable. */ }
}

export function markPushPresented(employeeId: string, id: string): void {
  navigator.serviceWorker?.controller?.postMessage({ type: 'sygshift:push-presented', employeeId, id })
}
