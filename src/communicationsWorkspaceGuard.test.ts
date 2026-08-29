import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('Communication workspace guardrails', () => {
  it('keeps every operational communication list bounded and paginated', () => {
    const announcements = read('src/pages/AnnouncementsPage.tsx')
    const notifications = read('src/pages/NotificationsPage.tsx')
    const migration = read('supabase/migrations/20260829120000_communications_workspaces.sql')

    expect(announcements).toContain('const pageSizeOptions = [5, 10, 20] as const')
    expect(announcements).toContain("useState<5 | 10 | 20>(5)")
    expect(announcements).toContain("useState<5 | 10 | 20>(10)")
    expect(announcements).toContain('.slice(0, 5)')
    expect(notifications).toContain("useState<5 | 10 | 20>(10)")
    expect(notifications).toContain('<option value={5}>5</option>')
    expect(migration).toContain('least(greatest(coalesce(target_page_size,10),5),20)')
    expect(migration).toContain('limit clean_size offset (clean_page-1)*clean_size')
  })

  it('groups delivery operations by communication job instead of recipient', () => {
    const migration = read('supabase/migrations/20260829120000_communications_workspaces.sql')

    expect(migration).toContain('group by outbox.aggregate_type, outbox.aggregate_id, outbox.message_type')
    expect(migration).toContain('private.announcement_recipient_snapshots')
    expect(migration).toContain("count(*) filter (where status = 'queued')")
    expect(migration).toContain("count(*) filter (where status = 'failed')")
    expect(migration).toContain('public.retry_notification_job')
    expect(migration).toContain('public.retry_all_failed_notifications')
  })

  it('publishes scheduled work through the protected server workflow', () => {
    const migration = read('supabase/migrations/20260829120000_communications_workspaces.sql')
    const worker = read('worker/index.ts')

    expect(migration).toContain('public.service_publish_due_announcement_work_items')
    expect(migration).toContain('public.publish_announcement_work_item')
    expect(migration).toContain('public.preview_announcement_work_item')
    expect(worker).toContain('service_publish_due_announcement_work_items')
    expect(worker).toContain('service_get_announcement_email_recipients')
  })

  it('keeps banner-alert expiration authoritative and lifecycle changes auditable', () => {
    const announcements = read('src/pages/AnnouncementsPage.tsx')
    const data = read('src/data/announcements.ts')
    const migration = read('supabase/migrations/20260829150000_banner_alert_lifecycle_controls.sql')

    expect(migration).toContain("when banner.expires_at is not null and banner.expires_at <= clock_timestamp() then 'expired'")
    expect(migration).toContain('candidate.expires_at is null or candidate.expires_at > clock_timestamp()')
    expect(migration).toContain('public.change_announcement_banner_lifecycle')
    expect(migration).toContain("clean_action not in ('cancel', 'delete')")
    expect(migration).toContain('for each row execute function private.write_audit_event()')
    expect(data).toContain("z.enum(['active', 'scheduled', 'expired', 'canceled', 'inactive', 'deleted'])")
    expect(announcements).toContain('Past & canceled alerts')
    expect(announcements).toContain("slice(0, showArchivedBanners ? 10 : 5)")
    expect(announcements).toContain('Cancel banner alert?')
    expect(announcements).toContain('Delete banner alert?')
  })
})
