import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase/migrations/20260916132452_cross_platform_presence_and_read_receipts.sql'), 'utf8')
const nativeSessionRepair = readFileSync(join(root, 'supabase/migrations/20260916134702_cross_platform_presence_native_sygilant_session_repair.sql'), 'utf8')
const authUserIndex = readFileSync(join(root, 'supabase/migrations/20260916135430_platform_presence_auth_user_index.sql'), 'utf8')
const historyRetention = readFileSync(join(root, 'supabase/migrations/20260916140140_platform_presence_history_retention.sql'), 'utf8')
const accountEligibilityRepair = readFileSync(join(root, 'supabase/migrations/20260916141353_platform_presence_account_eligibility_repair.sql'), 'utf8')
const writeDeduplication = readFileSync(join(root, 'supabase/migrations/20260916142017_sygsphere_presence_write_deduplication.sql'), 'utf8')
const readerAuthorBoundary = readFileSync(join(root, 'supabase/migrations/20260916142703_sygsphere_reader_identity_author_boundary.sql'), 'utf8')

describe('cross-platform presence database guard', () => {
  it('keeps session rows private and uses indexed per-session expiry', () => {
    expect(migration).toContain('alter table private.platform_presence_sessions force row level security')
    expect(migration).toContain('revoke all on private.platform_presence_sessions from public, anon, authenticated')
    expect(migration).toContain('platform_presence_employee_expiry_idx')
    expect(authUserIndex).toContain('platform_presence_auth_user_idx')
    expect(migration).not.toMatch(/cron|schedule\s*\(/i)
    expect(historyRetention).not.toMatch(/cron|schedule\s*\(/i)
  })

  it('aggregates all apps and devices while disabled accounts remain offline', () => {
    expect(migration).toContain("when exists(select 1 from current_sessions where state = 'active') then 'active'")
    expect(migration).toContain("when not coalesce((select enabled from account_state), false) then 'offline'")
    expect(migration).toContain("target_application = 'sygilant'")
    expect(nativeSessionRepair).toContain("target_application not in ('sygshift', 'sygilant')")
    expect(nativeSessionRepair).toContain('from auth.sessions session')
    expect(nativeSessionRepair).not.toContain('sygilant_shared_identity_sessions')
    expect(historyRetention).toContain('private.platform_presence_history')
    expect(historyRetention).toContain('platform_presence_history_capture')
    expect(historyRetention).toContain("when exists(select 1 from history) then 'offline'")
    expect(accountEligibilityRepair).toContain('account.employee_id is not null')
    expect(accountEligibilityRepair).toContain("employee.status = 'active'")
    expect(writeDeduplication).toContain('private.sygsphere_require_read_access(input)')
    expect(writeDeduplication).not.toContain("private.sygsphere_request('presence'")
  })

  it('returns reader identity, avatar, and exact read time only to conversation participants', () => {
    expect(migration).toContain("'photoPath',reader.photo_path")
    expect(migration).toContain("'readAt',r.read_at")
    expect(migration).toContain("perform private.sygsphere_request('conversation'")
    expect(readerAuthorBoundary).toContain("case when target_message.author_id=actor then")
    expect(readerAuthorBoundary).toContain("else '[]'::jsonb end")
  })
})
