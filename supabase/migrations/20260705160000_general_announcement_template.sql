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
  'general_announcement',
  'General announcement',
  'Use for approved company-wide or role-wide messages that do not fit schedule, overtime, event, or payroll templates.',
  'general',
  '{{subject}}',
  '{{message}}',
  '[
    {"key":"subject","label":"Subject","type":"text","placeholder":"Important SygShift update"},
    {"key":"message","label":"Message","type":"textarea","placeholder":"Write the approved announcement here."}
  ]'::jsonb,
  array['guard', 'dispatcher', 'supervisor', 'admin']::public.app_role[],
  null,
  5
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
