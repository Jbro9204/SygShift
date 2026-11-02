// Isolated browser transport: synthetic identities only, no network or live Auth.
type FixtureSession = { user: { id: string }; access_token: string }
type AuthListener = (event: string, session: FixtureSession | null) => void
const listeners = new Set<AuthListener>()
let guard = false
function makeSession(): FixtureSession {
  const id = guard ? '10000000-0000-4000-8000-000000000002' : '10000000-0000-4000-8000-000000000001'
  const sessionId = guard ? '20000000-0000-4000-8000-000000000002' : '20000000-0000-4000-8000-000000000001'
  return { user: { id }, access_token: `fixture.${btoa(JSON.stringify({ sub: id, session_id: sessionId }))}.not-a-real-token` }
}
let session: FixtureSession | null = makeSession()
const client = { auth: {
  async getSession() { return { data: { session }, error: null } },
  onAuthStateChange(listener: AuthListener) {
    listeners.add(listener)
    return { data: { subscription: { unsubscribe() { listeners.delete(listener) } } } }
  },
} }
export function getSupabaseClient() { return client }
export function getSharedIdentitySessionScope() { return null }
export function switchFixtureActor(toGuard: boolean) {
  guard = toGuard
  session = makeSession()
  listeners.forEach((listener) => listener('SIGNED_IN', session))
}
export function signOutFixtureActor() {
  session = null
  listeners.forEach((listener) => listener('SIGNED_OUT', null))
}
export function refreshFixtureActor() { listeners.forEach((listener) => listener('TOKEN_REFRESHED', session)) }
export async function listMfaFactors() {
  return guard ? [] : [{ factorType: 'totp', friendlyName: 'Fixture authenticator', id: 'fixture-factor', phone: null, status: 'verified' }]
}
export async function createMfaChallenge() { return 'fixture-challenge' }
export async function verifyMfaChallenge() { refreshFixtureActor() }
export async function getSecurityKeyDirectory() { return { featureEnabled: false, keys: [], pilotEligible: false, requestId: 'fixture' } }
export async function authenticateWithSecurityKey() { throw new Error('Not enabled in this isolated fixture.') }
