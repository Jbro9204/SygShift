/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const originalRoleMigration = readFileSync(join(root, 'supabase', 'migrations', '20260901150000_human_resources_role.sql'), 'utf8')
const splitMigration = readFileSync(join(root, 'supabase', 'migrations', '20260902070000_human_resources_employee_role_split.sql'), 'utf8')

function approvedPermissions(source: string): string[] {
  const block = source.match(/approved_permissions constant text\[\] := array\[(.*?)\]\s*::text\[\]/s)?.[1] ?? ''
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1])
}

describe('Human Resources role split guardrails', () => {
  it('recreates the exact original ordinary HR bundle as Human Resources Employee', () => {
    expect(splitMigration).toContain("'human_resources_employee'")
    expect(splitMigration).toContain("'Human Resources Employee'")
    expect(approvedPermissions(splitMigration)).toEqual(approvedPermissions(originalRoleMigration))
    expect(approvedPermissions(splitMigration)).toHaveLength(78)
  })

  it('preserves the Manager role while restoring only the one prior assignment', () => {
    expect(splitMigration).toContain('Expected exactly one prior Human Resources assignment to restore')
    expect(splitMigration).toContain('Human Resources Employee split changed the Manager role definition')
    expect(splitMigration).toContain('Human Resources Employee split changed the Manager permission bundle')
    expect(splitMigration).toContain('Human Resources Manager must remain separately assignable')
    expect(splitMigration).toContain('did not preserve the prior assignment metadata')
  })

  it('preserves other access and writes a system audit record for the correction', () => {
    expect(splitMigration).toContain('changed another role definition')
    expect(splitMigration).toContain('changed another role permission bundle')
    expect(splitMigration).toContain('changed an unrelated employee role assignment')
    expect(splitMigration).toContain('changed an individual permission override')
    expect(splitMigration).toContain("insert into private.audit_events")
    expect(splitMigration).toContain('Restored the original ordinary HR boundary')
  })
})
