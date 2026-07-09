import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const appRoleSchema = z.enum(['guard', 'dispatcher', 'scheduler', 'supervisor', 'admin'])

export type AppRole = z.infer<typeof appRoleSchema>

export async function getCurrentAppRole(): Promise<AppRole | null> {
  const { data, error } = await getSupabaseClient().rpc('current_app_role')
  if (error) throw new Error('Your application role could not be verified.')
  return appRoleSchema.nullable().parse(data)
}
