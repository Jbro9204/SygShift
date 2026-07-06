import { getSupabaseClient } from '../lib/supabase'

const TOTP_ISSUER_NAME = 'SygShift'
const TOTP_FRIENDLY_NAME = 'SygShift'
const PHONE_FRIENDLY_NAME = 'SygShift SMS'
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

export type MfaPhoneEnrollment = {
  factorId: string
  challengeId: string
  phone: string
}

export type MfaFactorType = 'totp' | 'phone'

export type MfaFactorSummary = {
  id: string
  factorType: MfaFactorType
  friendlyName: string | null
  status: string | null
  phone: string | null
}

type SupabaseMfaFactor = {
  id: string
  friendly_name?: string | null
  factor_type?: string | null
  status?: string | null
  phone?: string | null
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

function isPhoneMfaDisabledError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase()
  return message.includes('phone') && message.includes('disabled')
}

function phoneMfaNotReadyMessage(): string {
  return 'Text message MFA is not enabled in Supabase yet. Use Authenticator App for now, or ask an administrator to enable Advanced MFA Phone before using text codes.'
}

function createTotpFriendlyName(attempt: number): string {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  return attempt === 0 ? `${TOTP_FRIENDLY_NAME} ${stamp}` : `${TOTP_FRIENDLY_NAME} ${stamp}-${attempt + 1}`
}

function createPhoneFriendlyName(attempt: number): string {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  return attempt === 0 ? `${PHONE_FRIENDLY_NAME} ${stamp}` : `${PHONE_FRIENDLY_NAME} ${stamp}-${attempt + 1}`
}

export function normalizeSmsPhoneNumber(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''

  const hasInternationalPrefix = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D/g, '')

  if (!digits) return ''
  if (hasInternationalPrefix) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return `+${digits}`
}

export function validateSmsPhoneNumber(input: string): string {
  const normalized = normalizeSmsPhoneNumber(input)

  if (!/^\+[1-9]\d{9,14}$/.test(normalized)) {
    throw new Error('Enter a valid mobile number that can receive texts. Example: 720-555-1234.')
  }

  return normalized
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

export async function listMfaFactors(): Promise<MfaFactorSummary[]> {
  const { data, error } = await getSupabaseClient().auth.mfa.listFactors()
  if (error) throw new Error('MFA methods could not be loaded.')

  const typedData = data as { totp?: SupabaseMfaFactor[]; phone?: SupabaseMfaFactor[]; all?: SupabaseMfaFactor[] }
  const factorsById = new Map<string, SupabaseMfaFactor>()

  for (const factor of typedData.totp ?? []) {
    factorsById.set(factor.id, { ...factor, factor_type: 'totp' })
  }

  for (const factor of typedData.phone ?? []) {
    factorsById.set(factor.id, { ...factor, factor_type: 'phone' })
  }

  for (const factor of typedData.all ?? []) {
    if (factor.factor_type === 'totp' || factor.factor_type === 'phone') {
      factorsById.set(factor.id, factor)
    }
  }

  return [...factorsById.values()].map((factor) => {
    const factorType = factor.factor_type === 'phone' ? 'phone' : 'totp'
    return {
    id: factor.id,
    factorType,
    friendlyName: factor.friendly_name ?? null,
    status: factor.status ?? null,
    phone: factor.phone ?? null,
    }
  })
}

export async function listTotpFactors(): Promise<MfaFactorSummary[]> {
  const factors = await listMfaFactors()
  return factors.filter((factor) => factor.factorType === 'totp')
}

export async function clearUnverifiedMfaFactors(factorType: MfaFactorType): Promise<number> {
  const factors = await listMfaFactors()
  const unverifiedFactors = factors.filter((factor) => factor.factorType === factorType && factor.status !== 'verified')

  for (const factor of unverifiedFactors) {
    const { error } = await getSupabaseClient().auth.mfa.unenroll({ factorId: factor.id })
    if (error) {
      throw new Error(mfaErrorMessage(error, factorType === 'phone' ? 'Old SMS setup could not be cleared.' : 'Old authenticator setup could not be cleared.'))
    }
  }

  return unverifiedFactors.length
}

export async function clearUnverifiedTotpFactors(): Promise<number> {
  return clearUnverifiedMfaFactors('totp')
}

export async function clearUnverifiedPhoneFactors(): Promise<number> {
  return clearUnverifiedMfaFactors('phone')
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

export async function startPhoneEnrollment(phoneNumber: string): Promise<MfaPhoneEnrollment> {
  await clearUnverifiedPhoneFactors()

  const normalizedPhone = validateSmsPhoneNumber(phoneNumber)
  let enrollmentError: unknown = null

  for (let attempt = 0; attempt <= DUPLICATE_FACTOR_RETRY_LIMIT; attempt += 1) {
    const { data, error } = await getSupabaseClient().auth.mfa.enroll({
      factorType: 'phone',
      friendlyName: createPhoneFriendlyName(attempt),
      phone: normalizedPhone,
    })

    if (!error) {
      const challengeId = await createMfaChallenge(data.id, 'phone')
      return {
        factorId: data.id,
        challengeId,
        phone: data.phone ?? normalizedPhone,
      }
    }

    enrollmentError = error
    if (isPhoneMfaDisabledError(error)) throw new Error(phoneMfaNotReadyMessage())
    if (!isDuplicateFactorNameError(error)) break
  }

  throw new Error(mfaErrorMessage(enrollmentError, 'SMS verification could not be started.'))
}

export async function verifyTotpEnrollment(factorId: string, code: string): Promise<void> {
  const challengeId = await createMfaChallenge(factorId, 'totp')

  await verifyMfaChallenge(factorId, challengeId, code, 'totp')
}

export async function createMfaChallenge(factorId: string, factorType: MfaFactorType = 'totp'): Promise<string> {
  const { data, error } = factorType === 'phone'
    ? await getSupabaseClient().auth.mfa.challenge({ factorId, channel: 'sms' })
    : await getSupabaseClient().auth.mfa.challenge({ factorId })
  if (error) {
    if (factorType === 'phone' && isPhoneMfaDisabledError(error)) throw new Error(phoneMfaNotReadyMessage())
    throw new Error(factorType === 'phone' ? 'SMS verification code could not be sent.' : 'Authenticator verification could not be started.')
  }
  return data.id
}

export async function verifyMfaChallenge(
  factorId: string,
  challengeId: string,
  code: string,
  factorType: MfaFactorType = 'totp',
): Promise<void> {
  const { error } = await getSupabaseClient().auth.mfa.verify({
    factorId,
    challengeId,
    code: code.trim(),
  })
  if (error) throw new Error(factorType === 'phone' ? 'The text message code was not accepted.' : 'The authenticator code was not accepted.')

  const refresh = await getSupabaseClient().auth.refreshSession()
  if (refresh.error) throw new Error('Your secure session could not be refreshed.')
}
