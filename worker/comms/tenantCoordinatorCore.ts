/**
 * Stage 4 coordinator core. This module deliberately has no Cloudflare
 * binding, provider call, socket, or browser entrypoint. A later DO wrapper
 * may call it only after the staged database and physical-device gates pass.
 */
import { z } from 'zod'
import {
  parseSygSphereCommsCommand,
  type SygSphereCommsCommandKind,
  type ValidatedSygSphereCommsCommand,
} from '../../shared/sygsphere-communications/v1/contract'

export const stagedCommsAuthorizationContextSchema = z.object({
  tenantId: z.uuid(),
  employeeId: z.uuid(),
  authUserId: z.uuid(),
  permissions: z.array(z.string().regex(/^sygsphere\.comms\.[a-z.]+$/)).readonly(),
  canUseCommunications: z.boolean(),
}).strict()

export type StagedCommsAuthorizationContext = z.infer<typeof stagedCommsAuthorizationContextSchema>

const COMMUNICATIONS_USE_PERMISSION = 'sygsphere.comms.use'

const coordinatorPermissionByCommand: Readonly<Record<SygSphereCommsCommandKind, string>> = {
  auth: COMMUNICATIONS_USE_PERMISSION,
  heartbeat: COMMUNICATIONS_USE_PERMISSION,
  resume: COMMUNICATIONS_USE_PERMISSION,
  'snapshot.request': COMMUNICATIONS_USE_PERMISSION,
  'floor.request': 'sygsphere.comms.ptt.transmit',
  'floor.cancel': 'sygsphere.comms.ptt.transmit',
  'floor.renew': 'sygsphere.comms.ptt.transmit',
  'floor.release': 'sygsphere.comms.ptt.transmit',
  'call.request': 'sygsphere.comms.call.start',
  'call.accept': 'sygsphere.comms.call.receive',
  'call.decline': 'sygsphere.comms.call.receive',
  'call.cancel': 'sygsphere.comms.call.start',
  'call.end': COMMUNICATIONS_USE_PERMISSION,
  'meeting.create': 'sygsphere.comms.meeting.create',
  'meeting.join': COMMUNICATIONS_USE_PERMISSION,
  'meeting.leave': COMMUNICATIONS_USE_PERMISSION,
  'meeting.end': 'sygsphere.comms.moderate',
  'participant.remove': 'sygsphere.comms.moderate',
  'participant.mute': 'sygsphere.comms.moderate',
  'media.answer': COMMUNICATIONS_USE_PERMISSION,
  'media.ready': COMMUNICATIONS_USE_PERMISSION,
  'media.layout': COMMUNICATIONS_USE_PERMISSION,
  'media.stop': COMMUNICATIONS_USE_PERMISSION,
  'camera.request': 'sygsphere.comms.video.publish',
  'camera.release': COMMUNICATIONS_USE_PERMISSION,
  'screen.request': 'sygsphere.comms.screen.publish',
  'screen.release': COMMUNICATIONS_USE_PERMISSION,
  'focus.request': COMMUNICATIONS_USE_PERMISSION,
  'focus.release': COMMUNICATIONS_USE_PERMISSION,
}

export const coordinatorReleaseContextSchema = z.object({
  databaseFoundationApplied: z.boolean(),
  commandSchemasVerified: z.boolean(),
  providerPhysicalDeviceEvidenceComplete: z.boolean(),
  coordinatorDeploymentApproved: z.boolean(),
  sharedCompatibilityVerified: z.boolean(),
  runtimeEnabled: z.boolean(),
}).strict()

export type CoordinatorReleaseContext = z.infer<typeof coordinatorReleaseContextSchema>

/**
 * A direct-call scope is resolved only by the service-only database function.
 * It contains no browser-chosen authority: the conversation and recipient are
 * verified from the active SygSphere membership before this reaches the DO.
 */
export const directConversationCommandScopeSchema = z.object({
  kind: z.literal('direct_conversation'),
  conversationReference: z.uuid(),
  recipientEmployeeId: z.uuid(),
}).strict()

export type DirectConversationCommandScope = z.infer<typeof directConversationCommandScopeSchema>

const coordinatorInvocationSchema = z.object({
  authorization: stagedCommsAuthorizationContextSchema,
  command: z.unknown(),
  release: coordinatorReleaseContextSchema,
  requestId: z.uuid(),
  scope: directConversationCommandScopeSchema.nullish(),
  connectionRouteReference: z.uuid().optional(),
}).strict()

export type AuthorizedCoordinatorCommand = Readonly<{
  authorization: StagedCommsAuthorizationContext
  command: ValidatedSygSphereCommsCommand
  requiredPermission: string
  release: CoordinatorReleaseContext
  requestId: string
  scope: DirectConversationCommandScope | null
  connectionRouteReference: string | null
}>

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

export const coordinatorPermissionForCommand = (kind: SygSphereCommsCommandKind): string =>
  coordinatorPermissionByCommand[kind]

/**
 * This validates only server-forwarded input. It deliberately does not decide
 * room membership, assignment scope, or provider access: those remain a
 * database/coordinator concern and are not satisfiable from browser input.
 */
export const authorizeCoordinatorCommand = (input: unknown): AuthorizedCoordinatorCommand => {
  const invocation = coordinatorInvocationSchema.parse(input)
  const authorization = authorizeCoordinatorSession(invocation.authorization)
  const command = parseSygSphereCommsCommand(invocation.command)
  const requiredPermission = coordinatorPermissionForCommand(command.kind)
  const scope = invocation.scope ?? null

  if (!authorization.permissions.includes(requiredPermission)) {
    throw new Error('Communications are not available for this account.')
  }
  if (command.kind === 'call.request' && (!scope || scope.conversationReference !== command.payload.conversationReference)) {
    throw new Error('Communications are not available for this account.')
  }
  if (command.kind !== 'call.request' && scope !== null) {
    throw new Error('Communications are not available for this account.')
  }

  return {
    authorization,
    command,
    requiredPermission,
    release: invocation.release,
    requestId: invocation.requestId,
    scope,
    connectionRouteReference: invocation.connectionRouteReference ?? null,
  }
}

export const coordinatorRuntimeMayDispatch = (release: CoordinatorReleaseContext): boolean =>
  release.databaseFoundationApplied
  && release.commandSchemasVerified
  && release.providerPhysicalDeviceEvidenceComplete
  && release.coordinatorDeploymentApproved
  && release.sharedCompatibilityVerified
  && release.runtimeEnabled

export const runtimeGateMessage = (): string =>
  'Communications setup is not available yet. Continue using SygSphere messages and Dispatch.'
