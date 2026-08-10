import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import type { AppRole } from './session'

const appRoleSchema = z.enum(['guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin'])
const announcementBannerAudienceSchema = z.enum(['all', 'supervisors', 'roles'])

const fieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['text', 'textarea', 'date', 'number', 'select']).default('text'),
  placeholder: z.string().optional(),
  options: z.array(z.string()).optional(),
})

const templateSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(['general', 'open_shift', 'overtime', 'event']),
  requiredFields: z.array(fieldSchema),
  recipientRoles: z.array(appRoleSchema),
  displayOrder: z.number(),
})

const recentAnnouncementSchema = z.object({
  id: z.string().uuid(),
  rootAnnouncementId: z.string().uuid().optional(),
  contentVersion: z.number().int().positive().optional().default(1),
  templateKey: z.string().nullable(),
  templateFields: z.record(z.string(), z.unknown()).nullable().optional(),
  title: z.string(),
  body: z.string().optional().default(''),
  kind: z.enum(['general', 'open_shift', 'overtime', 'event']),
  publishedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  recipientRoles: z.array(appRoleSchema),
  requiresArmed: z.boolean(),
  acknowledgmentMode: z.enum(['informational', 'required']).optional().default('informational'),
  acknowledgmentDueAt: z.string().nullable().optional().default(null),
  createdBy: z.string(),
})

const announcementBannerSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  message: z.string(),
  tone: z.enum(['info', 'success', 'warning', 'urgent']),
  ctaLabel: z.string().nullable(),
  ctaHref: z.string().nullable(),
  audience: announcementBannerAudienceSchema.optional().default('all'),
  audienceRoles: z.array(appRoleSchema).nullable().optional().transform((roles) => roles ?? []),
  active: z.boolean(),
  startsAt: z.string(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const composerSchema = z.object({
  role: appRoleSchema,
  hasMfa: z.boolean(),
  canSend: z.boolean().optional().default(false),
  canManageBanner: z.boolean().optional().default(false),
  activeBanner: announcementBannerSchema.nullable().optional().default(null),
  activeBanners: z.array(announcementBannerSchema).optional().default([]),
  templates: z.array(templateSchema),
  recentAnnouncements: z.array(recentAnnouncementSchema),
})

const announcementBannerManagerSchema = z.object({
  activeBanner: announcementBannerSchema.nullable().optional().default(null),
  activeBanners: z.array(announcementBannerSchema).optional().default([]),
  banners: z.array(announcementBannerSchema),
})

const previewSchema = z.object({
  templateKey: z.string().default(''),
  title: z.string(),
  body: z.string(),
  kind: z.enum(['general', 'open_shift', 'overtime', 'event']),
  recipientRoles: z.array(appRoleSchema),
  requiresArmed: z.boolean(),
  recipientCount: z.number().int().nonnegative(),
})

export type AnnouncementField = z.infer<typeof fieldSchema>
export type AnnouncementTemplate = z.infer<typeof templateSchema>
export type AnnouncementComposer = z.infer<typeof composerSchema>
export type AnnouncementPreview = z.infer<typeof previewSchema>
export type RecentAnnouncement = z.infer<typeof recentAnnouncementSchema>
export type AnnouncementBanner = z.infer<typeof announcementBannerSchema>
export type AnnouncementBannerAudience = z.infer<typeof announcementBannerAudienceSchema>
export type AnnouncementBannerManager = z.infer<typeof announcementBannerManagerSchema>

export interface AnnouncementBannerMutationInput {
  bannerId?: string | null
  title: string
  message: string
  tone: AnnouncementBanner['tone']
  ctaLabel?: string | null
  ctaHref?: string | null
  audience: AnnouncementBannerAudience
  audienceRoles: AppRole[]
  active: boolean
  startsAt?: string | null
  expiresAt?: string | null
}

export const ANNOUNCEMENT_BANNER_ROLE_OPTIONS: Array<{ role: AppRole, label: string }> = [
  { role: 'guard', label: 'Guards' },
  { role: 'dispatcher', label: 'Dispatchers' },
  { role: 'scheduler', label: 'Schedulers' },
  { role: 'recruiting_licensing', label: 'Recruiting & Licensing' },
  { role: 'supervisor', label: 'Supervisors' },
  { role: 'admin', label: 'Admins' },
]

export async function getAnnouncementComposer(): Promise<AnnouncementComposer> {
  const { data, error } = await getSupabaseClient().rpc('get_announcement_composer')
  if (error) throw new Error('Announcement templates could not be loaded for this account.')
  const composer = composerSchema.parse(data)
  return {
    ...composer,
    templates: composer.templates.filter((template) => template.key !== 'welcome_to_sygshift'),
    recentAnnouncements: composer.recentAnnouncements.filter((announcement) => announcement.templateKey !== 'welcome_to_sygshift'),
  }
}

export async function previewAnnouncementTemplate(templateKey: string, fields: Record<string, string>): Promise<AnnouncementPreview> {
  const { data, error } = await getSupabaseClient().rpc('preview_announcement_template', {
    target_fields: fields,
    target_template_key: templateKey,
  })
  if (error) throw new Error(error.message || 'This announcement could not be previewed.')
  return previewSchema.parse(data)
}

export async function publishTemplatedAnnouncement(
  templateKey: string,
  fields: Record<string, string>,
  options: { dueAt?: string | null, expiresAt?: string | null, required?: boolean } = {},
): Promise<AnnouncementPreview & { id: string, contentVersion: number, assignmentCount: number }> {
  const { data, error } = await getSupabaseClient().rpc('publish_templated_announcement_with_acknowledgment', {
    target_due_at: options.dueAt ?? null,
    target_expires_at: options.expiresAt ?? null,
    target_fields: fields,
    target_required: options.required ?? false,
    target_template_key: templateKey,
  })
  if (error) throw new Error(error.message || 'This announcement could not be published.')
  return previewSchema.extend({
    assignmentCount: z.number().int().nonnegative(),
    contentVersion: z.number().int().positive(),
    id: z.string().uuid(),
  }).parse(data)
}

export async function reviseTemplatedAnnouncement(
  announcementId: string,
  fields: Record<string, string>,
  options: { expiresAt?: string | null, required: boolean, dueAt?: string | null },
): Promise<AnnouncementPreview & { id: string, contentVersion: number, assignmentCount: number }> {
  const { data, error } = await getSupabaseClient().rpc('revise_templated_announcement', {
    target_announcement_id: announcementId,
    target_due_at: options.dueAt ?? null,
    target_expires_at: options.expiresAt ?? null,
    target_fields: fields,
    target_required: options.required,
  })
  if (error) throw new Error(error.message || 'This announcement revision could not be published.')
  return previewSchema.extend({
    assignmentCount: z.number().int().nonnegative(),
    contentVersion: z.number().int().positive(),
    id: z.string().uuid(),
  }).parse(data)
}

export async function getActiveAnnouncementBanner(): Promise<AnnouncementBanner | null> {
  const { data, error } = await getSupabaseClient().rpc('get_active_announcement_banner')
  if (error) throw new Error(error.message || 'Announcement banner could not be loaded.')
  return announcementBannerSchema.nullable().parse(data)
}

export async function getActiveAnnouncementBanners(): Promise<AnnouncementBanner[]> {
  const { data, error } = await getSupabaseClient().rpc('get_active_announcement_banners')
  if (error) throw new Error(error.message || 'Announcement banners could not be loaded.')
  return z.array(announcementBannerSchema).parse(data)
}

export async function getAnnouncementBannerManager(): Promise<AnnouncementBannerManager> {
  const { data, error } = await getSupabaseClient().rpc('get_announcement_banner_manager')
  if (error) throw new Error(error.message || 'Announcement banner manager could not be loaded.')
  return announcementBannerManagerSchema.parse(data)
}

export async function saveAnnouncementBanner(input: AnnouncementBannerMutationInput): Promise<AnnouncementBannerManager> {
  const { data, error } = await getSupabaseClient().rpc('upsert_announcement_banner', {
    target_active: input.active,
    target_audience: input.audience,
    target_audience_roles: input.audienceRoles,
    target_banner_id: input.bannerId ?? null,
    target_cta_href: cleanOptional(input.ctaHref),
    target_cta_label: cleanOptional(input.ctaLabel),
    target_expires_at: input.expiresAt || null,
    target_message: input.message.trim(),
    target_starts_at: input.startsAt || null,
    target_title: input.title.trim(),
    target_tone: input.tone,
  })
  if (error) throw new Error(error.message || 'Announcement banner could not be saved.')
  return announcementBannerManagerSchema.parse(data)
}

export function emptyFields(template: AnnouncementTemplate): Record<string, string> {
  return Object.fromEntries(template.requiredFields.map((field) => [field.key, '']))
}

function cleanOptional(value: string | null | undefined): string | null {
  const clean = value?.trim()
  return clean ? clean : null
}

export function recipientSummary(preview: Pick<AnnouncementPreview, 'recipientCount' | 'recipientRoles' | 'requiresArmed'>): string {
  const roles = preview.recipientRoles.map((role) => `${role}s`).join(', ')
  const qualification = preview.requiresArmed ? 'armed-qualified ' : ''
  return `${preview.recipientCount} ${qualification}${roles}`
}

export function bannerAudienceLabel(banner: Pick<AnnouncementBanner, 'audience' | 'audienceRoles'>): string {
  if (banner.audience === 'all') return 'Everyone'
  if (banner.audience === 'supervisors') return 'Supervisors and admins'
  const labels = banner.audienceRoles
    .map((role) => ANNOUNCEMENT_BANNER_ROLE_OPTIONS.find((option) => option.role === role)?.label ?? role)
  return labels.length ? labels.join(', ') : 'Custom audience'
}
