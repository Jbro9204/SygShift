/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260908233000_sygsphere_experience_mentions_previews.sql'), 'utf8')
const data = readFileSync(join(root, 'src', 'data', 'sygsphere.ts'), 'utf8')
const page = readFileSync(join(root, 'src', 'pages', 'SygSpherePage.tsx'), 'utf8')
const files = readFileSync(join(root, 'worker', 'sygsphereFiles.ts'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')

describe('SygSphere experience boundaries', () => {
  it('stores structured mentions and validates every target against active conversation membership', () => {
    expect(migration).toContain('create table private.sygsphere_mentions')
    expect(migration).toContain('member.conversation_id = new.conversation_id')
    expect(migration).toContain("member.removed_at is null and employee.status = 'active' and account.disabled_at is null")
    expect(migration).toContain("action = 'mentions'")
    expect(data).toContain('mentionIds: sphereMentionIds')
    expect(data).toContain('Promise.allSettled([spherePeople')
    expect(data).toContain("sphereRequest('conversation', { conversationId })")
    expect(page).toContain('sphere-mention--self')
  })

  it('keeps profile photos private while allowing security-complete SygSphere accounts to render fallbacks', () => {
    expect(migration).toContain('public.sygsphere_can_read_avatar(name)')
    expect(migration).toContain("session_context->>'must_change_password'")
    expect(migration).toContain("session_context->>'mfa_required'")
    expect(data).toContain("storage.from('employee-photos').download(photoPath)")
    expect(page).toContain('url ? <img')
  })

  it('previews only approved image, PDF, and bounded plain-text content behind membership authorization', () => {
    expect(files).toContain("dependencies.authorize('access'")
    expect(files).toContain("url.searchParams.get('mode') === 'preview'")
    expect(files).toContain("'content-security-policy': \"sandbox; default-src 'none'")
    expect(files).toContain("'cross-origin-resource-policy': 'same-origin'")
    expect(data).toContain("file.mimeType === 'text/plain' && file.sizeBytes <= 1048576")
  })

  it('keeps inline and HR limits intact while larger images use a bounded resumable quarantine path', () => {
    expect(migration).toContain('enabled boolean not null default true')
    expect(migration).toContain('inline_max_bytes integer not null default 26214400 check (inline_max_bytes = 26214400)')
    expect(migration).toContain('Larger resumable SygSphere uploads are not enabled.')
    expect(migration).toContain("lower(trim(coalesce(input->>'mimeType',''))) not in ('image/jpeg','image/png','image/webp')")
    expect(migration).toContain('service_claim_sygsphere_resumable_scan')
    expect(migration).toContain('target_lease_id uuid')
    expect(migration).toContain('service_list_sygsphere_resumable_purge')
    expect(data).toContain('sphereResumableMaxBytes = 104857600')
    expect(data).toContain('new Upload(file')
    expect(data).toContain('fingerprint: async () => `sygsphere:')
    expect(files).toContain('const limit = 26214400')
    expect(worker).toContain("message.body?.kind === 'sygsphere'")
    expect(worker).toContain('stored.body.pipeThrough(integrityStream)')
    expect(worker).not.toContain('stored.body.tee()')
  })
})
