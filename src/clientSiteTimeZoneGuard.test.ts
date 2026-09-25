import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const clientFilesPage = readFileSync(join(root, 'src', 'pages', 'ClientFilesPage.tsx'), 'utf8')
const sitesPage = readFileSync(join(root, 'src', 'pages', 'SitesPage.tsx'), 'utf8')
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260925190311_enforce_client_site_time_zones.sql'),
  'utf8',
)
const regression = readFileSync(
  join(root, 'supabase', 'tests', 'client_site_time_zone_contract_regression.sql'),
  'utf8',
)

describe('Client and Site schedule-authority time-zone guard', () => {
  it('bounds lock waits for the complete atomic migration', () => {
    expect(migration).toMatch(/^begin;\r?\nset local lock_timeout = '5s';/)
    expect((migration.match(/^begin;$/gm) ?? [])).toHaveLength(1)
    expect((migration.match(/^commit;$/gm) ?? [])).toHaveLength(1)
  })

  it('uses the one supported selector catalog on every Client and Site editor', () => {
    expect(clientFilesPage).toContain("import { continentalUsTimeZones } from '../lib/usTimeZones'")
    expect(sitesPage).toContain("import { continentalUsTimeZones } from '../lib/usTimeZones'")
    expect(clientFilesPage).not.toContain('const timeZones =')
    expect(sitesPage).not.toMatch(/name="timeZone"\s+required\s+\/>/)
    expect(clientFilesPage.match(/continentalUsTimeZones\.map/g)).toHaveLength(3)
    expect(sitesPage).toContain('continentalUsTimeZones.map')
  })

  it('enforces the same five-zone contract at the database and protected mutation boundary', () => {
    for (const timeZone of [
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Phoenix',
      'America/Los_Angeles',
    ]) {
      expect(migration).toContain(timeZone)
    }
    expect(migration).toContain('clients_time_zone_check')
    expect(migration).toContain('sites_supported_us_time_zone')
    expect(migration).toContain('create or replace function public.update_client_site_location')
    expect(migration).toContain("raise check_violation using message = 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.'")
    expect(migration).toContain("'timeZone', normalized_time_zone")
    expect(migration).toContain('from public, anon')
    expect(regression).toContain("set time_zone = 'America/Phoenix'")
    expect(regression).toContain('The Client constraint did not accept Arizona Time.')
  })
})
