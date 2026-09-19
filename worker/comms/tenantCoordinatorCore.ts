/**
 * Stage 4 coordinator core. This module deliberately has no Cloudflare
 * binding, provider call, socket, or browser entrypoint. A later DO wrapper
 * may call it only after the staged database and physical-device gates pass.
 */
import { z } from 'zod'

export const stagedCommsAuthorizationContextSchema = z.object({
  tenantId: z.uuid(),
  employeeId: z.uuid(),
  authUserId: z.uuid(),
  permissions: z.array(z.string().regex(/^sygsphere\.comms\.[a-z.]+$/)).readonly(),
  canUseCommunications: z.boolean(),
}).strict()

export type StagedCommsAuthorizationContext = z.infer<typeof stagedCommsAuthorizationContextSchema>

const COMMUNICATIONS_USE_PERMISSION = 'sygsphere.comms.use'

export const tenantCoordinatorObjectName = (tenantId: string): string => {
  const parsed = z.uuid().safeParse(tenantId)
  if (!parsed.success) throw new Error('The communications tenant context is unavailable.')
  return `sygsphere-comms:${parsed.data}`
}

export const authorizeCoordinatorSession = (input: unknown): StagedCommsAuthorizationContext => {
  const parsed = stagedCommsAuthorizationContextSchema.safeParse(input)
  if (!parsed.success || !parsed.data.canUseCommunications || !parsed.data.permissions.includes(COMMUNICATIONS_USE_PERMISSION)) {
    throw new Error('Communications are not available for this account.')
  }
  return parsed.data
}

export const runtimeGateMessage = (): string =>
  'Communications setup is not available yet. Continue using SygSphere messages and Dispatch.'
