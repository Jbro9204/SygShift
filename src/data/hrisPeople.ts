import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const statusSchema = z.enum(['onboarding', 'active', 'leave', 'inactive', 'separated'])

const peopleItemSchema = z.object({
  employeeId: z.string().uuid(),
  legalName: z.string(),
  employeeNumber: z.string().nullable(),
  username: z.string(),
  jobTitle: z.string().nullable(),
  status: statusSchema,
  employmentType: z.string(),
  primaryRole: z.string(),
  hiredOn: z.string().nullable(),
  separatedOn: z.string().nullable(),
  accountStatus: z.enum(['active', 'pending', 'disabled', 'not_created']),
  lastSignInAt: z.string().nullable(),
  readinessSignals: z.array(z.string()),
})

const savedViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  search: z.string().nullable(),
  status: z.string(),
  employmentType: z.string(),
  role: z.string(),
  sort: z.string(),
  direction: z.enum(['asc', 'desc']),
  pageSize: z.number(),
})

const peopleWorkspaceSchema = z.object({
  generatedAt: z.string(),
  canManage: z.boolean(),
  page: z.number(),
  pageSize: z.number(),
  totalCount: z.number(),
  totalPages: z.number(),
  summary: z.object({
    active: z.number(),
    onboarding: z.number(),
    leave: z.number(),
    separated: z.number(),
    attention: z.number(),
  }),
  items: z.array(peopleItemSchema),
  priorityQueue: z.array(z.object({ employeeId: z.string().uuid(), legalName: z.string(), reason: z.string() })),
  savedViews: z.array(savedViewSchema),
  options: z.object({ statuses: z.array(z.string()), employmentTypes: z.array(z.string()), roles: z.array(z.string()) }),
})

const employeeFileSchema = z.object({
  employeeId: z.string().uuid(),
  legalName: z.string(),
  firstName: z.string(),
  middleName: z.string().nullable(),
  lastName: z.string(),
  employeeNumber: z.string().nullable(),
  username: z.string(),
  jobTitle: z.string().nullable(),
  status: statusSchema,
  employmentType: z.string(),
  primaryRole: z.string(),
  hiredOn: z.string().nullable(),
  separatedOn: z.string().nullable(),
  account: z.object({
    status: z.enum(['active', 'pending', 'disabled', 'not_created']),
    invitedAt: z.string().nullable(),
    activatedAt: z.string().nullable(),
    disabledAt: z.string().nullable(),
    lastSignInAt: z.string().nullable(),
  }),
  contacts: z.object({
    personalEmail: z.string().nullable(),
    companyEmail: z.string().nullable(),
    mobilePhone: z.string().nullable(),
    emergencyContactName: z.string().nullable(),
    emergencyContactPhone: z.string().nullable(),
    addressLine1: z.string().nullable(),
    addressLine2: z.string().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable(),
    postalCode: z.string().nullable(),
  }).nullable(),
  canViewRestricted: z.boolean(),
  readinessSignals: z.array(z.string()),
  moduleAccess: z.object({
    documents: z.boolean(),
    onboarding: z.boolean(),
    leave: z.boolean(),
    benefits: z.boolean(),
    compensation: z.boolean(),
    talent: z.boolean(),
    learning: z.boolean(),
    cases: z.boolean(),
    safety: z.boolean(),
    assets: z.boolean(),
    offboarding: z.boolean(),
    selfService: z.boolean(),
  }),
  connectedRecords: z.object({
    activeCredentials: z.number(),
    expiredCredentials: z.number(),
    upcomingAvailability: z.number(),
    pendingTimeOff: z.number(),
    documents: z.object({ total: z.number(), expiring: z.number() }).nullable(),
    onboarding: z.object({ status: z.string().nullable(), openTasks: z.number(), blockedTasks: z.number() }).nullable(),
    leave: z.object({ open: z.number(), upcoming: z.number() }).nullable(),
    benefits: z.object({ active: z.number(), pending: z.number() }).nullable(),
    compensation: z.object({ activeRecords: z.number() }).nullable(),
    talent: z.object({ openGoals: z.number(), pendingReviews: z.number(), activePlans: z.number() }).nullable(),
    learning: z.object({ assigned: z.number(), overdue: z.number() }).nullable(),
    employeeCases: z.object({ open: z.number(), highPriority: z.number() }).nullable(),
    safety: z.object({ open: z.number() }).nullable(),
    assets: z.object({ assigned: z.number() }).nullable(),
    lifecycle: z.object({ open: z.number() }).nullable(),
    selfService: z.object({ pending: z.number() }).nullable(),
  }),
})

const employmentDateHistoryItemSchema = z.object({
  id: z.string().uuid(),
  hiredOn: z.string(),
  separatedOn: z.string().nullable(),
  sourceType: z.enum(['hr_export', 'employee_file', 'verified_hr_record', 'verified_manual']),
  sourceReference: z.string(),
  reason: z.string(),
  sourceStatus: z.string(),
  authorizedBy: z.string(),
  authorizedAt: z.string(),
  current: z.boolean(),
})

const employmentDateHistorySchema = z.object({
  canManage: z.boolean(),
  items: z.array(employmentDateHistoryItemSchema),
})

const employmentDateUpdateResultSchema = z.object({
  employeeId: z.string().uuid(),
  hiredOn: z.string(),
  separatedOn: z.string().nullable(),
  changeId: z.string().uuid(),
  updatedAt: z.string(),
})

export type HrisPeopleItem = z.infer<typeof peopleItemSchema>
export type HrisPeopleSavedView = z.infer<typeof savedViewSchema>
export type HrisPeopleWorkspace = z.infer<typeof peopleWorkspaceSchema>
export type HrisEmployeeFile = z.infer<typeof employeeFileSchema>
export type HrisEmploymentDateHistory = z.infer<typeof employmentDateHistorySchema>
export type HrisEmploymentDateSource = z.infer<typeof employmentDateHistoryItemSchema>['sourceType']

export type HrisEmploymentDateUpdateInput = {
  employeeId: string
  hiredOn: string
  separatedOn: string | null
  sourceType: HrisEmploymentDateSource
  sourceReference: string
  reason: string
}

export type HrisPeopleQuery = {
  search?: string
  status?: string
  employmentType?: string
  role?: string
  sort?: string
  direction?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

export async function getHrisPeopleWorkspace(query: HrisPeopleQuery = {}): Promise<HrisPeopleWorkspace> {
  const { data, error } = await getSupabaseClient().rpc('get_hr_people_workspace', {
    target_search: query.search?.trim() || null,
    target_status: query.status ?? 'active',
    target_employment_type: query.employmentType ?? 'all',
    target_role: query.role ?? 'all',
    target_sort: query.sort ?? 'legal_name',
    target_direction: query.direction ?? 'asc',
    target_page: query.page ?? 1,
    target_page_size: query.pageSize ?? 15,
  })
  if (error) throw new Error(error.message || 'People and HR could not be loaded.')
  return peopleWorkspaceSchema.parse(data)
}

export async function getHrisEmployeeFile(employeeId: string): Promise<HrisEmployeeFile> {
  const { data, error } = await getSupabaseClient().rpc('get_hr_people_record', { target_employee_id: employeeId })
  if (error) throw new Error(error.message || 'The employee file could not be loaded.')
  return employeeFileSchema.parse(data)
}

export async function getHrisEmploymentDateHistory(employeeId: string): Promise<HrisEmploymentDateHistory> {
  const { data, error } = await getSupabaseClient().rpc('get_hr_employee_employment_date_history', {
    target_employee_id: employeeId,
    target_limit: 5,
  })
  if (error) throw new Error(error.message || 'Employment date history could not be loaded.')
  return employmentDateHistorySchema.parse(data)
}

export async function updateHrisEmploymentDates(input: HrisEmploymentDateUpdateInput) {
  const { data, error } = await getSupabaseClient().rpc('update_hr_employee_employment_dates', {
    target_employee_id: input.employeeId,
    target_hired_on: input.hiredOn,
    target_reason: input.reason.trim(),
    target_separated_on: input.separatedOn || null,
    target_source_reference: input.sourceReference.trim(),
    target_source_type: input.sourceType,
  })
  if (error) throw new Error(error.message || 'Employment dates could not be updated.')
  return employmentDateUpdateResultSchema.parse(data)
}

export async function saveHrisPeopleView(name: string, query: HrisPeopleQuery): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('save_hr_people_view', {
    target_name: name.trim(),
    target_search: query.search?.trim() || '',
    target_status: query.status ?? 'active',
    target_employment_type: query.employmentType ?? 'all',
    target_role: query.role ?? 'all',
    target_sort: query.sort ?? 'legal_name',
    target_direction: query.direction ?? 'asc',
    target_page_size: query.pageSize ?? 15,
  })
  if (error) throw new Error(error.message || 'The saved view could not be stored.')
  return z.string().uuid().parse(data)
}

export async function deleteHrisPeopleView(id: string): Promise<boolean> {
  const { data, error } = await getSupabaseClient().rpc('delete_hr_people_view', { target_id: id })
  if (error) throw new Error(error.message || 'The saved view could not be deleted.')
  return z.boolean().parse(data)
}
