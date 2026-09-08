import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

export const SYGILANT_LAUNCH_ENDPOINT = '/api/v1/apps/sygilant/launch'

const sygilantLaunchResponseSchema = z.object({
  launchUrl: z.string().url(),
})

function validatedSygilantLaunchUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'sygilant.us') {
    throw new Error('Sygilant returned an invalid launch destination.')
  }
  return url.toString()
}

export async function launchSygilantPlatform(): Promise<string> {
  const { data, error } = await getSupabaseClient().auth.getSession()
  if (error || !data.session?.access_token) {
    throw new Error('Your secure SygShift session could not be confirmed. Please sign in again.')
  }

  const response = await fetch(SYGILANT_LAUNCH_ENDPOINT, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${data.session.access_token}`,
    },
    method: 'POST',
  })
  const parsed = sygilantLaunchResponseSchema.safeParse(await response.json().catch(() => null))

  if (!response.ok || !parsed.success) {
    throw new Error('Sygilant could not be opened securely. Please try again.')
  }

  return validatedSygilantLaunchUrl(parsed.data.launchUrl)
}
