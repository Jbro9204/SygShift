import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const workerSource = readFileSync(join(process.cwd(), 'worker', 'index.ts'), 'utf8')
const userAdminSource = readFileSync(join(process.cwd(), 'src', 'pages', 'UserAdminPage.tsx'), 'utf8')
const migrationSource = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260823193000_jordan_brown_title_update.sql'),
  'utf8',
)

describe('Jordan Brown professional title', () => {
  it('uses the current title in active email and administration surfaces', () => {
    expect(workerSource).toContain('IT and Business Development Engineer')
    expect(workerSource).not.toContain('Chief Systems and Automation Officer')
    expect(userAdminSource).toContain('IT and Business Development Engineer')
    expect(userAdminSource).not.toContain('CS&AO')
  })

  it('keeps the production employee and stored welcome template aligned', () => {
    expect(migrationSource).toContain("job_title = 'IT and Business Development Engineer'")
    expect(migrationSource).toMatch(
      /replace\(\s*body_pattern,\s*'Chief Systems and Automation Officer',\s*'IT and Business Development Engineer'\s*\)/,
    )
  })
})
