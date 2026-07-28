/// <reference types="node" />

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationSource = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260727203000_access_control_center.sql'),
  'utf8',
)

const repairMigrationSource = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260728194000_access_role_permission_guard_repair.sql'),
  'utf8',
)

describe('access control database guardrails', () => {
  it('only applies protected Admin safety locks to the actual Admin system role', () => {
    for (const source of [migrationSource, repairMigrationSource]) {
      expect(source).toContain("target_role.code = 'system_admin'")
      expect(source).toContain('Protected Admin permissions cannot be removed.')
      expect(source).not.toContain('if target_role.protected and (\n')
    }
  })
})
