import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import { appendProtectedSessionHeaders } from '../lib/protectedSessionHeaders'

export const SYGILANT_LAUNCH_ENDPOINT = '/api/v1/apps/sygilant/launch'

const sygilantLaunchResponseSchema = z.object({
  launch: z.object({
    applicationId: z.literal('sygilant'),
    applicationUrl: z.string().url(),
    assertion: z.string().regex(/^ssli_v1\.[A-Za-z0-9_-]{20,5000}\.[a-f0-9]{64}$/i),
    destination: z.literal('/dashboard'),
    expiresAt: z.string().datetime(),
    requestId: z.string().uuid(),
  }),
})

export type SygilantPlatformLaunch = z.infer<typeof sygilantLaunchResponseSchema>['launch']

function validatedSygilantApplicationUrl(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'sygilant.us'
    || url.port
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('Sygilant returned an invalid launch destination.')
  }
  return url.origin
}

export async function launchSygilantPlatform(): Promise<SygilantPlatformLaunch> {
  const { data, error } = await getSupabaseClient().auth.getSession()
  if (error || !data.session?.access_token) {
    throw new Error('Your secure SygShift session could not be confirmed. Please sign in again.')
  }

  const headers = appendProtectedSessionHeaders({
    accept: 'application/json',
    authorization: `Bearer ${data.session.access_token}`,
  })
  const response = await fetch(SYGILANT_LAUNCH_ENDPOINT, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers,
    method: 'POST',
  })
  const parsed = sygilantLaunchResponseSchema.safeParse(await response.json().catch(() => null))

  if (!response.ok || !parsed.success) {
    throw new Error('Sygilant could not be opened securely. Please try again.')
  }

  return {
    ...parsed.data.launch,
    applicationUrl: validatedSygilantApplicationUrl(parsed.data.launch.applicationUrl),
  }
}

export function submitSygilantPlatformLaunch(launch: SygilantPlatformLaunch): void {
  const form = document.createElement('form')
  form.action = `${validatedSygilantApplicationUrl(launch.applicationUrl)}/api/auth/shared-identity/launch`
  form.method = 'POST'
  form.hidden = true

  for (const [name, value] of [['assertion', launch.assertion], ['destination', launch.destination]] as const) {
    const input = document.createElement('input')
    input.name = name
    input.type = 'hidden'
    input.value = value
    form.append(input)
  }

  document.body.append(form)
  form.submit()
  form.remove()
}
