import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import {
  clearTrustedDeviceToken,
  createTrustedDeviceToken,
  setTrustedDeviceToken,
} from '../lib/trustedDeviceToken'

const trustedDeviceSchema = z.object({
  id: z.string().uuid(),
  deviceLabel: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  lastSeenAt: z.string().nullable(),
  isCurrentDevice: z.boolean(),
})

const trustedDeviceRegistrationSchema = z.object({
  id: z.string().uuid(),
  expiresAt: z.string(),
  days: z.number().int(),
})

export type TrustedDevice = z.infer<typeof trustedDeviceSchema>
export type TrustedDeviceRegistration = z.infer<typeof trustedDeviceRegistrationSchema>

function defaultDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'This browser'
  const platform = navigator.platform?.trim()
  const userAgent = navigator.userAgent
  if (/iPhone|iPad|Android/i.test(userAgent)) return platform || 'Mobile browser'
  return platform ? `${platform} browser` : 'This browser'
}

export async function rememberCurrentDevice(days = 14): Promise<TrustedDeviceRegistration> {
  const token = createTrustedDeviceToken()
  const { data, error } = await getSupabaseClient().rpc('register_trusted_device', {
    trusted_days: days,
    trusted_device_label: defaultDeviceLabel(),
    trusted_token: token,
  })
  if (error) throw new Error(error.message || 'This device could not be remembered.')

  const registration = trustedDeviceRegistrationSchema.parse(data)
  setTrustedDeviceToken(token)
  return registration
}

export async function getCurrentTrustedDevices(): Promise<TrustedDevice[]> {
  const { data, error } = await getSupabaseClient().rpc('get_current_trusted_devices')
  if (error) throw new Error(error.message || 'Remembered devices could not be loaded.')
  return z.array(trustedDeviceSchema).parse(data)
}

export async function revokeCurrentTrustedDevice(deviceId: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('revoke_current_trusted_device', {
    target_trusted_device_id: deviceId,
  })
  if (error) throw new Error(error.message || 'The remembered device could not be revoked.')
}

export async function revokeEmployeeTrustedDevices(employeeId: string): Promise<number> {
  const { data, error } = await getSupabaseClient().rpc('admin_revoke_employee_trusted_devices', {
    target_employee_id: employeeId,
  })
  if (error) throw new Error(error.message || 'Remembered devices could not be revoked.')
  return z.number().int().nonnegative().parse(data)
}

export function clearRememberedDeviceOnThisBrowser(): void {
  clearTrustedDeviceToken()
}
