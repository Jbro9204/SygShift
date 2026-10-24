export function supervisorAssignmentLabel(input: { error: boolean; name?: string | null; pending: boolean }): string {
  if (input.pending) return 'Loading…'
  if (input.error) return 'Unavailable — retry below'
  return input.name ?? 'Unassigned'
}

export function canManageSupervisorAssignment(input: { canManage?: boolean; error: boolean; pending: boolean }): boolean {
  return !input.error && !input.pending && input.canManage === true
}

export type HrisEmployeeProfileEditor = 'identity' | 'employment' | 'contacts'

export function authorizedEmployeeProfileEditor(
  editor: HrisEmployeeProfileEditor | null,
  authority: {
    canManageProfile: boolean
    canManageRestricted: boolean
    hasRecord: boolean
  },
): HrisEmployeeProfileEditor | null {
  if (!editor || !authority.hasRecord) return null
  if (editor === 'contacts') return authority.canManageRestricted ? editor : null
  return authority.canManageProfile ? editor : null
}
