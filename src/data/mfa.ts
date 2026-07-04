import { getSupabaseClient } from '../lib/supabase'

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

  return (data.totp as SupabaseMfaFactor[]).map((factor) => ({
    id: factor.id,
    friendlyName: factor.friendly_name ?? null,
    status: factor.status ?? null,
  }))
}

export async function startTotpEnrollment(): Promise<MfaEnrollment> {
  const { data, error } = await getSupabaseClient().auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'SygShift authenticator',
  })

  if (error) throw new Error('Authenticator setup could not be started.')

  return {
    factorId: data.id,
    qrCode: data.totp.qr_code,
    secret: data.totp.secret,
  }
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
