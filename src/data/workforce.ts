import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const credentialSchema = z.object({
  kind: z.enum([
    'guard_license',
    'armed_guard',
    'driver_license',
    'first_aid_cpr',
    'site_training',
    'other',
  ]),
  status: z.enum(['pending', 'active', 'expired', 'suspended', 'revoked']),
  credential_number: z.string().nullable(),
  valid_from: z.string().nullable(),
  expires_on: z.string().nullable(),
  notes: z.string().nullable(),
})

const operationalProfileSchema = z.object({
  sourceDisplayName: z.string().nullable(),
  locationText: z.string().nullable(),
  scheduleAvailability: z.string().nullable(),
  employeeDg: z.string().nullable(),
  expectedHoursText: z.string().nullable(),
  sourceNotes: z.string().nullable(),
  supervisorLabel: z.string().nullable(),
  armedSourceClaim: z.boolean(),
})

const directoryEntrySchema = z.object({
  id: z.string().uuid(),
  employee_number: z.string().nullable(),
  job_title: z.string().nullable(),
  username: z.string(),
  first_name: z.string(),
  middle_name: z.string().nullable(),
  last_name: z.string(),
  preferred_name: z.string().nullable(),
  role: z.enum(['guard', 'dispatcher', 'scheduler', 'supervisor', 'admin']),
  employment_type: z.enum(['hourly', 'salary']),
  status: z.enum(['active', 'leave', 'inactive', 'separated']),
  photo_path: z.string().nullable(),
  hired_on: z.string().nullable(),
  personal_email: z.string().nullable(),
  company_email: z.string().nullable(),
  mobile_phone: z.string().nullable(),
  credentials: z.array(credentialSchema),
  operational_profile: operationalProfileSchema.nullable(),
})

const postSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  requires_armed: z.boolean(),
  active: z.boolean(),
  default_start_time: z.string().nullable(),
  default_end_time: z.string().nullable(),
})

const siteSchema = z.object({
  id: z.string().uuid(),
  code: z.string().nullable(),
  name: z.string(),
  address_line_1: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postal_code: z.string().nullable(),
  time_zone: z.string(),
  active: z.boolean(),
  posts: z.array(postSchema),
})

export type DirectoryEntry = z.infer<typeof directoryEntrySchema>
export type Site = z.infer<typeof siteSchema>

export function parseDirectoryEntries(value: unknown): DirectoryEntry[] {
  return z.array(directoryEntrySchema).parse(value)
}

export async function getEmployeeDirectory(): Promise<DirectoryEntry[]> {
  const { data, error } = await getSupabaseClient().rpc('get_employee_directory')
  if (error) throw new Error('The employee directory could not be loaded for this account.')
  return parseDirectoryEntries(data).filter((employee) => employee.status === 'active' || employee.status === 'leave')
}
export async function getSites(): Promise<Site[]> {
  const { data, error } = await getSupabaseClient().rpc('get_sites_payload')

  if (error) throw new Error('Sites and posts could not be loaded for this account.')

  const sites = z.array(siteSchema).parse(data)
  return sites.map((site) => ({
    ...site,
    posts: [...site.posts].sort((left, right) => left.name.localeCompare(right.name)),
  }))
}

export function employeeDisplayName(employee: DirectoryEntry): string {
  const givenName = employee.preferred_name || employee.first_name
  return `${givenName} ${employee.last_name}`
}

export function employeeInitials(employee: DirectoryEntry): string {
  return `${employee.preferred_name || employee.first_name} ${employee.last_name}`
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}
