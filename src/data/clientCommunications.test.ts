import { beforeEach, describe, expect, it, vi } from 'vitest'
import { linkClientConversation, unlinkClientConversation } from './clientCommunications'

const rpc = vi.hoisted(() => vi.fn())

vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({ rpc }) }))

const requestId = '10000000-0000-4000-8000-000000000001'
const linkId = '20000000-0000-4000-8000-000000000002'
const clientId = '30000000-0000-4000-8000-000000000003'
const conversationId = '40000000-0000-4000-8000-000000000004'

describe('Client Communications mutation contracts', () => {
  beforeEach(() => rpc.mockReset().mockResolvedValue({ data: null, error: null }))

  it('passes the caller request UUID through to the link RPC', async () => {
    await linkClientConversation({
      requestId,
      clientId,
      conversationId,
      purpose: 'Dispatch coordination',
    })

    expect(rpc).toHaveBeenCalledWith('link_client_sygsphere_conversation', {
      target_request_id: requestId,
      target_client_id: clientId,
      target_conversation_id: conversationId,
      target_purpose: 'Dispatch coordination',
    })
  })

  it('passes both the caller request UUID and exact link generation to the unlink RPC', async () => {
    await unlinkClientConversation({
      requestId,
      linkId,
      clientId,
      conversationId,
      reason: 'The client association has changed.',
    })

    expect(rpc).toHaveBeenCalledWith('unlink_client_sygsphere_conversation', {
      target_request_id: requestId,
      target_link_id: linkId,
      target_client_id: clientId,
      target_conversation_id: conversationId,
      target_reason: 'The client association has changed.',
    })
  })
})
