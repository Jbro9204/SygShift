/**
 * Stage 6 source-only presentation adapter. It turns the shared policy into a
 * small, accessible view model but deliberately has no React component and no
 * browser/device/network side effects. The eventual dock in each application
 * must consume this model rather than inventing local copy or state meanings.
 */
import {
  resolveSygSphereCommsPttPresentation,
  resolveSygSphereCommsSurfacePresentation,
  type SygSphereCommsPttScope,
  type SygSphereCommsSurfacePresentation,
} from '../../shared/sygsphere-communications/v1/presentation-policy'
import { type SygSphereCommsActivationGate } from '../../shared/sygsphere-communications/v1/integration-gates'
import {
  effectiveSygSphereCommunicationsClientGate,
  type SygSphereCommunicationsRuntimeState,
} from './sygsphereCommunicationsRuntimeLifecycle'

export type SygSphereCommunicationsFallbackIntent = 'open_messages' | 'use_dispatch'

export type SygSphereCommunicationsSurfaceViewModel = Readonly<{
  presentation: SygSphereCommsSurfacePresentation
  primaryIntent: SygSphereCommunicationsFallbackIntent
  secondaryIntent: SygSphereCommunicationsFallbackIntent
  ariaLive: 'polite'
  requestsDevicePermission: false
  isInteractive: false
}>

export type SygSphereCommunicationsPttViewModel = Readonly<{
  scopeLabel: string
  title: string
  detail: string
  isInteractive: false
  requestsDevicePermission: false
  holdToTalkLabel: null
  releaseToStopLabel: null
  requiresForeground: true
  serverAuthorizationRequired: true
}>

const fallbackPresentation = (
  runtime: SygSphereCommunicationsRuntimeState,
  serverGate: SygSphereCommsActivationGate,
): SygSphereCommsSurfacePresentation =>
  resolveSygSphereCommsSurfacePresentation(
    effectiveSygSphereCommunicationsClientGate(serverGate),
    runtime.surfaceState,
  )

/**
 * The only current actions are the established SygSphere messages and Dispatch
 * fallback. A future interactive release must add separately authorized
 * command intents only after the full coordinator and pilot gates pass.
 */
export const createSygSphereCommunicationsSurfaceViewModel = (
  runtime: SygSphereCommunicationsRuntimeState,
  serverGate: SygSphereCommsActivationGate,
): SygSphereCommunicationsSurfaceViewModel => ({
  presentation: fallbackPresentation(runtime, serverGate),
  primaryIntent: 'open_messages',
  secondaryIntent: 'use_dispatch',
  ariaLive: 'polite',
  requestsDevicePermission: false,
  isInteractive: false,
})

/**
 * The PTT control is intentionally represented as unavailable until a later
 * enabled release adds server-authorized interaction. This keeps the shared
 * wording and scope visible to tests without creating a microphone path.
 */
export const createSygSphereCommunicationsPttViewModel = (
  scope: SygSphereCommsPttScope,
  serverGate: SygSphereCommsActivationGate,
): SygSphereCommunicationsPttViewModel => {
  const presentation = resolveSygSphereCommsPttPresentation(
    effectiveSygSphereCommunicationsClientGate(serverGate),
    scope,
    'unavailable',
  )

  return {
    scopeLabel: presentation.scopeLabel,
    title: presentation.title,
    detail: presentation.detail,
    isInteractive: false,
    requestsDevicePermission: false,
    holdToTalkLabel: null,
    releaseToStopLabel: null,
    requiresForeground: true,
    serverAuthorizationRequired: true,
  }
}
