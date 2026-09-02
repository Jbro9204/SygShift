import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const supervisorOptionSchema = z.object({
  employeeId: z.string().uuid(),
  name: z.string(),
  employeeNumber: z.string().nullable(),
  jobTitle: z.string().nullable(),
})

const supervisorAssignmentSchema = z.object({
  employeeId: z.string().uuid(),
  supervisorEmployeeId: z.string().uuid(),
  supervisorName: z.string(),
  assignedAt: z.string(),
})

const supervisionWorkspaceSchema = z.object({
  viewerEmployeeId: z.string().uuid(),
  defaultScope: z.enum(['mine', 'all']),
  canManage: z.boolean(),
  assignments: z.array(supervisorAssignmentSchema),
  supervisors: z.array(supervisorOptionSchema),
})

export type SupervisorOption = z.infer<typeof supervisorOptionSchema>
export type SupervisorAssignment = z.infer<typeof supervisorAssignmentSchema>
export type SupervisionWorkspace = z.infer<typeof supervisionWorkspaceSchema>

export async function getSupervisionWorkspace(): Promise<SupervisionWorkspace> {
  const { data, error } = await getSupabaseClient().rpc('get_supervision_workspace')
  if (error) throw new Error(error.message || 'Supervisor assignments could not be loaded.')
  return supervisionWorkspaceSchema.parse(data)
}

export async function updateSupervisorAssignment(input: {
  employeeId: string
  supervisorEmployeeId: string | null
  reason: string
}): Promise<SupervisionWorkspace> {
  const { data, error } = await getSupabaseClient().rpc('update_employee_supervisor_assignment', {
    target_employee_id: input.employeeId,
    target_reason: input.reason.trim(),
    target_supervisor_employee_id: input.supervisorEmployeeId,
  })
  if (error) throw new Error(error.message || 'The supervisor assignment could not be updated.')
  return supervisionWorkspaceSchema.parse(data)
}

export async function recordSupervisionExceptionAccess(employeeId: string, source: string): Promise<boolean> {
  const { data, error } = await getSupabaseClient().rpc('record_supervision_exception_access', {
    target_employee_id: employeeId,
    target_source: source,
  })
  if (error) throw new Error(error.message || 'The workforce access audit could not be recorded.')
  return z.boolean().parse(data)
}
