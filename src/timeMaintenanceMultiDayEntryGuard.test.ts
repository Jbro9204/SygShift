/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const timePage = readFileSync(join(process.cwd(), 'src', 'pages', 'TimePage.tsx'), 'utf8')

describe('Time Maintenance multi-day entry workflow', () => {
  it('lets the operator change workday without closing the employee timecard', () => {
    expect(timePage).toContain('aria-label="Previous workday"')
    expect(timePage).toContain('aria-label="Next workday"')
    expect(timePage).toContain('onChange={(event) => chooseAddWorkday(event.target.value)}')
    expect(timePage).not.toContain('disabled={Boolean(addShiftId)}')
  })

  it('clears stale occurrence state and synchronizes the next punch date', () => {
    expect(timePage).toContain('setAddOperationalDate(nextWorkday)')
    expect(timePage).toContain('setAddDate(nextWorkday)')
    expect(timePage).toContain('setAddShiftId(null)')
    expect(timePage).toContain('setAddLocationPostId(null)')
    expect(timePage).toContain('addMutation.reset()')
    expect(timePage).toContain('Add next workday')
  })

  it('retains the separate overnight punch-date recommendation', () => {
    expect(timePage).toContain('recommendedManualPunchTimestamp(selectedShift, addKind)')
    expect(timePage).toContain('For an overnight shift, use the date the shift starts.')
  })
})
