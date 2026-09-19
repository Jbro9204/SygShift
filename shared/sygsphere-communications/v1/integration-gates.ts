/**
 * Shared Stage 5 activation contract. Both SygShift and Sygilant must use
 * the exact gate before mounting a communications runtime. It intentionally
 * defaults closed and cannot be enabled by a browser-provided value.
 */
export type SygSphereCommsActivationGate = Readonly<{
  databaseFoundationApplied: boolean
  providerPhysicalDeviceEvidenceComplete: boolean
  coordinatorDeploymentApproved: boolean
  sharedCompatibilityVerified: boolean
}>

export const communicationsRuntimeMayMount = (gate: SygSphereCommsActivationGate): boolean =>
  gate.databaseFoundationApplied
  && gate.providerPhysicalDeviceEvidenceComplete
  && gate.coordinatorDeploymentApproved
  && gate.sharedCompatibilityVerified

export const closedCommunicationsRuntimeGate: SygSphereCommsActivationGate = Object.freeze({
  databaseFoundationApplied: false,
  providerPhysicalDeviceEvidenceComplete: false,
  coordinatorDeploymentApproved: false,
  sharedCompatibilityVerified: false,
})
