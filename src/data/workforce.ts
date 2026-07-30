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
  role: z.enum(['guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin']),
  employment_type: z.enum(['hourly', 'salary', 'flex']),
  status: z.enum(['onboarding', 'active', 'leave', 'inactive', 'separated']),
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

const recentlyDeletedRecordSchema = z.object({
  id: z.string().uuid(),
  recordType: z.enum(['employee', 'site', 'post']),
  recordId: z.string().uuid(),
  displayName: z.string(),
  metadata: z.unknown(),
  deletedBy: z.string().uuid().nullable(),
  deletedAt: z.string(),
  expiresAt: z.string(),
})

export type DirectoryEntry = z.infer<typeof directoryEntrySchema>
export type DirectoryCredential = z.infer<typeof credentialSchema>
export type CredentialKind = DirectoryCredential['kind']
export type CredentialStatus = DirectoryCredential['status']
export type Site = z.infer<typeof siteSchema>
export type SitePost = z.infer<typeof postSchema>
export type RecentlyDeletedRecord = z.infer<typeof recentlyDeletedRecordSchema>

export interface EmployeeCredentialMutationInput {
  employeeId: string
  kind: CredentialKind
  status: CredentialStatus
  credentialNumber?: string | null
  validFrom?: string | null
  expiresOn?: string | null
  notes?: string | null
}

export interface SiteMutationInput {
  siteId?: string | null
  code?: string | null
  name: string
  addressLine1?: string | null
  city?: string | null
  region?: string | null
  postalCode?: string | null
  timeZone: string
  active: boolean
}

export interface PostMutationInput {
  postId?: string | null
  siteId: string
  name: string
  requiresArmed: boolean
  active: boolean
  defaultStartTime?: string | null
  defaultEndTime?: string | null
}

function cleanOptional(value: string | null | undefined): string | null {
  const clean = value?.trim()
  return clean ? clean : null
}

export function parseDirectoryEntries(value: unknown): DirectoryEntry[] {
  return z.array(directoryEntrySchema).parse(value)
}

export async function getEmployeeDirectory(): Promise<DirectoryEntry[]> {
  const { data, error } = await getSupabaseClient().rpc('get_employee_directory')
  if (error) throw new Error('The employee directory could not be loaded for this account.')
  return parseDirectoryEntries(data).filter((employee) => employee.status === 'active' || employee.status === 'leave')
}

export async function upsertDirectoryCredential(input: EmployeeCredentialMutationInput): Promise<DirectoryEntry> {
  const { data, error } = await getSupabaseClient().rpc('upsert_employee_credential', {
    target_credential_number: cleanOptional(input.credentialNumber),
    target_employee_id: input.employeeId,
    target_expires_on: cleanOptional(input.expiresOn),
    target_kind: input.kind,
    target_notes: cleanOptional(input.notes),
    target_status: input.status,
    target_valid_from: cleanOptional(input.validFrom),
  })
  if (error) throw new Error(error.message || 'Credential could not be updated.')
  return directoryEntrySchema.parse(data)
}

export async function getSites(): Promise<Site[]> {
  const { data, error } = await getSupabaseClient().rpc('get_sites_payload')

  if (error) throw new Error('Sites and posts could not be loaded for this account.')

  return parseSitesPayload(data)
}

function parseSitesPayload(data: unknown): Site[] {
  const sites = z.array(siteSchema).parse(data)
  return sites.map((site) => ({
    ...site,
    posts: [...site.posts].sort((left, right) => left.name.localeCompare(right.name)),
  }))
}

export async function upsertSite(input: SiteMutationInput): Promise<Site[]> {
  const { data, error } = await getSupabaseClient().rpc('upsert_site', {
    target_active: input.active,
    target_address_line_1: cleanOptional(input.addressLine1),
    target_city: cleanOptional(input.city),
    target_code: cleanOptional(input.code),
    target_name: input.name.trim(),
    target_postal_code: cleanOptional(input.postalCode),
    target_region: cleanOptional(input.region),
    target_site_id: input.siteId ?? null,
    target_time_zone: cleanOptional(input.timeZone) ?? 'America/Denver',
  })
  if (error) throw new Error(error.message || 'Site could not be saved.')
  return parseSitesPayload(data)
}

export async function upsertPost(input: PostMutationInput): Promise<Site[]> {
  const { data, error } = await getSupabaseClient().rpc('upsert_post', {
    target_active: input.active,
    target_default_end_time: cleanOptional(input.defaultEndTime),
    target_default_start_time: cleanOptional(input.defaultStartTime),
    target_name: input.name.trim(),
    target_post_id: input.postId ?? null,
    target_requires_armed: input.requiresArmed,
    target_site_id: input.siteId,
  })
  if (error) throw new Error(error.message || 'Post could not be saved.')
  return parseSitesPayload(data)
}

export async function deleteUnusedSite(siteId: string): Promise<Site[]> {
  const { data, error } = await getSupabaseClient().rpc('delete_unused_site', {
    target_site_id: siteId,
  })
  if (error) throw new Error(error.message || 'Site could not be deleted.')
  return parseSitesPayload(data)
}

export async function deleteUnusedPost(postId: string): Promise<Site[]> {
  const { data, error } = await getSupabaseClient().rpc('delete_unused_post', {
    target_post_id: postId,
  })
  if (error) throw new Error(error.message || 'Post could not be deleted.')
  return parseSitesPayload(data)
}

export async function getRecentlyDeletedSitesAndPosts(): Promise<RecentlyDeletedRecord[]> {
  const [sitesResult, postsResult] = await Promise.all([
    getSupabaseClient().rpc('get_recently_deleted_records', { target_record_type: 'site' }),
    getSupabaseClient().rpc('get_recently_deleted_records', { target_record_type: 'post' }),
  ])

  if (sitesResult.error) throw new Error(sitesResult.error.message || 'Recently deleted sites could not be loaded.')
  if (postsResult.error) throw new Error(postsResult.error.message || 'Recently deleted posts could not be loaded.')

  return z.array(recentlyDeletedRecordSchema)
    .parse([...(sitesResult.data ?? []), ...(postsResult.data ?? [])])
    .sort((left, right) => right.deletedAt.localeCompare(left.deletedAt))
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
