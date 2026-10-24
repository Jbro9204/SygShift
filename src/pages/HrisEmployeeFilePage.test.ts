import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  authorizedEmployeeProfileEditor,
  canManageSupervisorAssignment,
  supervisorAssignmentLabel,
} from './hrisEmployeeFileState'

const employeeFilePage = readFileSync('src/pages/HrisEmployeeFilePage.tsx', 'utf8')

describe('employee supervision truthfulness', () => {
  it('distinguishes a failed lookup from a verified unassigned employee', () => {
    expect(supervisorAssignmentLabel({ error: true, pending: false })).toBe('Unavailable — retry below')
    expect(supervisorAssignmentLabel({ error: false, pending: false })).toBe('Unassigned')
    expect(supervisorAssignmentLabel({ error: false, name: 'Michael Hinz', pending: false })).toBe('Michael Hinz')
  })

  it('removes supervisor-management authority while verification is pending or failed', () => {
    expect(canManageSupervisorAssignment({ canManage: true, error: false, pending: false })).toBe(true)
    expect(canManageSupervisorAssignment({ canManage: true, error: true, pending: false })).toBe(false)
    expect(canManageSupervisorAssignment({ canManage: true, error: false, pending: true })).toBe(false)
    expect(canManageSupervisorAssignment({ canManage: false, error: false, pending: false })).toBe(false)
  })

  it('withholds cached protected data and actions when their verification refresh fails', () => {
    expect(employeeFilePage).toContain('const record = verifiedQueryData(recordQuery.data, recordQuery)')
    expect(employeeFilePage).toContain('const editorContext = verifiedQueryData(editorContextQuery.data, editorContextQuery)')
    expect(employeeFilePage).toContain('const employmentDateHistory = verifiedQueryData(employmentDateHistoryQuery.data, employmentDateHistoryQuery)')
    expect(employeeFilePage).toContain('const session = verifiedQueryData(sessionQuery.data, sessionQuery)')
    expect(employeeFilePage).not.toContain('const record = recordQuery.data')
    expect(employeeFilePage).not.toContain('const editorContext = editorContextQuery.data')
    expect(employeeFilePage).not.toContain('sessionQuery.data?.employeeId')
    expect(employeeFilePage).not.toContain('employmentDateHistoryQuery.data?.canManage')
  })

  it('closes protected dialogs and gates every modal on currently verified authority', () => {
    expect(employeeFilePage).toContain('if (profileEditor !== authorizedProfileEditor) setProfileEditor(authorizedProfileEditor)')
    expect(employeeFilePage).toContain('setEmploymentDateEditorOpen(false)')
    expect(employeeFilePage).toContain('if (!record || !canManageSupervisor) setSupervisorEditorOpen(false)')
    expect(employeeFilePage).toContain("authorizedProfileEditor === 'identity' && editorContext?.canManageProfile")
    expect(employeeFilePage).toContain("authorizedProfileEditor === 'employment' && editorContext?.canManageProfile")
    expect(employeeFilePage).toContain("authorizedProfileEditor === 'contacts' && editorContext?.canManageRestricted")
    expect(employeeFilePage).toContain('employmentDateEditorOpen && employmentDateHistory?.canManage')
    expect(employeeFilePage).toContain('supervisorEditorOpen && canManageSupervisor && supervision')
  })

  it('purges an open profile editor when its refreshed capability is revoked', () => {
    const fullAuthority = { canManageProfile: true, canManageRestricted: true, hasRecord: true }

    expect(authorizedEmployeeProfileEditor('identity', fullAuthority)).toBe('identity')
    expect(authorizedEmployeeProfileEditor('employment', fullAuthority)).toBe('employment')
    expect(authorizedEmployeeProfileEditor('contacts', fullAuthority)).toBe('contacts')

    expect(authorizedEmployeeProfileEditor('identity', { ...fullAuthority, canManageProfile: false })).toBeNull()
    expect(authorizedEmployeeProfileEditor('employment', { ...fullAuthority, canManageProfile: false })).toBeNull()
    expect(authorizedEmployeeProfileEditor('contacts', { ...fullAuthority, canManageRestricted: false })).toBeNull()
  })

  it('does not let another capability keep the wrong editor alive', () => {
    expect(authorizedEmployeeProfileEditor('employment', {
      canManageProfile: false,
      canManageRestricted: true,
      hasRecord: true,
    })).toBeNull()
    expect(authorizedEmployeeProfileEditor('contacts', {
      canManageProfile: true,
      canManageRestricted: false,
      hasRecord: true,
    })).toBeNull()
    expect(authorizedEmployeeProfileEditor('contacts', {
      canManageProfile: true,
      canManageRestricted: true,
      hasRecord: false,
    })).toBeNull()
  })
})
