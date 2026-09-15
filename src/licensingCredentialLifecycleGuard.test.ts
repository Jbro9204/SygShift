import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const page = readFileSync(join(root, 'src', 'pages', 'LicensingCenterPage.tsx'), 'utf8')
const data = readFileSync(join(root, 'src', 'data', 'licensing.ts'), 'utf8')
const styles = readFileSync(join(root, 'src', 'App.css'), 'utf8')
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260915151039_licensing_credential_archive_restore.sql'),
  'utf8',
)

describe('Licensing credential archive and restore lifecycle', () => {
  it('uses recoverable removal with a required reason and plain confirmation', () => {
    expect(page).toContain('Remove credential from profile?')
    expect(page).toContain('This does not delete the record.')
    expect(page).toContain('Why are you removing it?')
    expect(page).toContain("{ value: 'wrong_employee', label: 'Added to the wrong employee' }")
    expect(page).toContain("{ value: 'duplicate', label: 'Duplicate credential' }")
    expect(page).toContain("{ value: 'entered_by_mistake', label: 'Entered by mistake' }")
    expect(page).toContain("{ value: 'no_longer_applicable', label: 'No longer applicable' }")
    expect(page).toContain("reasonCode === 'other' && reasonDetails.trim().length < 5")
  })

  it('keeps removed records discoverable and restorable from the employee profile', () => {
    expect(page).toContain('<summary>Removed credentials <span>{removedCredentials.length}</span></summary>')
    expect(page).toContain('removedCredential.documentCount')
    expect(page).toContain('restoreLicensingCredential')
    expect(page).toContain('A current credential of this type is already on the profile')
    expect(data).toContain("client.rpc('get_removed_licensing_credentials')")
    expect(data).toContain("rpc('archive_licensing_credential'")
    expect(data).toContain("rpc('restore_licensing_credential'")
  })

  it('keeps the lifecycle permission-enforced and audited in the database', () => {
    expect(migration).toContain('actor_id := private.require_credential_editor_mfa();')
    expect(migration).toContain("'LICENSING_CREDENTIAL_ARCHIVED'")
    expect(migration).toContain("'LICENSING_CREDENTIAL_RESTORED'")
    expect(migration).toContain('old_record')
    expect(migration).toContain('new_record')
    expect(migration).toContain("revoke all on function public.archive_licensing_credential(uuid, uuid, text, text) from public, anon, authenticated")
    expect(migration).toContain("grant execute on function public.archive_licensing_credential(uuid, uuid, text, text) to authenticated")
    expect(migration).toContain("set search_path = ''")
    expect(migration).not.toContain('delete from public.employee_credentials')
  })

  it('has dedicated professional and responsive presentation rules', () => {
    expect(styles).toContain('.licensing-credential-removal-summary')
    expect(styles).toContain('.licensing-removed-credentials__list article')
    expect(styles).toContain('.licensing-credential-edit-actions')
    expect(styles).toContain('@media (max-width: 680px)')
  })
})
