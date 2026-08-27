import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const appRoleSchema = z.enum(['guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin'])
const permissionRiskSchema = z.enum(['standard', 'sensitive', 'critical'])
const overrideEffectSchema = z.enum(['grant', 'deny'])

export const permissionSchema = z.object({
  code: z.string(),
  category: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  riskLevel: permissionRiskSchema,
  requiresMfa: z.boolean(),
  locked: z.boolean(),
  active: z.boolean(),
})

export const accessRoleSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  baseAppRole: appRoleSchema.nullable(),
  systemRole: z.boolean(),
  protected: z.boolean(),
  mfaRequired: z.boolean(),
  active: z.boolean(),
  permissionCodes: z.array(z.string()),
  assignedCount: z.number(),
})

export const userOverrideSchema = z.object({
  id: z.string().uuid(),
  permissionCode: z.string(),
  effect: overrideEffectSchema,
  reason: z.string(),
  createdAt: z.string(),
})

export const accessControlUserSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  username: z.string().nullable(),
  primaryRole: appRoleSchema,
  jobTitle: z.string().nullable(),
  status: z.string(),
  assignedRoleIds: z.array(z.string().uuid()),
  overrides: z.array(userOverrideSchema),
  effectivePermissionCodes: z.array(z.string()),
})

const accessControlCenterSchema = z.object({
  generatedAt: z.string(),
  permissions: z.array(permissionSchema),
  roles: z.array(accessRoleSchema),
  users: z.array(accessControlUserSchema),
})

export type PermissionRisk = z.infer<typeof permissionRiskSchema>
export type PermissionDefinition = z.infer<typeof permissionSchema>
export type AccessRoleDefinition = z.infer<typeof accessRoleSchema>
export type AccessControlUser = z.infer<typeof accessControlUserSchema>
export type UserPermissionOverride = z.infer<typeof userOverrideSchema>
export type AccessControlCenter = z.infer<typeof accessControlCenterSchema>
export type OverrideEffect = z.infer<typeof overrideEffectSchema>

function parseCenter(payload: unknown): AccessControlCenter {
  return accessControlCenterSchema.parse(payload)
}

export async function getAccessControlCenter(): Promise<AccessControlCenter> {
  const { data, error } = await getSupabaseClient().rpc('get_access_control_center')
  if (error) throw new Error(error.message || 'Roles and permissions could not be loaded.')
  return parseCenter(data)
}

export async function upsertAccessRole(input: {
  roleId?: string | null
  name: string
  description?: string | null
  mfaRequired: boolean
  active?: boolean
}): Promise<AccessControlCenter> {
  const { data, error } = await getSupabaseClient().rpc('upsert_access_role', {
    target_active: input.active ?? true,
    target_description: input.description ?? null,
    target_mfa_required: input.mfaRequired,
    target_name: input.name,
    target_role_id: input.roleId ?? null,
  })
  if (error) throw new Error(error.message || 'The role could not be saved.')
  return parseCenter(data)
}

export async function setAccessRolePermissions(roleId: string, permissionCodes: string[]): Promise<AccessControlCenter> {
  const { data, error } = await getSupabaseClient().rpc('set_access_role_permissions', {
    target_permission_codes: permissionCodes,
    target_role_id: roleId,
  })
  if (error) throw new Error(error.message || 'Role permissions could not be saved.')
  return parseCenter(data)
}

export async function setEmployeeAccessRoles(employeeId: string, roleIds: string[]): Promise<AccessControlCenter> {
  const { data, error } = await getSupabaseClient().rpc('set_employee_access_roles', {
    target_employee_id: employeeId,
    target_role_ids: roleIds,
  })
  if (error) throw new Error(error.message || 'Employee role assignments could not be saved.')
  return parseCenter(data)
}

export async function setEmployeeAccessProfile(input: {
  employeeId: string
  roleIds: string[]
  permissionCodes: string[]
  reason: string
}): Promise<AccessControlCenter> {
  const { data, error } = await getSupabaseClient().rpc('set_employee_access_profile', {
    target_employee_id: input.employeeId,
    target_permission_codes: input.permissionCodes,
    target_reason: input.reason,
    target_role_ids: input.roleIds,
  })
  if (error) throw new Error(error.message || 'Employee access could not be saved.')
  return parseCenter(data)
}

export async function setEmployeePermissionOverride(input: {
  employeeId: string
  permissionCode: string
  effect: OverrideEffect
  reason: string
}): Promise<AccessControlCenter> {
  const { data, error } = await getSupabaseClient().rpc('set_employee_permission_override', {
    target_effect: input.effect,
    target_employee_id: input.employeeId,
    target_permission_code: input.permissionCode,
    target_reason: input.reason,
  })
  if (error) throw new Error(error.message || 'Employee permission override could not be saved.')
  return parseCenter(data)
}

export async function clearEmployeePermissionOverride(overrideId: string): Promise<AccessControlCenter> {
  const { data, error } = await getSupabaseClient().rpc('clear_employee_permission_override', {
    target_override_id: overrideId,
  })
  if (error) throw new Error(error.message || 'Employee permission override could not be removed.')
  return parseCenter(data)
}
