import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

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
  recipientRoles: z.array(z.enum(['guard', 'dispatcher', 'supervisor', 'admin'])),
  displayOrder: z.number(),
})

const recentAnnouncementSchema = z.object({
  id: z.string().uuid(),
  templateKey: z.string().nullable(),
  title: z.string(),
  kind: z.enum(['general', 'open_shift', 'overtime', 'event']),
  publishedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  recipientRoles: z.array(z.enum(['guard', 'dispatcher', 'supervisor', 'admin'])),
  requiresArmed: z.boolean(),
  createdBy: z.string(),
})

const composerSchema = z.object({
  role: z.enum(['guard', 'dispatcher', 'supervisor', 'admin']),
  hasMfa: z.boolean(),
  templates: z.array(templateSchema),
  recentAnnouncements: z.array(recentAnnouncementSchema),
})

const previewSchema = z.object({
  templateKey: z.string(),
  title: z.string(),
  body: z.string(),
  kind: z.enum(['general', 'open_shift', 'overtime', 'event']),
  recipientRoles: z.array(z.enum(['guard', 'dispatcher', 'supervisor', 'admin'])),
  requiresArmed: z.boolean(),
  recipientCount: z.number().int().nonnegative(),
})

export type AnnouncementField = z.infer<typeof fieldSchema>
export type AnnouncementTemplate = z.infer<typeof templateSchema>
export type AnnouncementComposer = z.infer<typeof composerSchema>
export type AnnouncementPreview = z.infer<typeof previewSchema>

export async function getAnnouncementComposer(): Promise<AnnouncementComposer> {
  const { data, error } = await getSupabaseClient().rpc('get_announcement_composer')
  if (error) throw new Error('Announcement templates could not be loaded for this account.')
  return composerSchema.parse(data)
}

export async function previewAnnouncementTemplate(templateKey: string, fields: Record<string, string>): Promise<AnnouncementPreview> {
  const { data, error } = await getSupabaseClient().rpc('preview_announcement_template', {
    target_fields: fields,
    target_template_key: templateKey,
  })
  if (error) throw new Error(error.message || 'This announcement could not be previewed.')
  return previewSchema.parse(data)
}

export async function publishTemplatedAnnouncement(templateKey: string, fields: Record<string, string>): Promise<AnnouncementPreview & { id: string }> {
  const { data, error } = await getSupabaseClient().rpc('publish_templated_announcement', {
    target_expires_at: null,
    target_fields: fields,
    target_template_key: templateKey,
  })
  if (error) throw new Error(error.message || 'This announcement could not be published.')
  return previewSchema.extend({ id: z.string().uuid() }).parse(data)
}

export function emptyFields(template: AnnouncementTemplate): Record<string, string> {
  return Object.fromEntries(template.requiredFields.map((field) => [field.key, '']))
}

export function recipientSummary(preview: Pick<AnnouncementPreview, 'recipientCount' | 'recipientRoles' | 'requiresArmed'>): string {
  const roles = preview.recipientRoles.map((role) => `${role}s`).join(', ')
  const qualification = preview.requiresArmed ? 'armed-qualified ' : ''
  return `${preview.recipientCount} ${qualification}${roles}`
}
