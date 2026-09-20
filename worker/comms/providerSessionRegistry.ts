export type ProviderTrackKind = 'audio' | 'video' | 'screen'
export type ProviderSessionState = 'pending' | 'active' | 'closing' | 'closed'

export type ProviderTrack = Readonly<{
  id: string
  kind: ProviderTrackKind
  /** The provider transceiver reference is server-owned and never browser supplied. */
  mid?: string
  state: 'active' | 'closed'
}>

export type ProviderSession = Readonly<{
  id: string
  state: ProviderSessionState
  tenantId: string
  tracks: ReadonlyMap<string, ProviderTrack>
}>

export const createProviderSession = (id: string, tenantId: string): ProviderSession => ({
  id,
  state: 'pending',
  tenantId,
  tracks: new Map(),
})

export const activateProviderSession = (session: ProviderSession): ProviderSession =>
  session.state === 'pending' ? { ...session, state: 'active' } : session

/** Only the coordinator supplies these IDs after it has resolved membership. */
export const registerProviderTrack = (
  session: ProviderSession,
  track: ProviderTrack,
): ProviderSession => {
  if (session.state !== 'active' || session.tracks.has(track.id)) return session
  const tracks = new Map(session.tracks)
  tracks.set(track.id, track)
  return { ...session, tracks }
}

export const forceCloseProviderTrack = (session: ProviderSession, trackId: string): ProviderSession => {
  const current = session.tracks.get(trackId)
  if (!current || current.state === 'closed') return session
  const tracks = new Map(session.tracks)
  tracks.set(trackId, { ...current, state: 'closed' })
  return { ...session, tracks }
}

export const closeProviderSession = (session: ProviderSession): ProviderSession => {
  if (session.state === 'closed') return session
  const tracks = new Map([...session.tracks].map(([id, track]) => [id, { ...track, state: 'closed' as const }]))
  return { ...session, state: 'closed', tracks }
}

/**
 * A provider mutation may proceed only for the exact tenant-owned active
 * session resolved by the coordinator. This is intentionally a small pure
 * boundary so the HTTP adapter cannot be given a browser-shaped session id.
 */
export const providerSessionMayMutate = (session: ProviderSession, tenantId: string): boolean =>
  session.tenantId === tenantId
  && session.state === 'active'
  && session.id.trim().length > 0

/** A forced close is additionally fenced to a registered, active track/MID. */
export const providerTrackMayMutate = (
  session: ProviderSession,
  tenantId: string,
  trackId: string,
  mid: string,
): boolean => {
  if (!providerSessionMayMutate(session, tenantId)) return false
  const track = session.tracks.get(trackId)
  return Boolean(track && track.state === 'active' && track.mid === mid)
}
