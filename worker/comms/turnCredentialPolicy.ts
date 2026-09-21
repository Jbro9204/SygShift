/**
 * TURN credentials are generated only by the coordinator, after the caller's
 * current authorization and media scope have been verified. Twelve hours
 * covers a normal shift or extended call without making the per-user provider
 * credential long lived.
 *
 * Cloudflare accepts TURN credential TTLs up to 48 hours. Keep this value
 * below that provider maximum and change it here if the product's expected
 * session duration changes.
 */
export const SYGSPHERE_COMMS_TURN_CREDENTIAL_TTL_SECONDS = 43_200
