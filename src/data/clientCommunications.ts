import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const clientCommunicationActorSchema = z.object({
  employeeId: z.string().uuid(),
  canManage: z.boolean(),
  canView: z.boolean(),
})

const clientCommunicationSchema = z.object({
  linkId: z.string().uuid(),
  clientId: z.string().uuid(),
  clientName: z.string(),
  clientNumber: z.string(),
  conversationId: z.string().uuid(),
  conversationName: z.string(),
  kind: z.enum(['direct', 'group', 'channel']),
  archived: z.boolean(),
  purpose: z.string().nullable(),
  linkedAt: z.string(),
  linkedBy: z.string().uuid(),
  updatedAt: z.string(),
  unread: z.number().int().nonnegative(),
  latestBody: z.string().nullable(),
  latestCreatedAt: z.string().nullable(),
  owner: z.boolean(),
})

const availableConversationSchema = z.object({
  conversationId: z.string().uuid(),
  conversationName: z.string(),
  kind: z.enum(['direct', 'group', 'channel']),
  archived: z.boolean(),
  owner: z.boolean(),
  updatedAt: z.string(),
})

const paginationSchema = z.object({
  page: z.number().int().positive(),
  pageSize: z.union([z.literal(10), z.literal(20), z.literal(50)]),
  totalCount: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
})

const clientCommunicationsWorkspaceSchema = z.object({
  actor: clientCommunicationActorSchema,
  clientId: z.string().uuid().nullable(),
  rows: z.array(clientCommunicationSchema),
  pagination: paginationSchema,
})

const clientCommunicationCandidatesSchema = z.object({
  rows: z.array(availableConversationSchema),
  pagination: paginationSchema,
})

const clientCommunicationAssociationSchema = z.object({
  actor: clientCommunicationActorSchema,
  communication: clientCommunicationSchema.nullable(),
})

export type ClientCommunication = z.infer<typeof clientCommunicationSchema>
export type ClientCommunicationsWorkspace = z.infer<typeof clientCommunicationsWorkspaceSchema>
export type ClientCommunicationCandidate = z.infer<typeof availableConversationSchema>

export async function getClientCommunications(input: {
  clientId?: string
  search?: string
  page?: number
  pageSize?: 10 | 20 | 50
} = {}): Promise<ClientCommunicationsWorkspace> {
  const { data, error } = await getSupabaseClient().rpc('list_client_communications', {
    target_client_id: input.clientId ?? null,
    target_search: input.search?.trim() || null,
    target_page: input.page ?? 1,
    target_page_size: input.pageSize ?? 20,
  })
  if (error) throw new Error(error.message || 'Client communications could not be loaded.')
  return clientCommunicationsWorkspaceSchema.parse(data)
}

export async function getClientCommunicationCandidates(input: {
  clientId: string
  search?: string
  page?: number
  pageSize?: 10 | 20 | 50
}) {
  const { data, error } = await getSupabaseClient().rpc('list_client_communication_candidates', {
    target_client_id: input.clientId,
    target_search: input.search?.trim() || null,
    target_page: input.page ?? 1,
    target_page_size: input.pageSize ?? 20,
  })
  if (error) throw new Error(error.message || 'Available SygSphere conversations could not be loaded.')
  return clientCommunicationCandidatesSchema.parse(data)
}

export async function getClientCommunicationForConversation(conversationId: string) {
  const { data, error } = await getSupabaseClient().rpc('get_client_communication_for_conversation', {
    target_conversation_id: conversationId,
  })
  if (error) throw new Error(error.message || 'The Client File link could not be loaded.')
  return clientCommunicationAssociationSchema.parse(data)
}

export async function linkClientConversation(input: {
  requestId: string
  clientId: string
  conversationId: string
  purpose: string
}): Promise<void> {
  const { error } = await getSupabaseClient().rpc('link_client_sygsphere_conversation', {
    target_request_id: input.requestId,
    target_client_id: input.clientId,
    target_conversation_id: input.conversationId,
    target_purpose: input.purpose,
  })
  if (error) throw new Error(error.message || 'The conversation could not be linked to this Client File.')
}

export async function unlinkClientConversation(input: {
  requestId: string
  linkId: string
  clientId: string
  conversationId: string
  reason: string
}): Promise<void> {
  const { error } = await getSupabaseClient().rpc('unlink_client_sygsphere_conversation', {
    target_request_id: input.requestId,
    target_link_id: input.linkId,
    target_client_id: input.clientId,
    target_conversation_id: input.conversationId,
    target_reason: input.reason,
  })
  if (error) throw new Error(error.message || 'The conversation could not be unlinked from this Client File.')
}
