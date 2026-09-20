/** Server-authoritative usage presentation. Values are deliberately explicit
 * about whether they are unavailable, estimated, or reconciled; provider
 * analytics are operational reconciliation, never a billing promise. */
export const SYGSPHERE_COMMS_MONTHLY_ALLOWANCE_DECIMAL_GB = 1_000
export const SYGSPHERE_COMMS_OVERAGE_USD_PER_DECIMAL_GB = 0.05

export type SygSphereCommsUsageTelemetryStatus = 'unavailable' | 'estimated' | 'reconciled'

export type SygSphereCommsUsageInput = Readonly<{
  periodEndsAt: string
  periodStartsAt: string
  receivedBytes: number | null
  reconciliationAsOf: string | null
  telemetryStatus: SygSphereCommsUsageTelemetryStatus
}>

export const buildSygSphereCommsUsageResponse = (input: SygSphereCommsUsageInput) => {
  const bytes = input.receivedBytes === null ? null : Math.max(0, Math.floor(input.receivedBytes))
  const effectiveGigabytes = bytes === null ? null : Number((bytes / 1_000_000_000).toFixed(3))
  const remainingGigabytes = effectiveGigabytes === null
    ? null
    : Number(Math.max(0, SYGSPHERE_COMMS_MONTHLY_ALLOWANCE_DECIMAL_GB - effectiveGigabytes).toFixed(3))
  const projectedOverageGigabytes = effectiveGigabytes === null
    ? null
    : Number(Math.max(0, effectiveGigabytes - SYGSPHERE_COMMS_MONTHLY_ALLOWANCE_DECIMAL_GB).toFixed(3))

  return {
    allowance: {
      decimalGigabytes: SYGSPHERE_COMMS_MONTHLY_ALLOWANCE_DECIMAL_GB,
      overageUsdPerDecimalGigabyte: SYGSPHERE_COMMS_OVERAGE_USD_PER_DECIMAL_GB,
    },
    billingPeriod: { endsAt: input.periodEndsAt, startsAt: input.periodStartsAt },
    projected: {
      estimatedOverageUsd: projectedOverageGigabytes === null
        ? null
        : Number((projectedOverageGigabytes * SYGSPHERE_COMMS_OVERAGE_USD_PER_DECIMAL_GB).toFixed(2)),
      overageGigabytes: projectedOverageGigabytes,
      remainingAllowanceGigabytes: remainingGigabytes,
    },
    reconciliation: {
      asOf: input.reconciliationAsOf,
      status: input.telemetryStatus,
    },
    usage: {
      receivedBytes: bytes,
      receivedDecimalGigabytes: effectiveGigabytes,
    },
  } as const
}
