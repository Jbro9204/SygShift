/**
 * Provider-neutral boundary for the future Cloudflare Realtime adapter. This
 * module intentionally has no endpoint, app ID, credential, request, SDP, or
 * browser media operation. It makes a future reviewed integration explicit
 * instead of allowing a registry/configuration change to create media.
 */
export type SygSphereCommsProviderOperation =
  | 'create_session'
  | 'publish_track'
  | 'subscribe_track'
  | 'force_close_track'
  | 'close_session'

export type SygSphereCommsProviderRequest = Readonly<{
  operation: SygSphereCommsProviderOperation
  requestId: string
  roomId: string
  tenantId: string
}>

export type SygSphereCommsProviderResult = Readonly<{
  outcome: 'provider_unavailable'
  requestId: string
}>

export interface SygSphereCommsProviderAdapter {
  execute(request: SygSphereCommsProviderRequest): Promise<SygSphereCommsProviderResult>
}

/** A closed adapter is the only adapter that may be constructed today. */
export const closedCloudflareRealtimeAdapter: SygSphereCommsProviderAdapter = Object.freeze({
  async execute(request: SygSphereCommsProviderRequest): Promise<SygSphereCommsProviderResult> {
    return { outcome: 'provider_unavailable' as const, requestId: request.requestId }
  },
})
