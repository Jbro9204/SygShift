insert into public.announcement_templates (
  template_key,
  name,
  description,
  kind,
  subject_pattern,
  body_pattern,
  required_fields,
  recipient_roles,
  requires_armed_field,
  display_order
) values (
  'welcome_to_sygshift',
  'Welcome to SygShift',
  'Approved rollout message introducing SygShift, the live site link, testing expectations, and the correct support contact.',
  'general',
  'Welcome to SygShift',
  'Hello team,

Welcome to SygShift, our new scheduling, time, and workforce coordination system.

Site link: https://sygshift.sygilant.workers.dev

What SygShift will help with:
- Viewing current schedules in one easy-to-read place.
- Seeing open shifts, overtime opportunities, and event coverage needs.
- Requesting time off and tracking schedule-related requests.
- Using time clock and attendance tools as rollout continues.
- Receiving company scheduling announcements in one consistent format.

We are still testing and polishing the system before full rollout. If you notice a bug, missing information, confusing screen, or anything that does not look right, please email Jordan Brown at jbrown@guardianshipsecurity.net.

Thank you for helping us make this stronger and easier for everyone to use.

Jordan Brown
Chief Systems and Automation Officer',
  '[]'::jsonb,
  array['guard', 'dispatcher', 'supervisor', 'admin']::public.app_role[],
  null,
  6
)
on conflict (template_key) do update set
  name = excluded.name,
  description = excluded.description,
  kind = excluded.kind,
  subject_pattern = excluded.subject_pattern,
  body_pattern = excluded.body_pattern,
  required_fields = excluded.required_fields,
  recipient_roles = excluded.recipient_roles,
  requires_armed_field = excluded.requires_armed_field,
  display_order = excluded.display_order,
  is_active = true,
  updated_at = clock_timestamp();
