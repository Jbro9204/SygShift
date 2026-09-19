/**
 * Shared Stage 6/7 presentation policy. SygShift owns this exact wording and
 * interaction model; Sygilant consumes the same artifact instead of creating
 * a separate communications experience. This is a policy-only module: it
 * cannot open a network connection, request a device, or mount a UI by itself.
 */
import {
  communicationsRuntimeMayMount,
  type SygSphereCommsActivationGate,
} from './integration-gates'

export const SYGSPHERE_COMMS_PRESENTATION_PROFILE_VERSION = '1.0.0-draft.1' as const

export const SYGSPHERE_COMMS_SURFACE_STATES = [
  'unavailable',
  'permission_needed',
  'ready',
  'ringing',
  'connecting',
  'active',
  'reconnecting',
  'denied',
  'failed',
  'ended',
] as const

export type SygSphereCommsSurfaceState = (typeof SYGSPHERE_COMMS_SURFACE_STATES)[number]

export type SygSphereCommsSurfacePresentation = Readonly<{
  state: SygSphereCommsSurfaceState
  title: string
  detail: string
  primaryActionLabel: string
  secondaryActionLabel: string
  interactiveControlsEnabled: boolean
  microphoneRequest: 'never' | 'only_after_explicit_action'
}>

export const SYGSPHERE_COMMS_SURFACE_COPY: Readonly<Record<SygSphereCommsSurfaceState, Omit<SygSphereCommsSurfacePresentation, 'state' | 'interactiveControlsEnabled'>>> = Object.freeze({
  unavailable: {
    title: 'Communications are not available yet',
    detail: 'Continue using SygSphere messages or Dispatch.',
    primaryActionLabel: 'Open SygSphere messages',
    secondaryActionLabel: 'Use Dispatch',
    microphoneRequest: 'never',
  },
  permission_needed: {
    title: 'Microphone permission is needed',
    detail: 'Choose Allow when you are ready to speak. You can still use messages and Dispatch without it.',
    primaryActionLabel: 'Allow microphone',
    secondaryActionLabel: 'Use messages instead',
    microphoneRequest: 'only_after_explicit_action',
  },
  ready: {
    title: 'Communications ready',
    detail: 'Choose a conversation or channel when you are ready.',
    primaryActionLabel: 'Open communications',
    secondaryActionLabel: 'Use messages instead',
    microphoneRequest: 'only_after_explicit_action',
  },
  ringing: {
    title: 'Incoming call',
    detail: 'Choose Answer or Decline. Your current work will stay open.',
    primaryActionLabel: 'Answer',
    secondaryActionLabel: 'Decline',
    microphoneRequest: 'only_after_explicit_action',
  },
  connecting: {
    title: 'Connecting',
    detail: 'Please wait while the connection is prepared.',
    primaryActionLabel: 'Cancel',
    secondaryActionLabel: 'Use messages instead',
    microphoneRequest: 'never',
  },
  active: {
    title: 'Communication in progress',
    detail: 'Your current page stays open while you talk.',
    primaryActionLabel: 'Open controls',
    secondaryActionLabel: 'End communication',
    microphoneRequest: 'never',
  },
  reconnecting: {
    title: 'Reconnecting',
    detail: 'We are restoring the connection. Keep this page open or use messages and Dispatch.',
    primaryActionLabel: 'Keep waiting',
    secondaryActionLabel: 'Use messages instead',
    microphoneRequest: 'never',
  },
  denied: {
    title: 'Communications are not available for this account',
    detail: 'Use SygSphere messages or Dispatch for help.',
    primaryActionLabel: 'Open SygSphere messages',
    secondaryActionLabel: 'Use Dispatch',
    microphoneRequest: 'never',
  },
  failed: {
    title: 'Communications could not be started',
    detail: 'Your work is still saved. Try again later or use SygSphere messages and Dispatch.',
    primaryActionLabel: 'Try again',
    secondaryActionLabel: 'Use messages instead',
    microphoneRequest: 'never',
  },
  ended: {
    title: 'Communication ended',
    detail: 'You can return to your work or start another conversation when ready.',
    primaryActionLabel: 'Return to work',
    secondaryActionLabel: 'Open SygSphere messages',
    microphoneRequest: 'never',
  },
})

const presentationFor = (
  state: SygSphereCommsSurfaceState,
  interactiveControlsEnabled: boolean,
): SygSphereCommsSurfacePresentation => ({
  state,
  ...SYGSPHERE_COMMS_SURFACE_COPY[state],
  interactiveControlsEnabled,
})

/**
 * An unverified gate always resolves to a passive fallback. Future React
 * surfaces must call this server-sourced gate policy before rendering a dock
 * or asking for any device permission.
 */
export const resolveSygSphereCommsSurfacePresentation = (
  gate: SygSphereCommsActivationGate,
  requestedState: SygSphereCommsSurfaceState = 'ready',
): SygSphereCommsSurfacePresentation =>
  communicationsRuntimeMayMount(gate)
    ? presentationFor(requestedState, requestedState !== 'unavailable' && requestedState !== 'denied')
    : presentationFor('unavailable', false)

export const SYGSPHERE_COMMS_PTT_SCOPES = [
  'assignment',
  'shift',
  'site',
  'dispatch',
] as const

export type SygSphereCommsPttScope = (typeof SYGSPHERE_COMMS_PTT_SCOPES)[number]

export const SYGSPHERE_COMMS_PTT_SCOPE_LABELS: Readonly<Record<SygSphereCommsPttScope, string>> = Object.freeze({
  assignment: 'Your assignment channel',
  shift: 'Your shift channel',
  site: 'Your site channel',
  dispatch: 'Dispatch channel',
})

export const SYGSPHERE_COMMS_PTT_STATES = [
  'unavailable',
  'permission_needed',
  'ready',
  'transmitting',
  'reconnecting',
  'denied',
] as const

export type SygSphereCommsPttState = (typeof SYGSPHERE_COMMS_PTT_STATES)[number]

export type SygSphereCommsPttPresentation = Readonly<{
  state: SygSphereCommsPttState
  scope: SygSphereCommsPttScope
  scopeLabel: string
  title: string
  detail: string
  holdToTalkLabel: string | null
  releaseToStopLabel: string | null
  interactiveControlsEnabled: boolean
  microphoneRequest: 'never' | 'only_after_explicit_action'
  requiresForeground: boolean
  serverAuthorizationRequired: true
}>

const pttPresentationFor = (
  state: SygSphereCommsPttState,
  scope: SygSphereCommsPttScope,
  interactiveControlsEnabled: boolean,
): SygSphereCommsPttPresentation => {
  const scopeLabel = SYGSPHERE_COMMS_PTT_SCOPE_LABELS[scope]
  const shared = {
    state,
    scope,
    scopeLabel,
    interactiveControlsEnabled,
    requiresForeground: true,
    serverAuthorizationRequired: true as const,
  }

  switch (state) {
    case 'permission_needed':
      return {
        ...shared,
        title: 'Microphone permission is needed',
        detail: `Allow microphone access when you are ready to speak in ${scopeLabel.toLowerCase()}.`,
        holdToTalkLabel: 'Allow microphone',
        releaseToStopLabel: null,
        microphoneRequest: 'only_after_explicit_action',
      }
    case 'ready':
      return {
        ...shared,
        title: `${scopeLabel} is ready`,
        detail: 'Press and hold to talk. Release when you are done speaking.',
        holdToTalkLabel: 'Hold to talk',
        releaseToStopLabel: 'Release to stop',
        microphoneRequest: 'only_after_explicit_action',
      }
    case 'transmitting':
      return {
        ...shared,
        title: 'You are speaking',
        detail: 'Release to stop talking.',
        holdToTalkLabel: 'Talking now',
        releaseToStopLabel: 'Release to stop',
        microphoneRequest: 'never',
      }
    case 'reconnecting':
      return {
        ...shared,
        title: 'Reconnecting your channel',
        detail: 'Wait for the channel to be ready before speaking again.',
        holdToTalkLabel: null,
        releaseToStopLabel: null,
        microphoneRequest: 'never',
      }
    case 'denied':
      return {
        ...shared,
        title: 'This channel is not available to you',
        detail: 'Use SygSphere messages or Dispatch for help.',
        holdToTalkLabel: null,
        releaseToStopLabel: null,
        microphoneRequest: 'never',
      }
    case 'unavailable':
      return {
        ...shared,
        title: 'Push-to-talk is not available yet',
        detail: 'Continue using SygSphere messages or Dispatch.',
        holdToTalkLabel: null,
        releaseToStopLabel: null,
        microphoneRequest: 'never',
      }
  }
}

/**
 * Scope is display context only. A future coordinator must independently
 * derive current assignment, shift, site, and Dispatch eligibility.
 */
export const resolveSygSphereCommsPttPresentation = (
  gate: SygSphereCommsActivationGate,
  scope: SygSphereCommsPttScope,
  requestedState: SygSphereCommsPttState = 'ready',
): SygSphereCommsPttPresentation =>
  communicationsRuntimeMayMount(gate)
    ? pttPresentationFor(requestedState, scope, requestedState !== 'unavailable' && requestedState !== 'denied')
    : pttPresentationFor('unavailable', scope, false)
