/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { patrolEvidenceSignatureMatches } from '../worker/index'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260902110000_enterprise_patrol_operations.sql'), 'utf8')
const adminMfaBoundary = readFileSync(join(root, 'supabase', 'migrations', '20260902120000_patrol_admin_mfa_boundary.sql'), 'utf8')
const makeupAndReporting = readFileSync(join(root, 'supabase', 'migrations', '20260902130000_patrol_makeup_and_complete_reporting.sql'), 'utf8')
const evidenceBinding = readFileSync(join(root, 'supabase', 'migrations', '20260902140000_patrol_evidence_completion_binding.sql'), 'utf8')
const routeUpdatePersistence = readFileSync(join(root, 'supabase', 'migrations', '20260902214839_patrol_route_update_persistence.sql'), 'utf8')
const page = readFileSync(join(root, 'src', 'pages', 'PatrolPage.tsx'), 'utf8')
const data = readFileSync(join(root, 'src', 'data', 'patrol.ts'), 'utf8')
const report = readFileSync(join(root, 'src', 'reports', 'PatrolActivityReportWorkspace.tsx'), 'utf8')
const reportExport = readFileSync(join(root, 'src', 'reports', 'patrolReportExport.ts'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')

describe('enterprise Patrol operations', () => {
  it('uses versioned routes, schedule-linked assignments, immutable obligations, hits, makeup, and private evidence', () => {
    for (const table of [
      'patrol_routes', 'patrol_route_versions', 'patrol_route_stops', 'patrol_stop_requirements',
      'patrol_assignments', 'patrol_hit_obligations', 'patrol_makeup_assignments', 'patrol_hits', 'patrol_hit_evidence',
    ]) expect(migration).toContain(`create table public.${table}`)
    expect(migration).toContain("join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'")
    expect(migration).toContain("classification in ('required', 'makeup', 'extra')")
    expect(migration).toContain("public = false")
  })

  it('seeds the approved spreadsheet as drafts without inventing addresses or time windows', () => {
    for (const location of ['Stone Cliff Apts', 'Malbec', 'Neon Local', 'Bear Valley Park', 'Elm Grove', 'Syracuse', 'Cherry Tree', 'Hestia', 'Parc at CC', 'Anythink', 'PERA-W']) {
      expect(migration).toContain(location)
    }
    expect(migration).toContain("'draft', 'America/Denver'")
    expect(migration).toContain("'Elm Grove', d.day_of_week, 'Night patrol', 3, 'paused'")
    expect(migration).toContain("'Anythink', 1, 'Day shift', 2, 'active'")
  })

  it('keeps guard actions narrow and management/reporting permissions independently enforced', () => {
    expect(migration).toContain("'patrol.self.view'")
    expect(migration).toContain("'patrol.hits.complete'")
    expect(migration).toContain("'patrol.evidence.upload'")
    expect(migration).toContain("'patrol.routes.manage'")
    expect(migration).toContain("'patrol.reports.export'")
    expect(migration).toContain("public.has_effective_permission('patrol.assignments.manage')")
    expect(migration).toContain("public.has_effective_permission('patrol.exceptions.manage')")
    expect(adminMfaBoundary).toContain("public.has_effective_permission('patrol.manage')")
    expect(adminMfaBoundary).toContain("public.has_effective_permission('patrol.routes.manage')")
    expect(adminMfaBoundary).not.toContain('public.is_admin()')
  })

  it('requires meaningful notes, separates extra hits, and verifies configured locations on the server', () => {
    expect(migration).toContain('private.patrol_note_is_meaningful')
    expect(migration).toContain("classification = 'extra'")
    expect(migration).toContain("resolved_location_status := case when distance_meters")
    expect(migration).toContain("'outside_geofence'")
    expect(page).toContain('Meaningful notes are required for every hit.')
    expect(page).toContain('Record extra hit')
    expect(page).toContain('Location verification not configured')
  })

  it('uses private resumable media with signature checks and audited view/download access', () => {
    expect(data).toContain('new Upload(file')
    expect(data).toContain("chunkSize: 6 * 1024 * 1024")
    expect(data).toContain("'x-signature': target.signedUploadToken")
    expect(worker).toContain('createPrivateSignedUpload')
    expect(worker).toContain('patrolEvidenceSignatureMatches')
    expect(worker).toContain('service_get_patrol_evidence_access')
    expect(worker).toContain('service_get_patrol_evidence_upload_target')
    expect(evidenceBinding).toContain("evidence_record.uploaded_by <> target_actor_id")
    expect(evidenceBinding).toContain("status in ('pending_upload', 'stored')")
    expect(migration).toContain("'preview', 'download'")
    expect(page).toContain('Recent protected evidence')
  })

  it('keeps operational lists compact and provides complete Patrol reports', () => {
    expect(page).toContain('const pageSizes = [5, 10, 20] as const')
    expect(page).toContain('Routes & Requirements')
    expect(page).toContain('Connect route to published shift')
    expect(report).toContain('const pageSizes = [5, 10, 20] as const')
    expect(report).toContain('Internal detail')
    expect(report).toContain('Client-ready')
    expect(reportExport).toContain('downloadPatrolCsv')
    expect(reportExport).toContain('downloadPatrolXlsx')
    expect(reportExport).toContain('downloadPatrolPdf')
    expect(makeupAndReporting).toContain('get_patrol_makeup_work')
    expect(makeupAndReporting).toContain('get_patrol_report_supplement')
    expect(page).toContain('Complete makeup')
    expect(reportExport).toContain('Activity Type')
  })

  it('versions existing routes without confusing the route variable with the route-version column', () => {
    expect(routeUpdatePersistence).toContain('from public.patrol_route_versions route_version')
    expect(routeUpdatePersistence).toContain('where route_version.route_id = resolved_route_id')
    expect(routeUpdatePersistence).toContain("stop_payload ->> 'addressLine1'")
    expect(routeUpdatePersistence).not.toContain('from public.patrol_route_versions where route_id = save_patrol_route.route_id')
  })
})

describe('patrol evidence file signatures', () => {
  it('recognizes approved image and video containers', () => {
    expect(patrolEvidenceSignatureMatches(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg')).toBe(true)
    expect(patrolEvidenceSignatureMatches(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png')).toBe(true)
    expect(patrolEvidenceSignatureMatches(new TextEncoder().encode('RIFF0000WEBP'), 'image/webp')).toBe(true)
    expect(patrolEvidenceSignatureMatches(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 'video/webm')).toBe(true)
    expect(patrolEvidenceSignatureMatches(new TextEncoder().encode('0000ftypisom'), 'video/mp4')).toBe(true)
  })

  it('rejects mismatched and executable content', () => {
    const executable = new TextEncoder().encode('MZThis is not patrol media')
    expect(patrolEvidenceSignatureMatches(executable, 'image/jpeg')).toBe(false)
    expect(patrolEvidenceSignatureMatches(executable, 'video/mp4')).toBe(false)
    expect(patrolEvidenceSignatureMatches(new TextEncoder().encode('RIFF0000FAIL'), 'image/webp')).toBe(false)
  })
})
