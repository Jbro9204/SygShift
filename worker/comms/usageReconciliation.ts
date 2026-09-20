/**
 * Provider telemetry is reconciled only from evidence that a server process
 * already verified. This module does not fetch provider data and refuses to
 * turn an empty or unverified observation into a zero-usage assertion.
 */
export type SygSphereUsageObservation = Readonly<{
  observedAt: string
  receivedBytes: number
  sourceDigest: string
  sourceReference: string
}>

export type SygSphereUsageReconciliation = Readonly<{
  receivedBytes: number | null
  reconciliationAsOf: string | null
  telemetryStatus: 'unavailable' | 'estimated' | 'reconciled'
}>

const sourceDigestPattern = /^[a-f0-9]{64}$/

const isValidObservation = (observation: SygSphereUsageObservation): boolean =>
  Number.isSafeInteger(observation.receivedBytes)
  && observation.receivedBytes >= 0
  && sourceDigestPattern.test(observation.sourceDigest)
  && observation.sourceReference.trim().length > 0
  && !Number.isNaN(Date.parse(observation.observedAt))

export const unavailableSygSphereUsageReconciliation = (): SygSphereUsageReconciliation => ({
  receivedBytes: null,
  reconciliationAsOf: null,
  telemetryStatus: 'unavailable',
})

export const reconcileVerifiedSygSphereUsage = (
  observations: readonly SygSphereUsageObservation[],
): SygSphereUsageReconciliation => {
  if (!observations.length) return unavailableSygSphereUsageReconciliation()
  if (observations.some((observation) => !isValidObservation(observation))) {
    throw new Error('Usage reconciliation requires verified provider observations.')
  }
  const distinctEvidence = new Set(observations.map((observation) => observation.sourceDigest))
  if (distinctEvidence.size !== observations.length) throw new Error('Usage reconciliation evidence cannot be replayed.')
  const receivedBytes = observations.reduce((total, observation) => total + observation.receivedBytes, 0)
  if (!Number.isSafeInteger(receivedBytes)) throw new Error('Usage reconciliation exceeds the supported range.')
  const reconciliationAsOf = observations
    .map((observation) => observation.observedAt)
    .sort()
    .at(-1) ?? null
  return { receivedBytes, reconciliationAsOf, telemetryStatus: 'reconciled' }
}
