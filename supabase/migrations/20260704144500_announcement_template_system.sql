begin;

create table if not exists public.announcement_templates (
  template_key text primary key,
  name text not null,
  description text not null,
  kind public.announcement_kind not null,
  subject_pattern text not null,
  body_pattern text not null,
  required_fields jsonb not null default '[]'::jsonb,
  recipient_roles public.app_role[] not null default array['guard']::public.app_role[],
  requires_armed_field text,
  is_active boolean not null default true,
  display_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint announcement_templates_key_format check (template_key ~ '^[a-z][a-z0-9_]*$'),
  constraint announcement_templates_required_fields_array check (jsonb_typeof(required_fields) = 'array'),
  constraint announcement_templates_name_present check (btrim(name) <> ''),
  constraint announcement_templates_description_present check (btrim(description) <> ''),
  constraint announcement_templates_subject_present check (btrim(subject_pattern) <> ''),
  constraint announcement_templates_body_present check (btrim(body_pattern) <> ''),
  constraint announcement_templates_recipient_roles_present check (cardinality(recipient_roles) > 0)
);

alter table public.announcements
  add column if not exists template_key text references public.announcement_templates(template_key) on delete restrict,
  add column if not exists template_fields jsonb not null default '{}'::jsonb,
  add column if not exists recipient_roles public.app_role[] not null default array['guard', 'supervisor', 'admin']::public.app_role[],
  add column if not exists requires_armed boolean not null default false;

alter table public.announcements
  drop constraint if exists announcements_template_fields_object,
  add constraint announcements_template_fields_object check (jsonb_typeof(template_fields) = 'object');

alter table public.announcements
  drop constraint if exists announcements_recipient_roles_present,
  add constraint announcements_recipient_roles_present check (cardinality(recipient_roles) > 0);

alter table public.announcement_templates enable row level security;

drop policy if exists announcement_templates_read on public.announcement_templates;
create policy announcement_templates_read on public.announcement_templates
for select to authenticated
using (is_active and public.is_supervisor_or_admin());

drop policy if exists announcement_templates_admin_write on public.announcement_templates;
create policy announcement_templates_admin_write on public.announcement_templates
for all to authenticated
using (public.current_app_role() = 'admin' and public.has_mfa())
with check (public.current_app_role() = 'admin' and public.has_mfa());

grant select on public.announcement_templates to authenticated;
grant insert, update, delete on public.announcement_templates to authenticated;

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
) values
  (
    'open_shift_available',
    'Open shift available',
    'Use when a normal open shift needs coverage from qualified guards.',
    'open_shift',
    'Open shift available - {{site}} - {{shift_date}}',
    'An open shift is available for qualified guards.' || E'\n\n' ||
      'Site: {{site}}' || E'\n' ||
      'Post: {{post}}' || E'\n' ||
      'Date: {{shift_date}}' || E'\n' ||
      'Time: {{shift_time}}' || E'\n' ||
      'Requirement: {{requirement}}' || E'\n' ||
      'Response deadline: {{response_deadline}}' || E'\n\n' ||
      'Notes: {{notes}}',
    '[
      {"key":"site","label":"Site","type":"text","placeholder":"Denver Museum"},
      {"key":"post","label":"Post","type":"text","placeholder":"Front entrance"},
      {"key":"shift_date","label":"Date","type":"date"},
      {"key":"shift_time","label":"Time","type":"text","placeholder":"1400-2200"},
      {"key":"requirement","label":"Requirement","type":"select","options":["Unarmed guard","Armed guard"]},
      {"key":"response_deadline","label":"Response deadline","type":"text","placeholder":"Respond by 10 AM tomorrow"},
      {"key":"notes","label":"Notes","type":"textarea","placeholder":"Uniform, parking, arrival instructions"}
    ]'::jsonb,
    array['guard']::public.app_role[],
    'requirement',
    10
  ),
  (
    'overtime_opportunity',
    'Overtime opportunity',
    'Use when overtime coverage is available and eligible guards may request it.',
    'overtime',
    'Overtime opportunity - {{site}} - {{shift_date}}',
    'An overtime opportunity is available.' || E'\n\n' ||
      'Site: {{site}}' || E'\n' ||
      'Post or assignment: {{post}}' || E'\n' ||
      'Date: {{shift_date}}' || E'\n' ||
      'Time: {{shift_time}}' || E'\n' ||
      'Requirement: {{requirement}}' || E'\n' ||
      'Response deadline: {{response_deadline}}' || E'\n\n' ||
      'Notes: {{notes}}',
    '[
      {"key":"site","label":"Site","type":"text"},
      {"key":"post","label":"Post or assignment","type":"text"},
      {"key":"shift_date","label":"Date","type":"date"},
      {"key":"shift_time","label":"Time","type":"text","placeholder":"1800-0200"},
      {"key":"requirement","label":"Requirement","type":"select","options":["Unarmed guard","Armed guard"]},
      {"key":"response_deadline","label":"Response deadline","type":"text"},
      {"key":"notes","label":"Notes","type":"textarea"}
    ]'::jsonb,
    array['guard']::public.app_role[],
    'requirement',
    20
  ),
  (
    'event_coverage_needed',
    'Event coverage needed',
    'Use when guards can request to work a special event.',
    'event',
    'Event coverage needed - {{event_name}} - {{event_date}}',
    'Event coverage is available for qualified guards.' || E'\n\n' ||
      'Event: {{event_name}}' || E'\n' ||
      'Location: {{location}}' || E'\n' ||
      'Date: {{event_date}}' || E'\n' ||
      'Time: {{event_time}}' || E'\n' ||
      'Guards needed: {{guards_needed}}' || E'\n' ||
      'Requirement: {{requirement}}' || E'\n\n' ||
      'Notes: {{notes}}',
    '[
      {"key":"event_name","label":"Event name","type":"text"},
      {"key":"location","label":"Location","type":"text"},
      {"key":"event_date","label":"Date","type":"date"},
      {"key":"event_time","label":"Time","type":"text"},
      {"key":"guards_needed","label":"Guards needed","type":"number"},
      {"key":"requirement","label":"Requirement","type":"select","options":["Unarmed guard","Armed guard"]},
      {"key":"notes","label":"Notes","type":"textarea","placeholder":"Uniform, parking, check-in instructions"}
    ]'::jsonb,
    array['guard']::public.app_role[],
    'requirement',
    30
  ),
  (
    'last_minute_call_off_coverage',
    'Last-minute call-off coverage',
    'Use after a call-off has been reviewed and replacement coverage needs to be posted.',
    'open_shift',
    'Urgent coverage needed - {{site}} - {{shift_date}}',
    'Last-minute coverage is needed for an open shift.' || E'\n\n' ||
      'Site: {{site}}' || E'\n' ||
      'Post: {{post}}' || E'\n' ||
      'Date: {{shift_date}}' || E'\n' ||
      'Time: {{shift_time}}' || E'\n' ||
      'Requirement: {{requirement}}' || E'\n' ||
      'Response deadline: {{response_deadline}}' || E'\n\n' ||
      'Notes: {{notes}}',
    '[
      {"key":"site","label":"Site","type":"text"},
      {"key":"post","label":"Post","type":"text"},
      {"key":"shift_date","label":"Date","type":"date"},
      {"key":"shift_time","label":"Time","type":"text"},
      {"key":"requirement","label":"Requirement","type":"select","options":["Unarmed guard","Armed guard"]},
      {"key":"response_deadline","label":"Response deadline","type":"text","placeholder":"ASAP"},
      {"key":"notes","label":"Notes","type":"textarea"}
    ]'::jsonb,
    array['guard']::public.app_role[],
    'requirement',
    40
  ),
  (
    'schedule_update',
    'Schedule update',
    'Use for supervisor-approved schedule updates that need clear acknowledgement.',
    'general',
    'Schedule update - {{site}} - {{shift_date}}',
    'A schedule update has been posted.' || E'\n\n' ||
      'Site: {{site}}' || E'\n' ||
      'Date: {{shift_date}}' || E'\n' ||
      'Update: {{update_summary}}' || E'\n\n' ||
      'Supervisor note: {{notes}}',
    '[
      {"key":"site","label":"Site","type":"text"},
      {"key":"shift_date","label":"Date","type":"date"},
      {"key":"update_summary","label":"Update summary","type":"textarea"},
      {"key":"notes","label":"Supervisor note","type":"textarea"}
    ]'::jsonb,
    array['guard','supervisor']::public.app_role[],
    null,
    50
  ),
  (
    'timekeeping_payroll_reminder',
    'Timekeeping/payroll reminder',
    'Use before payroll close to remind employees and supervisors to resolve time records.',
    'general',
    'Timekeeping reminder - {{pay_period}}',
    'Timekeeping records need to be reviewed before payroll close.' || E'\n\n' ||
      'Pay period: {{pay_period}}' || E'\n' ||
      'Deadline: {{deadline}}' || E'\n\n' ||
      'Reminder: {{notes}}',
    '[
      {"key":"pay_period","label":"Pay period","type":"text","placeholder":"July 1 - July 15"},
      {"key":"deadline","label":"Deadline","type":"text"},
      {"key":"notes","label":"Reminder","type":"textarea","placeholder":"Please resolve missing punches before payroll closes."}
    ]'::jsonb,
    array['guard','supervisor']::public.app_role[],
    null,
    60
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

create or replace function private.render_announcement_template(
  pattern text,
  fields jsonb
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  rendered text := pattern;
  field record;
begin
  for field in select key, value from jsonb_each_text(coalesce(fields, '{}'::jsonb))
  loop
    rendered := replace(rendered, '{{' || field.key || '}}', field.value);
  end loop;

  rendered := regexp_replace(rendered, '\{\{[a-zA-Z0-9_]+\}\}', '', 'g');
  return btrim(rendered);
end
$$;

create or replace function private.template_requires_armed(
  template public.announcement_templates,
  fields jsonb
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    template.requires_armed_field is not null
    and coalesce(fields ->> template.requires_armed_field, '') ~* 'armed'
    and coalesce(fields ->> template.requires_armed_field, '') !~* 'unarmed',
    false
  );
$$;

create or replace function private.count_announcement_recipients(
  roles public.app_role[],
  armed_required boolean
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(distinct employee.id)::integer
  from public.employees employee
  join private.employee_contacts contact on contact.employee_id = employee.id
  where employee.status = 'active'
    and employee.role = any(roles)
    and coalesce(contact.company_email, contact.personal_email) is not null
    and (not armed_required or public.has_valid_credential(employee.id, 'armed_guard', current_date));
$$;

create or replace function private.validate_template_fields(
  template public.announcement_templates,
  fields jsonb
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  required_field jsonb;
  field_key text;
begin
  if jsonb_typeof(coalesce(fields, '{}'::jsonb)) <> 'object' then
    raise check_violation using message = 'Template fields must be an object.';
  end if;

  for required_field in select value from jsonb_array_elements(template.required_fields)
  loop
    field_key := required_field ->> 'key';
    if field_key is null
      or btrim(coalesce(fields ->> field_key, '')) = ''
    then
      raise check_violation using message = 'Complete all required announcement details.';
    end if;
  end loop;
end
$$;

create or replace function public.get_announcement_composer()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not public.is_supervisor_or_admin() then
    raise insufficient_privilege using message = 'Only supervisors and admins can compose announcements.';
  end if;

  return jsonb_build_object(
    'role', public.current_app_role(),
    'hasMfa', public.has_mfa(),
    'templates', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'key', template.template_key,
        'name', template.name,
        'description', template.description,
        'kind', template.kind,
        'requiredFields', template.required_fields,
        'recipientRoles', template.recipient_roles,
        'displayOrder', template.display_order
      ) order by template.display_order, template.name), '[]'::jsonb)
      from public.announcement_templates template
      where template.is_active
    ),
    'recentAnnouncements', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', announcement.id,
        'templateKey', announcement.template_key,
        'title', announcement.title,
        'kind', announcement.kind,
        'publishedAt', announcement.published_at,
        'expiresAt', announcement.expires_at,
        'recipientRoles', announcement.recipient_roles,
        'requiresArmed', announcement.requires_armed,
        'createdBy', coalesce(author.preferred_name, author.first_name) || ' ' || author.last_name
      ) order by announcement.created_at desc), '[]'::jsonb)
      from (
        select *
        from public.announcements
        order by created_at desc
        limit 12
      ) announcement
      join public.employees author on author.id = announcement.created_by
    )
  );
end
$$;

create or replace function public.preview_announcement_template(
  target_template_key text,
  target_fields jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  template public.announcement_templates%rowtype;
  clean_fields jsonb := coalesce(target_fields, '{}'::jsonb);
  subject text;
  body text;
  armed_required boolean;
begin
  if not public.is_supervisor_or_admin() then
    raise insufficient_privilege using message = 'Only supervisors and admins can preview announcements.';
  end if;

  select * into template
  from public.announcement_templates
  where template_key = target_template_key
    and is_active;

  if not found then
    raise check_violation using message = 'Choose an approved announcement template.';
  end if;

  perform private.validate_template_fields(template, clean_fields);

  subject := private.render_announcement_template(template.subject_pattern, clean_fields);
  body := private.render_announcement_template(template.body_pattern, clean_fields);
  armed_required := private.template_requires_armed(template, clean_fields);

  return jsonb_build_object(
    'templateKey', template.template_key,
    'title', subject,
    'body', body,
    'kind', template.kind,
    'recipientRoles', template.recipient_roles,
    'requiresArmed', armed_required,
    'recipientCount', private.count_announcement_recipients(template.recipient_roles, armed_required)
  );
end
$$;

create or replace function public.publish_templated_announcement(
  target_template_key text,
  target_fields jsonb,
  target_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  publisher_id uuid := public.current_employee_id();
  template public.announcement_templates%rowtype;
  clean_fields jsonb := coalesce(target_fields, '{}'::jsonb);
  subject text;
  body text;
  armed_required boolean;
  recipient_count integer;
  announcement_id uuid;
begin
  if not (public.is_supervisor_or_admin() and public.has_mfa()) then
    raise insufficient_privilege using message = 'Supervisor or admin MFA is required to publish announcements.';
  end if;

  select * into template
  from public.announcement_templates
  where template_key = target_template_key
    and is_active;

  if not found then
    raise check_violation using message = 'Choose an approved announcement template.';
  end if;

  perform private.validate_template_fields(template, clean_fields);

  subject := private.render_announcement_template(template.subject_pattern, clean_fields);
  body := private.render_announcement_template(template.body_pattern, clean_fields);
  armed_required := private.template_requires_armed(template, clean_fields);
  recipient_count := private.count_announcement_recipients(template.recipient_roles, armed_required);

  if recipient_count <= 0 then
    raise check_violation using message = 'No eligible email recipients match this announcement.';
  end if;

  if char_length(subject) > 160 then
    raise check_violation using message = 'The generated announcement title is too long.';
  end if;

  if char_length(body) > 4000 then
    raise check_violation using message = 'The generated announcement body is too long.';
  end if;

  insert into public.announcements (
    kind,
    title,
    body,
    published_at,
    expires_at,
    created_by,
    template_key,
    template_fields,
    recipient_roles,
    requires_armed
  ) values (
    template.kind,
    subject,
    body,
    clock_timestamp(),
    target_expires_at,
    publisher_id,
    template.template_key,
    clean_fields,
    template.recipient_roles,
    armed_required
  )
  returning id into announcement_id;

  return jsonb_build_object(
    'id', announcement_id,
    'title', subject,
    'body', body,
    'kind', template.kind,
    'recipientRoles', template.recipient_roles,
    'requiresArmed', armed_required,
    'recipientCount', recipient_count
  );
end
$$;

create or replace function public.service_claim_notification_batch(target_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_limit integer := least(greatest(coalesce(target_limit, 10), 1), 25);
  claimed jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'Only the service role can claim notification deliveries.';
  end if;

  with pending as (
    select outbox.*
    from private.notification_outbox outbox
    where outbox.delivered_at is null
      and outbox.failed_at is null
      and outbox.available_at <= clock_timestamp()
      and outbox.attempt_count < 5
    order by outbox.available_at, outbox.created_at
    limit clean_limit
    for update skip locked
  ), touched as (
    update private.notification_outbox outbox
    set
      attempted_at = clock_timestamp(),
      attempt_count = outbox.attempt_count + 1,
      last_error = null
    from pending
    where outbox.id = pending.id
    returning outbox.*
  ), expanded as (
    select
      outbox.id,
      outbox.message_type,
      outbox.aggregate_type,
      outbox.aggregate_id,
      outbox.attempt_count,
      case
        when outbox.message_type = 'call_off_supervisor_alert' then (
          select jsonb_build_object(
            'subject', 'Call-off reported',
            'text', concat(
              coalesce(employee.preferred_name, employee.first_name), ' ', employee.last_name,
              ' reported a call-off. Open SygShift Requests to review and publish replacement coverage.'
            ),
            'html', concat(
              '<p><strong>', coalesce(employee.preferred_name, employee.first_name), ' ', employee.last_name,
              '</strong> reported a call-off.</p><p>Open SygShift Requests to review and publish replacement coverage.</p>'
            )
          )
          from public.call_off_reports report
          join public.employees employee on employee.id = report.employee_id
          where report.id = outbox.aggregate_id
        )
        when outbox.message_type = 'announcement_published' then (
          select jsonb_build_object(
            'subject', announcement.title,
            'text', announcement.body,
            'html', concat('<p>', replace(announcement.body, E'\n', '<br>'), '</p>')
          )
          from public.announcements announcement
          where announcement.id = outbox.aggregate_id
        )
        else jsonb_build_object(
          'subject', 'SygShift notification',
          'text', 'Open SygShift for details.',
          'html', '<p>Open SygShift for details.</p>'
        )
      end as message,
      case
        when outbox.message_type = 'call_off_supervisor_alert' then (
          select coalesce(jsonb_agg(distinct coalesce(contact.company_email, contact.personal_email)), '[]'::jsonb)
          from public.employees employee
          join private.employee_contacts contact on contact.employee_id = employee.id
          where employee.status = 'active'
            and employee.role in ('supervisor', 'admin')
            and coalesce(contact.company_email, contact.personal_email) is not null
        )
        when outbox.message_type = 'announcement_published' then (
          select coalesce(jsonb_agg(distinct coalesce(contact.company_email, contact.personal_email)), '[]'::jsonb)
          from public.announcements announcement
          left join public.shifts shift on shift.id = announcement.shift_id
          join public.employees employee on employee.status = 'active'
          join private.employee_contacts contact on contact.employee_id = employee.id
          where announcement.id = outbox.aggregate_id
            and employee.role = any(announcement.recipient_roles)
            and coalesce(contact.company_email, contact.personal_email) is not null
            and (
              coalesce(announcement.requires_armed, shift.requires_armed, false) is false
              or public.has_valid_credential(employee.id, 'armed_guard', current_date)
            )
        )
        else '[]'::jsonb
      end as recipients
    from touched outbox
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'messageType', message_type,
        'aggregateType', aggregate_type,
        'aggregateId', aggregate_id,
        'attemptCount', attempt_count,
        'recipients', recipients,
        'message', message
      )
      order by id
    ),
    '[]'::jsonb
  )
  into claimed
  from expanded;

  return claimed;
end
$$;

revoke all on function public.get_announcement_composer() from public, anon;
revoke all on function public.preview_announcement_template(text, jsonb) from public, anon;
revoke all on function public.publish_templated_announcement(text, jsonb, timestamptz) from public, anon;

grant execute on function public.get_announcement_composer() to authenticated;
grant execute on function public.preview_announcement_template(text, jsonb) to authenticated;
grant execute on function public.publish_templated_announcement(text, jsonb, timestamptz) to authenticated;

revoke all on function private.render_announcement_template(text, jsonb) from public, anon, authenticated;
revoke all on function private.template_requires_armed(public.announcement_templates, jsonb) from public, anon, authenticated;
revoke all on function private.count_announcement_recipients(public.app_role[], boolean) from public, anon, authenticated;
revoke all on function private.validate_template_fields(public.announcement_templates, jsonb) from public, anon, authenticated;
grant execute on all functions in schema private to service_role;

commit;
