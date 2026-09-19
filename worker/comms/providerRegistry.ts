/**
 * Provider registry boundary. This source contains no provider credential,
 * endpoint, session, or transport operation. A later reviewed adapter may be
 * registered only after the release context is fully open.
 */
export type SygSphereCommsProviderRegistry = Readonly<{
  provider: 'cloudflare-realtime'
  enabled: false
  reason: 'provider_adapter_not_released'
}>

export const closedSygSphereCommsProviderRegistry: SygSphereCommsProviderRegistry = Object.freeze({
  provider: 'cloudflare-realtime',
  enabled: false,
  reason: 'provider_adapter_not_released',
})

export const providerRegistryMayCreateSession = (registry: SygSphereCommsProviderRegistry): boolean =>
  registry.enabled

/**
 * The coordinator may use this outcome while the adapter is intentionally
 * absent. Making it a named boundary prevents a later registry edit from
 * silently becoming a provider call.
 */
export const closedProviderOutcome = (registry: SygSphereCommsProviderRegistry): 'provider_unavailable' => {
  if (providerRegistryMayCreateSession(registry)) {
    throw new Error('The communications provider registry must remain disabled until a separately approved release.')
  }
  return 'provider_unavailable'
}
