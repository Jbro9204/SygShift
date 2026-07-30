/// <reference types="node" />

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const schedulePage = readFileSync(join(root, 'src', 'pages', 'SchedulePage.tsx'), 'utf8')

describe('scheduler behavior guardrails', () => {
  it('closes the assignment modal after Save assignment succeeds', () => {
    expect(schedulePage).toContain('function closePlannerAssignmentAfterSave()')
    expect(schedulePage).toContain('setSelectedPlannerShiftId(null)')
    expect(schedulePage).toContain('Assignment saved. Publish the draft when the week is ready.')

    const directDraftSave = /draftShiftMutationInput\(shift, employeeId, availabilityOverrideNote, credentialOverrideNote\),\s*\{\s*onSuccess: closePlannerAssignmentAfterSave\s*\}/
    const openedDraftSave = /draftShiftMutationInput\(copiedShift, employeeId, availabilityOverrideNote, credentialOverrideNote\),\s*\{\s*onSuccess: closePlannerAssignmentAfterSave\s*\}/

    expect(schedulePage).toMatch(directDraftSave)
    expect(schedulePage).toMatch(openedDraftSave)
  })

  it('uses draft-safe language when adding shifts from the scheduler', () => {
    expect(schedulePage).toContain("'Saving draft...'")
    expect(schedulePage).toContain('Save ${openShiftDateKeys.length === 1 ? \'draft shift\'')
    expect(schedulePage).toContain('Save ${openShiftDateKeys.length === 1 ? \'open draft shift\'')
    expect(schedulePage).toContain('assigned draft shift${createdCount === 1 ? \'\' : \'s\'} saved')
    expect(schedulePage).toContain('open draft shift${createdCount === 1 ? \'\' : \'s\'} saved')

    const addShiftButtonBlock = /createOpenShiftMutation\.isPending[\s\S]+?<\/button>/.exec(schedulePage)?.[0] ?? ''
    expect(addShiftButtonBlock).not.toContain('Publishing...')
    expect(addShiftButtonBlock).not.toContain('Publish ${openShiftDateKeys.length === 1 ? \'assigned shift\'')
    expect(addShiftButtonBlock).not.toContain('Publish ${openShiftDateKeys.length === 1 ? \'open shift\'')
  })
})
