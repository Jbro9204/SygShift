/**
 * Stage 5 source-only lifecycle preparation for the future SygSphere
 * Communications host. This module is deliberately pure: it does not mount a
 * React surface, persist state, open a socket, or ask the browser for media.
 *
 * A later, separately approved release must explicitly change the immutable
 * client-release switch below after the server-side gate, provider evidence,
 * and pilot acceptance are all complete. A browser cannot turn it on.
 */
import {
  closedCommunicationsRuntimeGate,
  communicationsRuntimeMayMount,
  type SygSphereCommsActivationGate,
} from '../../shared/sygsphere-communications/v1/integration-gates'
import { type SygSphereCommsSurfaceState } from '../../shared/sygsphere-communications/v1/presentation-policy'

export const SYGSPHERE_COMMS_CLIENT_RUNTIME_RELEASED = false as const

export type SygSphereCommunicationsRuntimeState = Readonly<{
  /**
   * Opaque browser-session identity marker only. It carries no tenant,
   * permission, participant, room, call, or message data.
   */
  accountKey: string | null
  surfaceState: SygSphereCommsSurfaceState
  sessionGeneration: number
}>

export type SygSphereCommunicationsRuntimeEvent =
  | Readonly<{ type: 'account.changed'; accountKey: string | null }>
  | Readonly<{ type: 'authorization.lost' }>
  | Readonly<{ type: 'session.ended' }>
  | Readonly<{ type: 'surface.requested'; surfaceState: SygSphereCommsSurfaceState }>

const normalizeAccountKey = (accountKey: string | null): string | null => {
  const normalized = accountKey?.trim() ?? ''
  return normalized.length > 0 ? normalized : null
}

const unavailableState = (
  accountKey: string | null,
  sessionGeneration: number,
): SygSphereCommunicationsRuntimeState => ({
  accountKey: normalizeAccountKey(accountKey),
  surfaceState: 'unavailable',
  sessionGeneration,
})

/**
 * A browser can only ever prepare a passive fallback unless this source-level
 * release switch and every server-sourced activation gate are true.
 */
export const mayRunSygSphereCommunicationsClient = (
  gate: SygSphereCommsActivationGate,
): boolean => SYGSPHERE_COMMS_CLIENT_RUNTIME_RELEASED && communicationsRuntimeMayMount(gate)

/**
 * Returns the authoritative gate that a client presentation may use. This
 * defaults to the same closed gate used by both applications, making it
 * impossible for a browser-provided gate to activate the runtime.
 */
export const effectiveSygSphereCommunicationsClientGate = (
  serverGate: SygSphereCommsActivationGate,
): SygSphereCommsActivationGate =>
  mayRunSygSphereCommunicationsClient(serverGate)
    ? serverGate
    : closedCommunicationsRuntimeGate

export const createSygSphereCommunicationsRuntimeState = (
  accountKey: string | null = null,
): SygSphereCommunicationsRuntimeState => unavailableState(accountKey, 0)

/**
 * Identity, authorization, and end-of-session events always remove transient
 * communications state. The future host must call this before it changes
 * accounts or signs out; it intentionally cannot affect surrounding forms,
 * routes, drafts, or normal SygSphere messaging state.
 */
export const reduceSygSphereCommunicationsRuntime = (
  state: SygSphereCommunicationsRuntimeState,
  event: SygSphereCommunicationsRuntimeEvent,
  serverGate: SygSphereCommsActivationGate,
): SygSphereCommunicationsRuntimeState => {
  switch (event.type) {
    case 'account.changed': {
      const accountKey = normalizeAccountKey(event.accountKey)
      if (accountKey === state.accountKey) return state
      return unavailableState(accountKey, state.sessionGeneration + 1)
    }
    case 'authorization.lost':
    case 'session.ended':
      return unavailableState(null, state.sessionGeneration + 1)
    case 'surface.requested':
      if (!mayRunSygSphereCommunicationsClient(serverGate)) {
        return unavailableState(state.accountKey, state.sessionGeneration)
      }
      return {
        ...state,
        surfaceState: event.surfaceState,
      }
  }
}
