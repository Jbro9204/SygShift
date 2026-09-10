import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

export const sygTaskStatuses = ['backlog', 'ready', 'in_progress', 'blocked', 'review', 'done', 'canceled'] as const
export const sygTaskPriorities = ['low', 'routine', 'high', 'urgent'] as const
export const sygTaskStatusSchema = z.enum(sygTaskStatuses)
export const sygTaskPrioritySchema = z.enum(sygTaskPriorities)
export const sygTaskReminderKinds = ['reminder', 'alarm'] as const
export const sygTaskReminderRecipientScopes = ['self', 'assignees'] as const
export const sygTaskReminderTimingKinds = ['relative', 'absolute'] as const

const personSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  username: z.string().optional(),
  assignedAt: z.string().optional(),
  addedAt: z.string().optional(),
})

const labelSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  version: z.number().int().positive().optional(),
})

const checklistSummarySchema = z.object({ total: z.number().int().nonnegative(), completed: z.number().int().nonnegative() })

export const sygTaskSchema = z.object({
  id: z.string().uuid(),
  boardId: z.string().uuid(),
  boardName: z.string().optional(),
  title: z.string(),
  description: z.string(),
  status: sygTaskStatusSchema,
  priority: sygTaskPrioritySchema,
  dueAt: z.string().nullable(),
  sortRank: z.coerce.number(),
  createdBy: z.string().uuid(),
  updatedBy: z.string().uuid(),
  version: z.number().int().positive(),
  completedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canEdit: z.boolean(),
  canUpdateStatus: z.boolean(),
  watching: z.boolean(),
  assignees: z.array(personSchema),
  labels: z.array(labelSchema),
  checklist: checklistSummarySchema,
  watcherCount: z.coerce.number().int().nonnegative(),
  commentCount: z.coerce.number().int().nonnegative(),
  dependencyCount: z.coerce.number().int().nonnegative(),
})

export const sygTaskBoardSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  scope: z.enum(['personal', 'team', 'company']),
  ownerEmployeeId: z.string().uuid(),
  ownerName: z.string(),
  memberRole: z.enum(['owner', 'editor', 'member', 'viewer']).nullable(),
  version: z.number().int().positive(),
  archivedAt: z.string().nullable(),
  createdAt: z.string().optional(),
  updatedAt: z.string(),
  openTaskCount: z.coerce.number().int().nonnegative().optional(),
  canManageBoard: z.boolean(),
  canCreateTask: z.boolean(),
})

export const sygTasksWorklistSummarySchema = z.object({
  accessibleBoards: z.coerce.number().int().nonnegative(),
  current: z.coerce.number().int().nonnegative(),
  dueToday: z.coerce.number().int().nonnegative(),
  inProgress: z.coerce.number().int().nonnegative(),
  upcoming: z.coerce.number().int().nonnegative(),
  completedThisMonth: z.coerce.number().int().nonnegative(),
  timezone: z.literal('America/Denver'),
  asOf: z.string(),
})

const sygTaskStatusCountsSchema = z.object({
  backlog: z.coerce.number().int().nonnegative(),
  ready: z.coerce.number().int().nonnegative(),
  in_progress: z.coerce.number().int().nonnegative(),
  blocked: z.coerce.number().int().nonnegative(),
  review: z.coerce.number().int().nonnegative(),
  done: z.coerce.number().int().nonnegative(),
  canceled: z.coerce.number().int().nonnegative(),
})

const sygTaskPriorityCountsSchema = z.object({
  low: z.coerce.number().int().nonnegative(),
  routine: z.coerce.number().int().nonnegative(),
  high: z.coerce.number().int().nonnegative(),
  urgent: z.coerce.number().int().nonnegative(),
})

export const sygTasksWorklistSchema = z.object({
  summary: sygTasksWorklistSummarySchema,
  boards: z.array(sygTaskBoardSchema),
  tasks: z.array(sygTaskSchema),
  counts: z.object({
    status: sygTaskStatusCountsSchema,
    priority: sygTaskPriorityCountsSchema,
  }),
  filters: z.object({
    mode: z.enum(['my_work', 'board']),
    boardId: z.string().uuid().nullable(),
    search: z.string(),
    status: sygTaskStatusSchema.nullable(),
    priority: sygTaskPrioritySchema.nullable(),
    includeArchived: z.boolean(),
  }),
  page: z.object({
    number: z.coerce.number().int().positive(),
    size: z.union([z.literal(5), z.literal(10), z.literal(20), z.literal(50)]),
    total: z.coerce.number().int().nonnegative(),
    totalPages: z.coerce.number().int().nonnegative(),
    hasPrevious: z.boolean(),
    hasMore: z.boolean(),
  }),
})

export const createSygTaskInputSchema = z.object({
  boardId: z.string().uuid(),
  title: z.string().trim().min(1).max(240),
  description: z.string().max(10_000).optional(),
  status: sygTaskStatusSchema.optional(),
  priority: sygTaskPrioritySchema.optional(),
  dueAt: z.string().nullable().optional(),
  sortRank: z.number().int().min(-1_000_000_000).max(1_000_000_000).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
}).strict()

export const createSygTaskResultSchema = z.object({
  action: z.literal('create_task_with_assignee'),
  boardId: z.string().uuid(),
  taskId: z.string().uuid(),
  version: z.number().int().positive(),
  clientRequestId: z.string().uuid(),
  assignedEmployeeId: z.string().uuid().nullable(),
  assignmentId: z.string().uuid().nullable(),
  assignmentChanged: z.boolean(),
  changed: z.boolean(),
}).passthrough()

const sygTaskReminderOccurrenceSchema = z.object({
  id: z.string().uuid(),
  recipientEmployeeId: z.string().uuid(),
  recipientName: z.string(),
  scheduledFor: z.string(),
  state: z.enum(['scheduled', 'triggered', 'snoozed', 'acknowledged', 'cancelled']),
  snoozedUntil: z.string().nullable(),
  triggeredAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancellationReason: z.string().nullable(),
})

export const sygTaskReminderSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(sygTaskReminderKinds),
  recipientScope: z.enum(sygTaskReminderRecipientScopes),
  timingKind: z.enum(sygTaskReminderTimingKinds),
  offsetMinutes: z.number().int().min(0).max(43_200).nullable(),
  absoluteAt: z.string().nullable(),
  emailEnabled: z.boolean(),
  requiredAcknowledgement: z.boolean(),
  createdBy: z.string().uuid(),
  createdByName: z.string(),
  createdAt: z.string(),
  canCancel: z.boolean(),
  occurrences: z.array(sygTaskReminderOccurrenceSchema),
})

export const sygTaskRemindersSchema = z.object({
  taskId: z.string().uuid(),
  canCreateForAssignees: z.boolean(),
  reminders: z.array(sygTaskReminderSchema),
})

export const sygTasksAlarmSchema = z.object({
  occurrenceId: z.string().uuid(),
  reminderId: z.string().uuid(),
  taskId: z.string().uuid(),
  boardId: z.string().uuid(),
  title: z.string(),
  priority: sygTaskPrioritySchema,
  dueAt: z.string().nullable(),
  scheduledFor: z.string(),
  triggeredAt: z.string(),
  deliveryCount: z.number().int().positive(),
  taskVersion: z.number().int().positive(),
  canComplete: z.boolean(),
})

export const sygTasksAlarmStateSchema = z.object({
  serverTime: z.string(),
  alarms: z.array(sygTasksAlarmSchema),
})

export const sygTasksBadgeSchema = z.object({
  count: z.coerce.number().int().nonnegative(),
  unreadCount: z.coerce.number().int().nonnegative(),
  activeAlarmCount: z.coerce.number().int().nonnegative(),
})

export const createSygTaskReminderInputSchema = z.object({
  taskId: z.string().uuid(),
  kind: z.enum(sygTaskReminderKinds),
  recipientScope: z.enum(sygTaskReminderRecipientScopes),
  timingKind: z.enum(sygTaskReminderTimingKinds),
  offsetMinutes: z.number().int().min(0).max(43_200).nullable(),
  absoluteAt: z.string().nullable(),
  emailEnabled: z.boolean(),
}).strict()

const memberSchema = z.object({
  membershipId: z.string().uuid().nullable().optional(),
  employeeId: z.string().uuid(),
  name: z.string(),
  username: z.string(),
  role: z.enum(['owner', 'editor', 'member', 'viewer']).nullable().optional(),
  addedAt: z.string().nullable().optional(),
})

const availableMemberSchema = z.object({
  employeeId: z.string().uuid(),
  name: z.string(),
  username: z.string(),
  isMember: z.boolean(),
  membershipId: z.string().uuid().nullable(),
  role: z.enum(['owner', 'editor', 'member', 'viewer']).nullable(),
})

const taskDetailSchema = sygTaskSchema.extend({
  watchers: z.array(personSchema),
  checklistItems: z.array(z.object({
    id: z.string().uuid(), title: z.string(), sortRank: z.coerce.number(), completedBy: z.string().uuid().nullable(),
    completedAt: z.string().nullable(), version: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string(),
  })),
  comments: z.array(z.object({
    id: z.string().uuid(), authorId: z.string().uuid(), authorName: z.string(), body: z.string(), version: z.number().int().positive(),
    editedAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(), canEdit: z.boolean(),
  })),
  dependencies: z.array(z.object({ id: z.string().uuid(), taskId: z.string().uuid(), title: z.string(), status: sygTaskStatusSchema, dueAt: z.string().nullable() })),
  activity: z.array(z.object({
    id: z.coerce.number(), action: z.string(), entityType: z.string(), entityId: z.string().uuid(), details: z.record(z.string(), z.unknown()),
    actorId: z.string().uuid(), actorName: z.string(), createdAt: z.string(),
  })),
})

export const sygTaskActivityEventSchema = z.object({
  id: z.coerce.number().int().positive(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().uuid(),
  details: z.record(z.string(), z.unknown()),
  actorId: z.string().uuid(),
  actorName: z.string(),
  actorSource: z.enum(['employee', 'system']),
  createdAt: z.string(),
  subject: z.object({
    employeeId: z.string().uuid(),
    name: z.string(),
    username: z.string(),
  }).nullable(),
  label: z.object({
    labelId: z.string().uuid(),
    name: z.string(),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
  }).nullable(),
  relatedTask: z.object({
    taskId: z.string().uuid(),
    title: z.string(),
  }).nullable(),
})

export const sygTaskActivityPageSchema = z.object({
  taskId: z.string().uuid(),
  events: z.array(sygTaskActivityEventSchema),
  page: z.object({
    size: z.union([z.literal(20), z.literal(50), z.literal(100)]),
    hasMore: z.boolean(),
    nextBeforeId: z.coerce.number().int().positive().nullable(),
  }),
})

export const sygTasksWorkspaceSchema = z.object({
  employeeId: z.string().uuid(),
  permissions: z.object({ viewShared: z.boolean(), manageShared: z.boolean() }),
  boards: z.array(sygTaskBoardSchema),
  selectedBoard: sygTaskBoardSchema.nullable(),
  tasks: z.array(sygTaskSchema),
  myTasks: z.array(sygTaskSchema),
  labels: z.array(labelSchema),
  members: z.array(memberSchema),
  availableMembers: z.array(availableMemberSchema).default([]),
  taskDetail: taskDetailSchema.nullable(),
  page: z.object({
    size: z.union([z.literal(5), z.literal(10), z.literal(20), z.literal(50)]),
    hasMore: z.boolean(),
    nextCursor: z.object({ updatedAt: z.string(), taskId: z.string().uuid() }).nullable(),
  }),
})

export type SygTask = z.infer<typeof sygTaskSchema>
export type SygTaskBoard = z.infer<typeof sygTaskBoardSchema>
export type SygTaskDetail = z.infer<typeof taskDetailSchema>
export type SygTasksWorkspace = z.infer<typeof sygTasksWorkspaceSchema>
export type SygTaskStatus = z.infer<typeof sygTaskStatusSchema>
export type SygTaskPriority = z.infer<typeof sygTaskPrioritySchema>
export type SygTaskMember = z.infer<typeof memberSchema>
export type SygTasksWorklist = z.infer<typeof sygTasksWorklistSchema>
export type SygTasksWorklistSummary = z.infer<typeof sygTasksWorklistSummarySchema>
export type CreateSygTaskInput = z.infer<typeof createSygTaskInputSchema>
export type CreateSygTaskResult = z.infer<typeof createSygTaskResultSchema>
export type SygTaskReminder = z.infer<typeof sygTaskReminderSchema>
export type SygTaskReminders = z.infer<typeof sygTaskRemindersSchema>
export type SygTaskActivityEvent = z.infer<typeof sygTaskActivityEventSchema>
export type SygTaskActivityPage = z.infer<typeof sygTaskActivityPageSchema>
export type SygTasksAlarm = z.infer<typeof sygTasksAlarmSchema>
export type SygTasksAlarmState = z.infer<typeof sygTasksAlarmStateSchema>
export type CreateSygTaskReminderInput = z.infer<typeof createSygTaskReminderInputSchema>
export type SygTaskAction =
  | 'create_board' | 'update_board' | 'archive_board' | 'add_board_member' | 'remove_board_member'
  | 'create_task' | 'update_task' | 'archive_task' | 'assign_task' | 'unassign_task' | 'watch_task' | 'unwatch_task'
  | 'create_label' | 'update_label' | 'apply_label' | 'remove_label'
  | 'add_checklist_item' | 'update_checklist_item' | 'archive_checklist_item'
  | 'add_comment' | 'edit_comment' | 'archive_comment' | 'add_dependency' | 'remove_dependency'

export interface SygTasksQuery {
  boardId?: string | null
  taskId?: string | null
  cursor?: { updatedAt: string; taskId: string } | null
  pageSize?: 5 | 10 | 20 | 50
  includeArchived?: boolean
}

export interface SygTasksWorklistQuery {
  mode?: 'my_work' | 'board'
  boardId?: string | null
  search?: string
  status?: SygTaskStatus | null
  priority?: SygTaskPriority | null
  page?: number
  pageSize?: 5 | 10 | 20 | 50
  includeArchived?: boolean
}

export async function getSygTasksWorkspace(input: SygTasksQuery = {}): Promise<SygTasksWorkspace> {
  const { data, error } = await getSupabaseClient().rpc('get_sygtasks_workspace', {
    target_board_id: input.boardId ?? null,
    target_task_id: input.taskId ?? null,
    target_cursor_updated_at: input.cursor?.updatedAt ?? null,
    target_cursor_task_id: input.cursor?.taskId ?? null,
    target_page_size: input.pageSize ?? 20,
    target_include_archived: input.includeArchived ?? false,
  })
  if (error) throw new Error(error.message || 'SygTasks could not load your work.')
  return sygTasksWorkspaceSchema.parse(data)
}

export async function getSygTasksWorklist(input: SygTasksWorklistQuery = {}): Promise<SygTasksWorklist> {
  const { data, error } = await getSupabaseClient().rpc('get_sygtasks_worklist', {
    target_mode: input.mode ?? 'my_work',
    target_board_id: input.boardId ?? null,
    target_search: input.search ?? '',
    target_status: input.status ?? null,
    target_priority: input.priority ?? null,
    target_page: input.page ?? 1,
    target_page_size: input.pageSize ?? 20,
    target_include_archived: input.includeArchived ?? false,
  })
  if (error) throw new Error(error.message || 'SygTasks could not load this task list.')
  return sygTasksWorklistSchema.parse(data)
}

export async function createSygTask(
  input: CreateSygTaskInput,
  options: { clientRequestId?: string } = {},
): Promise<CreateSygTaskResult> {
  const payload = createSygTaskInputSchema.parse(input)
  const { data, error } = await getSupabaseClient().rpc('create_sygtasks_task', {
    target_payload: payload,
    target_client_request_id: options.clientRequestId ?? crypto.randomUUID(),
  })
  if (error) throw new Error(error.message || 'SygTasks could not create this task.')
  return createSygTaskResultSchema.parse(data)
}

export async function getSygTaskReminders(taskId: string): Promise<SygTaskReminders> {
  const { data, error } = await getSupabaseClient().rpc('get_sygtasks_task_reminders', { target_task_id: taskId })
  if (error) throw new Error(error.message || 'Task reminders could not load.')
  return sygTaskRemindersSchema.parse(data)
}

export async function getSygTaskActivity(
  taskId: string,
  beforeId?: number | null,
  pageSize: 20 | 50 | 100 = 50,
): Promise<SygTaskActivityPage> {
  const { data, error } = await getSupabaseClient().rpc('get_sygtasks_task_activity', {
    target_task_id: z.string().uuid().parse(taskId),
    target_before_id: beforeId ?? null,
    target_page_size: pageSize,
  })
  if (error) throw new Error(error.message || 'Task activity could not load.')
  return sygTaskActivityPageSchema.parse(data)
}

export async function createSygTaskReminder(
  input: CreateSygTaskReminderInput,
  options: { clientRequestId?: string } = {},
): Promise<Record<string, unknown>> {
  const payload = createSygTaskReminderInputSchema.parse(input)
  const { data, error } = await getSupabaseClient().rpc('create_sygtasks_task_reminder', {
    target_payload: payload,
    target_client_request_id: options.clientRequestId ?? crypto.randomUUID(),
  })
  if (error) throw new Error(error.message || 'Task reminder could not be created.')
  return z.record(z.string(), z.unknown()).parse(data)
}

export async function cancelSygTaskReminder(reminderId: string, clientRequestId = crypto.randomUUID()): Promise<void> {
  const { error } = await getSupabaseClient().rpc('cancel_sygtasks_task_reminder', {
    target_reminder_id: z.string().uuid().parse(reminderId),
    target_client_request_id: clientRequestId,
  })
  if (error) throw new Error(error.message || 'Task reminder could not be canceled.')
}

export async function getMySygTasksAlarmState(): Promise<SygTasksAlarmState> {
  const { data, error } = await getSupabaseClient().rpc('get_my_sygtasks_alarm_state')
  if (error) throw new Error(error.message || 'Task alarms could not be checked.')
  return sygTasksAlarmStateSchema.parse(data)
}

export async function getMySygTasksBadge() {
  const { data, error } = await getSupabaseClient().rpc('get_my_sygtasks_badge')
  if (error) throw new Error(error.message || 'SygTasks notifications could not be checked.')
  return sygTasksBadgeSchema.parse(data)
}

export async function manageMySygTasksAlarm(
  action: 'acknowledge' | 'snooze',
  occurrenceId: string,
  snoozeMinutes: 5 | 10 | 15 | 30 | 60 | null,
  clientRequestId = crypto.randomUUID(),
): Promise<void> {
  const { error } = await getSupabaseClient().rpc('manage_my_sygtasks_alarm', {
    target_action: action,
    target_occurrence_id: z.string().uuid().parse(occurrenceId),
    target_snooze_minutes: snoozeMinutes,
    target_client_request_id: clientRequestId,
  })
  if (error) throw new Error(error.message || 'The task alarm could not be updated.')
}

export async function mutateSygTasks(
  action: SygTaskAction,
  payload: Record<string, unknown>,
  options: { expectedVersion?: number | null; clientRequestId?: string } = {},
): Promise<Record<string, unknown>> {
  const { data, error } = await getSupabaseClient().rpc('mutate_sygtasks', {
    target_action: action,
    target_payload: payload,
    target_client_request_id: options.clientRequestId ?? crypto.randomUUID(),
    target_expected_version: options.expectedVersion ?? null,
  })
  if (error) throw new Error(error.message || 'SygTasks could not save this change.')
  return z.record(z.string(), z.unknown()).parse(data)
}

export function sygTaskPath(boardId?: string | null, taskId?: string | null) {
  const query = new URLSearchParams()
  if (boardId) query.set('board', boardId)
  if (taskId) query.set('task', taskId)
  return `/tasks${query.size ? `?${query}` : ''}`
}

export function formatSygTaskStatus(status: SygTaskStatus) {
  return ({ backlog: 'Backlog', ready: 'Ready', in_progress: 'In progress', blocked: 'Blocked', review: 'Review', done: 'Done', canceled: 'Canceled' } as const)[status]
}

export function formatSygTaskPriority(priority: SygTaskPriority) {
  return ({ low: 'Low', routine: 'Routine', high: 'High', urgent: 'Urgent' } as const)[priority]
}
