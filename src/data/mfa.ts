import { getSupabaseClient } from '../lib/supabase'

const TOTP_ISSUER_NAME = 'SygShift'
const TOTP_FRIENDLY_NAME = 'SygShift'
const DUPLICATE_FACTOR_RETRY_LIMIT = 2

export type MfaAuthenticatorLevel = {
  currentLevel: string | null
  nextLevel: string | null
}

export type MfaEnrollment = {
  factorId: string
  qrCode: string
  secret: string
}

export type MfaFactorSummary = {
  id: string
  friendlyName: string | null
  status: string | null
}

type SupabaseMfaFactor = {
  id: string
  friendly_name?: string | null
  factor_type?: string | null
  status?: string | null
}

function mfaErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error && 'message' in error && typeof error.message === 'string') {
    return `${fallback} ${error.message}`
  }
  return fallback
}

function getErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return ''
}

function isDuplicateFactorNameError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase()
  return message.includes('friendly name') && message.includes('already exists')
}

function createTotpFriendlyName(attempt: number): string {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  return attempt === 0 ? `${TOTP_FRIENDLY_NAME} ${stamp}` : `${TOTP_FRIENDLY_NAME} ${stamp}-${attempt + 1}`
}

export function normalizeTotpQrCode(qrCode: string): string {
  const trimmed = qrCode.trim()
  if (!trimmed) return trimmed

  if (trimmed.startsWith('data:image/svg+xml')) {
    const commaIndex = trimmed.indexOf(',')
    if (commaIndex === -1) return trimmed

    const prefix = trimmed.slice(0, commaIndex + 1)
    const payload = trimmed.slice(commaIndex + 1)
    return payload.includes('<') ? `${prefix}${encodeURIComponent(payload)}` : trimmed
  }

  if (trimmed.startsWith('<svg')) {
    return `data:image/svg+xml;utf-8,${encodeURIComponent(trimmed)}`
  }

  return trimmed
}

export async function getAuthenticatorLevel(): Promise<MfaAuthenticatorLevel> {
  const { data, error } = await getSupabaseClient().auth.mfa.getAuthenticatorAssuranceLevel()
  if (error) throw new Error('The account security level could not be checked.')

  return {
    currentLevel: data.currentLevel,
    nextLevel: data.nextLevel,
  }
}

export async function listTotpFactors(): Promise<MfaFactorSummary[]> {
  const { data, error } = await getSupabaseClient().auth.mfa.listFactors()
  if (error) throw new Error('Authenticator devices could not be loaded.')

  const typedData = data as { totp?: SupabaseMfaFactor[]; all?: SupabaseMfaFactor[] }
  const factorsById = new Map<string, SupabaseMfaFactor>()

  for (const factor of typedData.totp ?? []) {
    factorsById.set(factor.id, factor)
  }

  for (const factor of typedData.all ?? []) {
    if (factor.factor_type === 'totp') {
      factorsById.set(factor.id, factor)
    }
  }

  return [...factorsById.values()].map((factor) => ({
    id: factor.id,
    friendlyName: factor.friendly_name ?? null,
    status: factor.status ?? null,
  }))
}

export async function clearUnverifiedTotpFactors(): Promise<number> {
  const factors = await listTotpFactors()
  const unverifiedFactors = factors.filter((factor) => factor.status !== 'verified')

  for (const factor of unverifiedFactors) {
    const { error } = await getSupabaseClient().auth.mfa.unenroll({ factorId: factor.id })
    if (error) throw new Error(mfaErrorMessage(error, 'Old authenticator setup could not be cleared.'))
  }

  return unverifiedFactors.length
}

export async function startTotpEnrollment(): Promise<MfaEnrollment> {
  await clearUnverifiedTotpFactors()

  let enrollmentError: unknown = null

  for (let attempt = 0; attempt <= DUPLICATE_FACTOR_RETRY_LIMIT; attempt += 1) {
    const { data, error } = await getSupabaseClient().auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: createTotpFriendlyName(attempt),
      issuer: TOTP_ISSUER_NAME,
    })

    if (!error) {
      if (!data.totp?.qr_code || !data.totp.secret) {
        throw new Error('Authenticator setup started, but the QR code was not returned. Refresh the page and try again.')
      }

      return {
        factorId: data.id,
        qrCode: normalizeTotpQrCode(data.totp.qr_code),
        secret: data.totp.secret,
      }
    }

    enrollmentError = error
    if (!isDuplicateFactorNameError(error)) break
  }

  throw new Error(mfaErrorMessage(enrollmentError, 'Authenticator setup could not be started.'))
}

export async function verifyTotpEnrollment(factorId: string, code: string): Promise<void> {
  const challenge = await getSupabaseClient().auth.mfa.challenge({ factorId })
  if (challenge.error) throw new Error('Authenticator verification could not be started.')

  const verification = await getSupabaseClient().auth.mfa.verify({
    factorId,
    challengeId: challenge.data.id,
    code: code.trim(),
  })
  if (verification.error) throw new Error('The authenticator code was not accepted.')

  const refresh = await getSupabaseClient().auth.refreshSession()
  if (refresh.error) throw new Error('Your secure session could not be refreshed.')
}

export async function createMfaChallenge(factorId: string): Promise<string> {
  const { data, error } = await getSupabaseClient().auth.mfa.challenge({ factorId })
  if (error) throw new Error('Authenticator verification could not be started.')
  return data.id
}

export async function verifyMfaChallenge(factorId: string, challengeId: string, code: string): Promise<void> {
  const { error } = await getSupabaseClient().auth.mfa.verify({
    factorId,
    challengeId,
    code: code.trim(),
  })
  if (error) throw new Error('The authenticator code was not accepted.')

  const refresh = await getSupabaseClient().auth.refreshSession()
  if (refresh.error) throw new Error('Your secure session could not be refreshed.')
}
