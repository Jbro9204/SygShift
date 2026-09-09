/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260910050000_bind_sygilant_sessions_to_sygsphere.sql'),
  'utf8',
)

describe('Sygilant native SygSphere assurance bridge', () => {
  it('binds inherited Sygilant sessions only to the SygSphere scope', () => {
    expect(migration).toContain("'sygsphere'")
    expect(migration).toContain('private.shared_identity_sessions')
    expect(migration).toContain('new.auth_session_id')
    expect(migration).toContain('new.session_token_hash')
    expect(migration).toContain('new.provider_request_id')
    expect(migration).not.toContain("'platform'")
  })

  it('keeps activation and assurance binding in one database transaction', () => {
    expect(migration).toContain('create trigger bind_sygilant_session_to_sygsphere')
    expect(migration).toContain('after update of status, session_token_hash, session_expires_at')
    expect(migration).toContain("new.status = 'active'")
    expect(migration).toContain("new.status in ('revoked', 'expired')")
    expect(migration).toContain("'source', 'sygilant'")
  })

  it('repairs already-active sessions without widening their authority', () => {
    expect(migration).toContain("where sygilant_session.status = 'active'")
    expect(migration).toContain("scope = 'sygsphere'")
    expect(migration).toContain('auth_session.user_id = sygilant_session.auth_user_id')
    expect(migration).toContain('auth_session.not_after is null')
  })
})
