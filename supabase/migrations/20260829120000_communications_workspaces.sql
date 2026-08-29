begin;

-- Communication work is intentionally separated from immutable published
-- announcements. This allows a draft to be reviewed, scheduled, or canceled
-- without exposing unfinished content to employees.
create table if not exists public.announcement_work_items (
  id uuid primary key default gen_random_uuid(),
  template_key text not null references public.announcement_templates(template_key) on delete restrict,
  template_fields jsonb not null default '{}'::jsonb,
  status text not null default 'draft',
  scheduled_for timestamptz,
  expires_at timestamptz,
  acknowledgment_required boolean not null default false,
  acknowledgment_due_at timestamptz,
  audience_mode text not null default 'roles',
  audience_roles public.app_role[] not null default array['guard']::public.app_role[],
  audience_post_ids uuid[] not null default '{}'::uuid[],
  delivery_channels text[] not null default array['email','employee_home']::text[],
  published_announcement_id uuid references public.announcements(id) on delete restrict,
  last_error text,
  created_by uuid not null references public.employees(id) on delete restrict,
  updated_by uuid not null references public.employees(id) on delete restrict,
  published_by uuid references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  published_at timestamptz,
  constraint announcement_work_items_fields_object check (jsonb_typeof(template_fields) = 'object'),
  constraint announcement_work_items_status check (status in ('draft','scheduled','published','canceled','failed')),
  constraint announcement_work_items_audience check (audience_mode in ('everyone','roles','sites','qualified','shift_eligible')),
  constraint announcement_work_items_roles_present check (audience_mode <> 'roles' or cardinality(audience_roles) > 0),
  constraint announcement_work_items_posts_present check (audience_mode <> 'sites' or cardinality(audience_post_ids) > 0),
  constraint announcement_work_items_channels check (
    cardinality(delivery_channels) > 0
    and delivery_channels <@ array['email','employee_home','workspace_alert']::text[]
  ),
  constraint announcement_work_items_schedule check (
    (status <> 'scheduled') or scheduled_for is not null
  ),
  constraint announcement_work_items_expiration check (
    expires_at is null or scheduled_for is null or expires_at > scheduled_for
  )
);

create index if not exists announcement_work_items_status_schedule_idx
  on public.announcement_work_items(status, scheduled_for, created_at desc);
create index if not exists announcement_work_items_creator_idx
  on public.announcement_work_items(created_by, created_at desc);

alter table public.announcements
  add column if not exists work_item_id uuid references public.announcement_work_items(id) on delete restrict,
  add column if not exists delivery_channels text[] not null default array['email','employee_home','workspace_alert']::text[],
  add column if not exists audience_mode text not null default 'roles';

alter table public.announcements
  drop constraint if exists announcements_delivery_channels_check,
  add constraint announcements_delivery_channels_check check (
    cardinality(delivery_channels) > 0
    and delivery_channels <@ array['email','employee_home','workspace_alert']::text[]
  ),
  drop constraint if exists announcements_audience_mode_check,
  add constraint announcements_audience_mode_check check (
    audience_mode in ('everyone','roles','sites','qualified','shift_eligible')
  );

create unique index if not exists announcements_work_item_unique
  on public.announcements(work_item_id)
  where work_item_id is not null;

create table if not exists private.announcement_recipient_snapshots (
  announcement_id uuid not null references public.announcements(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  email_enabled boolean not null default false,
  employee_home_enabled boolean not null default false,
  workspace_alert_enabled boolean not null default false,
  audience_mode text not null,
  captured_at timestamptz not null default clock_timestamp(),
  primary key (announcement_id, employee_id)
);

create index if not exists announcement_recipient_snapshots_employee_idx
  on private.announcement_recipient_snapshots(employee_id, captured_at desc);

create table if not exists private.notification_retry_events (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid references private.notification_outbox(id) on delete restrict,
  aggregate_type text,
  aggregate_id uuid,
  action text not null,
  affected_count integer not null,
  actor_id uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint notification_retry_events_action check (action in ('retry_one','retry_all')),
  constraint notification_retry_events_count check (affected_count >= 0)
);

alter table public.announcement_work_items enable row level security;
revoke all on table public.announcement_work_items from public, anon, authenticated;
revoke all on table private.announcement_recipient_snapshots from public, anon, authenticated;
revoke all on table private.notification_retry_events from public, anon, authenticated;

drop trigger if exists announcement_work_items_updated_at on public.announcement_work_items;
create trigger announcement_work_items_updated_at
before update on public.announcement_work_items
for each row execute function private.set_updated_at();

drop trigger if exists announcement_work_items_audit on public.announcement_work_items;
create trigger announcement_work_items_audit
after insert or update or delete on public.announcement_work_items
for each row execute function private.write_audit_event();

insert into public.announcement_templates (
  template_key, name, description, kind, subject_pattern, body_pattern,
  required_fields, recipient_roles, requires_armed_field, is_active, display_order
) values (
  'general_announcement',
  'General announcement',
  'Use for an approved company update that does not belong to another message type.',
  'general',
  '{{subject}}',
  '{{message}}',
  '[{"key":"subject","label":"Subject","type":"text","placeholder":"Clear announcement title"},{"key":"message","label":"Message","type":"textarea","placeholder":"Write the approved company message."}]'::jsonb,
  array['guard','dispatcher','scheduler','recruiting_licensing','supervisor','admin']::public.app_role[],
  null,
  true,
  5
)
on conflict (template_key) do update set
  name = excluded.name,
  description = excluded.description,
  subject_pattern = excluded.subject_pattern,
  body_pattern = excluded.body_pattern,
  required_fields = excluded.required_fields,
  recipient_roles = excluded.recipient_roles,
  is_active = true,
  display_order = excluded.display_order,
  updated_at = clock_timestamp();

create or replace function private.communication_audience_employee_ids(
  target_mode text,
  target_roles public.app_role[],
  target_post_ids uuid[],
  target_requires_armed boolean
)
returns table(employee_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct employee.id
  from public.employees employee
  where employee.status in ('active','leave')
    and (
      target_mode in ('everyone','qualified','shift_eligible')
      or (target_mode = 'roles' and employee.role = any(coalesce(target_roles, '{}'::public.app_role[])))
      or (
        target_mode = 'sites'
        and exists (
          select 1
          from public.shift_assignments assignment
          join public.shifts shift on shift.id = assignment.shift_id
          join public.posts post on post.id = shift.post_id
          where assignment.employee_id = employee.id
            and assignment.status <> 'canceled'
            and shift.canceled_at is null
            and shift.ends_at >= clock_timestamp()
            and (
              shift.post_id = any(coalesce(target_post_ids, '{}'::uuid[]))
              or post.site_id in (
                select selected_post.site_id
                from public.posts selected_post
                where selected_post.id = any(coalesce(target_post_ids, '{}'::uuid[]))
              )
            )
        )
      )
    )
    and (
      not target_requires_armed
      or public.has_valid_credential(employee.id, 'armed_guard', current_date)
    );
$$;

create or replace function private.communication_recipient_count(
  target_mode text,
  target_roles public.app_role[],
  target_post_ids uuid[],
  target_requires_armed boolean
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from private.communication_audience_employee_ids(
    target_mode, target_roles, target_post_ids, target_requires_armed
  );
$$;

create or replace function private.publish_announcement_work_item_internal(
  target_work_item_id uuid,
  target_actor_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  work_item public.announcement_work_items%rowtype;
  template public.announcement_templates%rowtype;
  subject text;
  body text;
  armed_required boolean;
  recipient_count integer;
  assignment_count integer := 0;
  announcement_id uuid := gen_random_uuid();
begin
  select item.* into work_item
  from public.announcement_work_items item
  where item.id = target_work_item_id
  for update;

  if work_item.id is null then
    raise no_data_found using message = 'The announcement draft could not be found.';
  end if;
  if work_item.status = 'published' then
    return jsonb_build_object('id', work_item.published_announcement_id, 'alreadyPublished', true);
  end if;
  if work_item.status not in ('draft','scheduled','failed') then
    raise check_violation using message = 'This announcement is not available to publish.';
  end if;

  select item.* into template
  from public.announcement_templates item
  where item.template_key = work_item.template_key and item.is_active;
  if template.template_key is null then
    raise check_violation using message = 'Choose an active approved announcement template.';
  end if;

  perform private.validate_template_fields(template, work_item.template_fields);
  subject := private.render_announcement_template(template.subject_pattern, work_item.template_fields);
  body := private.render_announcement_template(template.body_pattern, work_item.template_fields);
  armed_required := private.template_requires_armed(template, work_item.template_fields);
  recipient_count := private.communication_recipient_count(
    work_item.audience_mode,
    work_item.audience_roles,
    work_item.audience_post_ids,
    armed_required
  );
  if recipient_count <= 0 then
    raise check_violation using message = 'No active employees match this announcement audience.';
  end if;

  insert into public.announcements (
    id, kind, title, body, published_at, expires_at, created_by,
    template_key, template_fields, recipient_roles, requires_armed,
    root_announcement_id, content_version, acknowledgment_mode,
    acknowledgment_due_at, work_item_id, delivery_channels, audience_mode
  ) values (
    announcement_id, template.kind, subject, body, clock_timestamp(), work_item.expires_at,
    target_actor_id, template.template_key, work_item.template_fields,
    case when work_item.audience_mode = 'roles' then work_item.audience_roles else template.recipient_roles end,
    armed_required, announcement_id, 1,
    case when work_item.acknowledgment_required then 'required' else 'informational' end,
    case when work_item.acknowledgment_required then work_item.acknowledgment_due_at else null end,
    work_item.id, work_item.delivery_channels, work_item.audience_mode
  );

  insert into private.announcement_recipient_snapshots (
    announcement_id, employee_id, email_enabled, employee_home_enabled,
    workspace_alert_enabled, audience_mode
  )
  select
    announcement_id,
    audience.employee_id,
    'email' = any(work_item.delivery_channels),
    'employee_home' = any(work_item.delivery_channels),
    'workspace_alert' = any(work_item.delivery_channels),
    work_item.audience_mode
  from private.communication_audience_employee_ids(
    work_item.audience_mode,
    work_item.audience_roles,
    work_item.audience_post_ids,
    armed_required
  ) audience;

  if work_item.acknowledgment_required then
    assignment_count := private.assign_required_announcement(announcement_id);
  end if;

  if not ('email' = any(work_item.delivery_channels)) then
    update private.notification_outbox outbox
    set delivered_at = clock_timestamp(), last_error = 'Email delivery was not selected.'
    where outbox.message_type = 'announcement_published'
      and outbox.aggregate_id = announcement_id
      and outbox.delivered_at is null;
  end if;

  update public.announcement_work_items item
  set status = 'published', published_announcement_id = announcement_id,
      published_by = target_actor_id, published_at = clock_timestamp(),
      updated_by = target_actor_id, last_error = null
  where item.id = work_item.id;

  return jsonb_build_object(
    'id', announcement_id,
    'workItemId', work_item.id,
    'title', subject,
    'body', body,
    'kind', template.kind,
    'recipientCount', recipient_count,
    'assignmentCount', assignment_count,
    'deliveryChannels', work_item.delivery_channels,
    'publishedAt', clock_timestamp()
  );
exception when others then
  update public.announcement_work_items item
  set status = case when item.status = 'scheduled' then 'failed' else item.status end,
      last_error = sqlerrm,
      updated_at = clock_timestamp()
  where item.id = target_work_item_id;
  raise;
end;
$$;

create or replace function private.assign_required_announcement(target_announcement_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  announcement public.announcements%rowtype;
  inserted_count integer := 0;
  has_snapshot boolean := false;
begin
  select item.* into announcement
  from public.announcements item
  where item.id = target_announcement_id;
  if announcement.id is null or announcement.acknowledgment_mode <> 'required' then return 0; end if;

  update public.announcement_acknowledgments acknowledgment
  set status = 'superseded', superseded_at = clock_timestamp(), updated_at = clock_timestamp()
  where acknowledgment.root_announcement_id = announcement.root_announcement_id
    and acknowledgment.announcement_id <> announcement.id
    and acknowledgment.status <> 'superseded';

  select exists (
    select 1 from private.announcement_recipient_snapshots snapshot
    where snapshot.announcement_id = announcement.id
  ) into has_snapshot;

  insert into public.announcement_acknowledgments (
    announcement_id, root_announcement_id, employee_id, announcement_version,
    content_digest, title_snapshot, body_snapshot, due_at
  )
  select announcement.id, announcement.root_announcement_id, employee.id,
    announcement.content_version, announcement.content_digest, announcement.title,
    announcement.body, announcement.acknowledgment_due_at
  from public.employees employee
  where employee.status in ('active','leave')
    and (
      (has_snapshot and exists (
        select 1 from private.announcement_recipient_snapshots snapshot
        where snapshot.announcement_id = announcement.id and snapshot.employee_id = employee.id
      ))
      or (
        not has_snapshot
        and employee.role = any(announcement.recipient_roles)
        and (not announcement.requires_armed or public.has_valid_credential(employee.id, 'armed_guard', current_date))
      )
    )
  on conflict (announcement_id, employee_id) do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.save_announcement_work_item(
  target_work_item_id uuid,
  target_template_key text,
  target_fields jsonb,
  target_status text,
  target_scheduled_for timestamptz,
  target_expires_at timestamptz,
  target_acknowledgment_required boolean,
  target_acknowledgment_due_at timestamptz,
  target_audience_mode text,
  target_audience_roles public.app_role[],
  target_audience_post_ids uuid[],
  target_delivery_channels text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  template public.announcement_templates%rowtype;
  saved public.announcement_work_items%rowtype;
  armed_required boolean;
  recipient_count integer;
begin
  if actor_id is null or not public.has_effective_permission('announcements.send') or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified announcement send permission is required.';
  end if;
  if coalesce(target_status, 'draft') not in ('draft','scheduled') then
    raise check_violation using message = 'Choose Save draft or Schedule.';
  end if;
  if target_status = 'scheduled' and (target_scheduled_for is null or target_scheduled_for <= clock_timestamp()) then
    raise check_violation using message = 'Scheduled delivery must be in the future.';
  end if;
  if target_acknowledgment_required and not public.has_effective_permission('announcements.acknowledgments.manage') then
    raise insufficient_privilege using message = 'Announcement acknowledgment permission is required.';
  end if;

  select item.* into template from public.announcement_templates item
  where item.template_key = target_template_key and item.is_active
    and item.template_key <> 'welcome_to_sygshift';
  if template.template_key is null then raise check_violation using message = 'Choose an approved template.'; end if;
  armed_required := private.template_requires_armed(template, coalesce(target_fields, '{}'::jsonb));
  recipient_count := private.communication_recipient_count(
    coalesce(target_audience_mode, 'roles'),
    coalesce(target_audience_roles, template.recipient_roles),
    coalesce(target_audience_post_ids, '{}'::uuid[]),
    armed_required
  );
  -- Drafts intentionally allow incomplete template fields and an audience that is
  -- still being assembled. Scheduled work must be fully publishable now so the
  -- service cannot encounter a preventable validation failure later.
  if target_status = 'scheduled' then
    perform private.validate_template_fields(template, coalesce(target_fields, '{}'::jsonb));
    if recipient_count <= 0 then
      raise check_violation using message = 'No active employees match this audience.';
    end if;
  end if;

  if target_work_item_id is null then
    insert into public.announcement_work_items (
      template_key, template_fields, status, scheduled_for, expires_at,
      acknowledgment_required, acknowledgment_due_at, audience_mode,
      audience_roles, audience_post_ids, delivery_channels, created_by, updated_by
    ) values (
      template.template_key, coalesce(target_fields, '{}'::jsonb), target_status,
      case when target_status = 'scheduled' then target_scheduled_for else null end,
      target_expires_at, coalesce(target_acknowledgment_required, false),
      case when target_acknowledgment_required then target_acknowledgment_due_at else null end,
      coalesce(target_audience_mode, 'roles'),
      coalesce(target_audience_roles, template.recipient_roles),
      coalesce(target_audience_post_ids, '{}'::uuid[]),
      coalesce(target_delivery_channels, array['email','employee_home']::text[]),
      actor_id, actor_id
    ) returning * into saved;
  else
    update public.announcement_work_items item
    set template_key = template.template_key,
        template_fields = coalesce(target_fields, '{}'::jsonb),
        status = target_status,
        scheduled_for = case when target_status = 'scheduled' then target_scheduled_for else null end,
        expires_at = target_expires_at,
        acknowledgment_required = coalesce(target_acknowledgment_required, false),
        acknowledgment_due_at = case when target_acknowledgment_required then target_acknowledgment_due_at else null end,
        audience_mode = coalesce(target_audience_mode, 'roles'),
        audience_roles = coalesce(target_audience_roles, template.recipient_roles),
        audience_post_ids = coalesce(target_audience_post_ids, '{}'::uuid[]),
        delivery_channels = coalesce(target_delivery_channels, array['email','employee_home']::text[]),
        updated_by = actor_id,
        last_error = null
    where item.id = target_work_item_id and item.status in ('draft','scheduled','failed')
    returning * into saved;
    if saved.id is null then raise check_violation using message = 'This draft is no longer editable.'; end if;
  end if;

  return jsonb_build_object(
    'id', saved.id, 'status', saved.status, 'scheduledFor', saved.scheduled_for,
    'recipientCount', recipient_count, 'updatedAt', saved.updated_at
  );
end;
$$;

create or replace function public.preview_announcement_work_item(
  target_template_key text,
  target_fields jsonb,
  target_audience_mode text,
  target_audience_roles public.app_role[],
  target_audience_post_ids uuid[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  template public.announcement_templates%rowtype;
  armed_required boolean;
begin
  if actor_id is null or not public.has_effective_permission('announcements.send') or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified announcement send permission is required.';
  end if;
  select item.* into template
  from public.announcement_templates item
  where item.template_key = target_template_key
    and item.is_active
    and item.template_key <> 'welcome_to_sygshift';
  if template.template_key is null then
    raise check_violation using message = 'Choose an approved template.';
  end if;
  perform private.validate_template_fields(template, coalesce(target_fields, '{}'::jsonb));
  armed_required := private.template_requires_armed(template, coalesce(target_fields, '{}'::jsonb));
  return jsonb_build_object(
    'templateKey', template.template_key,
    'title', private.render_announcement_template(template.subject_pattern, target_fields),
    'body', private.render_announcement_template(template.body_pattern, target_fields),
    'kind', template.kind,
    'recipientRoles', coalesce(target_audience_roles, template.recipient_roles),
    'requiresArmed', armed_required,
    'recipientCount', private.communication_recipient_count(
      coalesce(target_audience_mode, 'roles'),
      coalesce(target_audience_roles, template.recipient_roles),
      coalesce(target_audience_post_ids, '{}'::uuid[]),
      armed_required
    )
  );
end;
$$;

create or replace function public.publish_announcement_work_item(target_work_item_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id();
begin
  if actor_id is null or not public.has_effective_permission('announcements.send') or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified announcement send permission is required.';
  end if;
  return private.publish_announcement_work_item_internal(target_work_item_id, actor_id);
end;
$$;

create or replace function public.cancel_announcement_work_item(target_work_item_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id(); affected integer;
begin
  if actor_id is null or not public.has_effective_permission('announcements.send') or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified announcement send permission is required.';
  end if;
  update public.announcement_work_items item
  set status = 'canceled', updated_by = actor_id, scheduled_for = null
  where item.id = target_work_item_id and item.status in ('draft','scheduled','failed');
  get diagnostics affected = row_count;
  if affected = 0 then raise check_violation using message = 'This item cannot be canceled.'; end if;
  return jsonb_build_object('id', target_work_item_id, 'status', 'canceled');
end;
$$;

create or replace function public.service_publish_due_announcement_work_items(target_limit integer default 25)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare item record; published integer := 0; failed integer := 0;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role is required.'; end if;
  for item in
    select work.id, work.created_by
    from public.announcement_work_items work
    where work.status = 'scheduled' and work.scheduled_for <= clock_timestamp()
    order by work.scheduled_for, work.created_at
    limit least(greatest(coalesce(target_limit, 25), 1), 50)
    for update skip locked
  loop
    begin
      perform private.publish_announcement_work_item_internal(item.id, item.created_by);
      published := published + 1;
    exception when others then
      update public.announcement_work_items work
      set status = 'failed', last_error = sqlerrm, updated_at = clock_timestamp()
      where work.id = item.id;
      failed := failed + 1;
    end;
  end loop;
  return jsonb_build_object('published', published, 'failed', failed);
end;
$$;

create or replace function public.get_communications_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id();
begin
  if actor_id is null or not public.has_effective_permission('announcements.send') then
    raise insufficient_privilege using message = 'Announcement workspace access is required.';
  end if;
  return jsonb_build_object(
    'permissions', jsonb_build_object(
      'canSend', public.has_effective_permission('announcements.send'),
      'canManageAcknowledgments', public.has_effective_permission('announcements.acknowledgments.manage'),
      'canManageBanners', public.has_effective_permission('announcements.banner.manage'),
      'hasMfa', public.has_mfa()
    ),
    'summary', jsonb_build_object(
      'activeBanners', (select count(*) from public.announcement_banners banner where banner.active and banner.starts_at <= clock_timestamp() and (banner.expires_at is null or banner.expires_at > clock_timestamp())),
      'draftsScheduled', (select count(*) from public.announcement_work_items item where item.status in ('draft','scheduled','failed')),
      'awaitingAcknowledgment', (select count(*) from public.announcement_acknowledgments item where item.status in ('pending','viewed'))
    ),
    'templates', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'key', template.template_key, 'name', template.name, 'description', template.description,
        'kind', template.kind, 'requiredFields', template.required_fields,
        'recipientRoles', template.recipient_roles, 'displayOrder', template.display_order
      ) order by template.display_order, template.name), '[]'::jsonb)
      from public.announcement_templates template
      where template.is_active and template.template_key <> 'welcome_to_sygshift'
    ),
    'sites', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', site.id,
        'code', site.code,
        'name', site.name,
        'posts', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', post.id, 'name', post.name, 'requiresArmed', post.requires_armed
          ) order by post.name)
          from public.posts post
          where post.site_id = site.id and post.active
        ), '[]'::jsonb)
      ) order by site.name), '[]'::jsonb)
      from public.sites site
      where site.active
    ),
    'roles', (select jsonb_agg(value order by value) from unnest(enum_range(null::public.app_role)) value),
    'posts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', post.id, 'label', concat(site.name, ' — ', post.name),
        'siteName', site.name, 'postName', post.name, 'requiresArmed', post.requires_armed
      ) order by site.name, post.name), '[]'::jsonb)
      from public.posts post join public.sites site on site.id = post.site_id
      where post.active and site.active
    ),
    'overview', jsonb_build_object(
      'active', (
        select coalesce(jsonb_agg(row_data order by row_data->>'publishedAt' desc), '[]'::jsonb)
        from (
          select jsonb_build_object('id', announcement.id, 'title', announcement.title, 'publishedAt', announcement.published_at, 'expiresAt', announcement.expires_at, 'kind', announcement.kind) row_data
          from public.announcements announcement
          where announcement.published_at <= clock_timestamp() and (announcement.expires_at is null or announcement.expires_at > clock_timestamp())
          order by announcement.published_at desc limit 3
        ) rows
      ),
      'drafts', (
        select coalesce(jsonb_agg(row_data order by row_data->>'updatedAt' desc), '[]'::jsonb)
        from (
          select jsonb_build_object('id', item.id, 'templateKey', item.template_key, 'status', item.status, 'scheduledFor', item.scheduled_for, 'updatedAt', item.updated_at, 'lastError', item.last_error) row_data
          from public.announcement_work_items item
          where item.status in ('draft','scheduled','failed')
          order by item.updated_at desc limit 3
        ) rows
      ),
      'recent', (
        select coalesce(jsonb_agg(row_data order by row_data->>'publishedAt' desc), '[]'::jsonb)
        from (
          select jsonb_build_object('id', announcement.id, 'title', announcement.title, 'publishedAt', announcement.published_at, 'kind', announcement.kind) row_data
          from public.announcements announcement
          where announcement.published_at is not null
          order by announcement.published_at desc limit 3
        ) rows
      )
    )
  );
end;
$$;

create or replace function public.get_announcement_work_items(
  target_status text default null,
  target_search text default null,
  target_page integer default 1,
  target_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare clean_page integer := greatest(coalesce(target_page,1),1); clean_size integer := least(greatest(coalesce(target_page_size,10),5),20); total_count integer;
begin
  if not public.has_effective_permission('announcements.send') then raise insufficient_privilege using message = 'Announcement workspace access is required.'; end if;
  select count(*) into total_count from public.announcement_work_items item
  join public.announcement_templates template on template.template_key = item.template_key
  where (target_status is null or target_status = 'all' or item.status = target_status)
    and (nullif(btrim(coalesce(target_search,'')),'') is null or template.name ilike '%'||btrim(target_search)||'%' or item.template_fields::text ilike '%'||btrim(target_search)||'%');
  return jsonb_build_object(
    'page', jsonb_build_object('number',clean_page,'size',clean_size,'total',total_count,'totalPages',greatest(ceil(total_count::numeric/clean_size)::integer,1)),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', item.id, 'templateKey', item.template_key, 'templateName', template.name,
        'templateFields', item.template_fields, 'status', item.status,
        'scheduledFor', item.scheduled_for, 'expiresAt', item.expires_at,
        'acknowledgmentRequired', item.acknowledgment_required,
        'acknowledgmentDueAt', item.acknowledgment_due_at,
        'audienceMode', item.audience_mode, 'audienceRoles', item.audience_roles,
        'audiencePostIds', item.audience_post_ids, 'deliveryChannels', item.delivery_channels,
        'publishedAnnouncementId', item.published_announcement_id,
        'lastError', item.last_error, 'updatedAt', item.updated_at,
        'createdBy', concat(coalesce(nullif(author.preferred_name,''),author.first_name),' ',author.last_name)
      ) order by item.updated_at desc), '[]'::jsonb)
      from (
        select work.* from public.announcement_work_items work
        join public.announcement_templates list_template on list_template.template_key = work.template_key
        where (target_status is null or target_status = 'all' or work.status = target_status)
          and (nullif(btrim(coalesce(target_search,'')),'') is null or list_template.name ilike '%'||btrim(target_search)||'%' or work.template_fields::text ilike '%'||btrim(target_search)||'%')
        order by work.updated_at desc
        limit clean_size offset (clean_page-1)*clean_size
      ) item
      join public.announcement_templates template on template.template_key = item.template_key
      join public.employees author on author.id = item.created_by
    )
  );
end;
$$;

create or replace function public.get_announcement_history(
  target_search text default null,
  target_page integer default 1,
  target_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare clean_page integer := greatest(coalesce(target_page,1),1); clean_size integer := least(greatest(coalesce(target_page_size,10),5),20); total_count integer;
begin
  if not public.has_effective_permission('announcements.send') then raise insufficient_privilege using message = 'Announcement history access is required.'; end if;
  select count(*) into total_count from public.announcements item
  where item.published_at is not null
    and (nullif(btrim(coalesce(target_search,'')),'') is null or item.title ilike '%'||btrim(target_search)||'%' or item.body ilike '%'||btrim(target_search)||'%');
  return jsonb_build_object(
    'page', jsonb_build_object('number',clean_page,'size',clean_size,'total',total_count,'totalPages',greatest(ceil(total_count::numeric/clean_size)::integer,1)),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', item.id, 'title', item.title, 'body', item.body, 'kind', item.kind,
        'publishedAt', item.published_at, 'expiresAt', item.expires_at,
        'deliveryChannels', item.delivery_channels, 'audienceMode', item.audience_mode,
        'recipientCount', (select count(*) from private.announcement_recipient_snapshots snapshot where snapshot.announcement_id = item.id),
        'acknowledgedCount', (select count(*) from public.announcement_acknowledgments ack where ack.announcement_id = item.id and ack.status = 'acknowledged'),
        'awaitingCount', (select count(*) from public.announcement_acknowledgments ack where ack.announcement_id = item.id and ack.status in ('pending','viewed')),
        'createdBy', concat(coalesce(nullif(author.preferred_name,''),author.first_name),' ',author.last_name)
      ) order by item.published_at desc), '[]'::jsonb)
      from (
        select announcement.* from public.announcements announcement
        where announcement.published_at is not null
          and (nullif(btrim(coalesce(target_search,'')),'') is null or announcement.title ilike '%'||btrim(target_search)||'%' or announcement.body ilike '%'||btrim(target_search)||'%')
        order by announcement.published_at desc
        limit clean_size offset (clean_page-1)*clean_size
      ) item join public.employees author on author.id = item.created_by
    )
  );
end;
$$;

create or replace function private.announcement_visible_to_current_user(announcement public.announcements)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.employees employee
    where employee.id = private.current_employee_id()
      and employee.status in ('active','leave')
      and announcement.published_at is not null
      and announcement.published_at <= clock_timestamp()
      and (announcement.expires_at is null or announcement.expires_at > clock_timestamp())
      and (
        exists (
          select 1 from private.announcement_recipient_snapshots snapshot
          where snapshot.announcement_id = announcement.id
            and snapshot.employee_id = employee.id
            and (snapshot.employee_home_enabled or snapshot.workspace_alert_enabled)
        )
        or (
          not exists (select 1 from private.announcement_recipient_snapshots snapshot where snapshot.announcement_id = announcement.id)
          and employee.role = any(announcement.recipient_roles)
          and (not announcement.requires_armed or public.has_valid_credential(employee.id,'armed_guard',current_date))
        )
      )
  );
$$;

drop function if exists public.get_notification_center();
create function public.get_notification_center(
  target_status text default 'all',
  target_search text default null,
  target_date_from date default null,
  target_date_through date default null,
  target_page integer default 1,
  target_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare clean_page integer := greatest(coalesce(target_page,1),1); clean_size integer := least(greatest(coalesce(target_page_size,10),5),20); total_count integer;
begin
  if not public.has_effective_permission('notifications.manage') or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified notification management permission is required.';
  end if;
  with grouped as (
    select outbox.aggregate_type, outbox.aggregate_id, outbox.message_type,
      min(outbox.id::text)::uuid id, count(*)::integer recipient_count,
      max(outbox.created_at) created_at, max(outbox.available_at) available_at,
      max(outbox.delivered_at) delivered_at, max(outbox.failed_at) failed_at,
      max(outbox.attempt_count) attempt_count,
      string_agg(distinct nullif(outbox.last_error,''), '; ') last_error,
      case when bool_or(outbox.failed_at is not null) then 'failed' when bool_and(outbox.delivered_at is not null) then 'delivered' else 'queued' end status
    from private.notification_outbox outbox
    group by outbox.aggregate_type, outbox.aggregate_id, outbox.message_type
  ), filtered as (
    select * from grouped item
    where (target_status = 'all' or item.status = target_status)
      and (target_date_from is null or item.created_at >= target_date_from::timestamptz)
      and (target_date_through is null or item.created_at < (target_date_through + 1)::timestamptz)
      and (nullif(btrim(coalesce(target_search,'')),'') is null or replace(item.message_type,'_',' ') ilike '%'||btrim(target_search)||'%' or item.aggregate_type ilike '%'||btrim(target_search)||'%')
  ) select count(*) into total_count from filtered;

  return jsonb_build_object(
    'permissions', jsonb_build_object('canManage', true),
    'summary',(
      with grouped_status as (
        select case
          when bool_or(outbox.failed_at is not null) then 'failed'
          when bool_and(outbox.delivered_at is not null) then 'delivered'
          else 'queued'
        end status
        from private.notification_outbox outbox
        group by outbox.aggregate_type, outbox.aggregate_id, outbox.message_type
      )
      select jsonb_build_object(
        'pending', count(*) filter (where status = 'queued'),
        'delivered', count(*) filter (where status = 'delivered'),
        'failed', count(*) filter (where status = 'failed')
      )
      from grouped_status
    ),
    'page',jsonb_build_object('number',clean_page,'size',clean_size,'total',total_count,'totalPages',greatest(ceil(total_count::numeric/clean_size)::integer,1)),
    'batches',(
      with grouped as (
        select outbox.aggregate_type, outbox.aggregate_id, outbox.message_type,
          min(outbox.id::text)::uuid id, count(*)::integer recipient_count,
          max(outbox.created_at) created_at, max(outbox.available_at) available_at,
          max(outbox.delivered_at) delivered_at, max(outbox.failed_at) failed_at,
          max(outbox.attempt_count) attempt_count,
          string_agg(distinct nullif(outbox.last_error,''), '; ') last_error,
          case when bool_or(outbox.failed_at is not null) then 'failed' when bool_and(outbox.delivered_at is not null) then 'delivered' else 'queued' end status
        from private.notification_outbox outbox
        group by outbox.aggregate_type, outbox.aggregate_id, outbox.message_type
      )
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', item.id, 'messageType', item.message_type, 'aggregateType', item.aggregate_type,
        'aggregateId', item.aggregate_id, 'subject', coalesce(announcement.title, replace(initcap(replace(item.message_type,'_',' ')),'Published','Update')),
        'status', item.status, 'recipientCount', case when item.message_type='announcement_published' then coalesce(snapshot.count, item.recipient_count) else item.recipient_count end,
        'attemptCount', item.attempt_count, 'availableAt', item.available_at,
        'createdAt', item.created_at, 'deliveredAt', item.delivered_at,
        'failedAt', item.failed_at, 'lastError', item.last_error,
        'channels', jsonb_build_array('Email')
      ) order by item.created_at desc), '[]'::jsonb)
      from (
        select grouped.* from grouped
        where (target_status = 'all' or grouped.status = target_status)
          and (target_date_from is null or grouped.created_at >= target_date_from::timestamptz)
          and (target_date_through is null or grouped.created_at < (target_date_through + 1)::timestamptz)
          and (nullif(btrim(coalesce(target_search,'')),'') is null or replace(grouped.message_type,'_',' ') ilike '%'||btrim(target_search)||'%' or grouped.aggregate_type ilike '%'||btrim(target_search)||'%')
        order by grouped.created_at desc limit clean_size offset (clean_page-1)*clean_size
      ) item
      left join public.announcements announcement on item.aggregate_type='announcement' and announcement.id=item.aggregate_id
      left join lateral (select count(*)::integer count from private.announcement_recipient_snapshots snapshot where snapshot.announcement_id=item.aggregate_id and snapshot.email_enabled) snapshot on true
    )
  );
end;
$$;

create or replace function public.retry_notification_job(target_outbox_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id(); row_record private.notification_outbox%rowtype; affected integer;
begin
  if actor_id is null or not public.has_effective_permission('notifications.manage') or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified notification management permission is required.';
  end if;
  select * into row_record from private.notification_outbox where id=target_outbox_id;
  if row_record.id is null then raise no_data_found using message = 'The notification job could not be found.'; end if;
  update private.notification_outbox outbox
  set failed_at=null, delivered_at=null, attempted_at=null, attempt_count=0,
      last_error=null, available_at=clock_timestamp()
  where outbox.aggregate_type=row_record.aggregate_type
    and outbox.aggregate_id is not distinct from row_record.aggregate_id
    and outbox.message_type=row_record.message_type;
  get diagnostics affected=row_count;
  insert into private.notification_retry_events(outbox_id,aggregate_type,aggregate_id,action,affected_count,actor_id)
  values(row_record.id,row_record.aggregate_type,row_record.aggregate_id,'retry_one',affected,actor_id);
  return jsonb_build_object('retried',affected);
end;
$$;

create or replace function public.retry_all_failed_notifications()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id(); affected integer;
begin
  if actor_id is null or not public.has_effective_permission('notifications.manage') or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified notification management permission is required.';
  end if;
  update private.notification_outbox outbox
  set failed_at=null, delivered_at=null, attempted_at=null, attempt_count=0,
      last_error=null, available_at=clock_timestamp()
  where outbox.failed_at is not null;
  get diagnostics affected=row_count;
  insert into private.notification_retry_events(aggregate_type,action,affected_count,actor_id)
  values('all','retry_all',affected,actor_id);
  return jsonb_build_object('retried',affected);
end;
$$;

create or replace function public.service_get_announcement_email_recipients(target_announcement_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare recipients text[];
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  select coalesce(
    array_agg(distinct private.preferred_delivery_email(contact.personal_email, contact.company_email))
      filter (where private.preferred_delivery_email(contact.personal_email, contact.company_email) is not null),
    array[]::text[]
  )
  into recipients
  from private.announcement_recipient_snapshots snapshot
  join private.employee_contacts contact on contact.employee_id = snapshot.employee_id
  where snapshot.announcement_id = target_announcement_id
    and snapshot.email_enabled;

  return recipients;
end;
$$;

revoke all on function private.communication_audience_employee_ids(text,public.app_role[],uuid[],boolean) from public,anon,authenticated;
revoke all on function private.communication_recipient_count(text,public.app_role[],uuid[],boolean) from public,anon,authenticated;
revoke all on function private.publish_announcement_work_item_internal(uuid,uuid) from public,anon,authenticated;
revoke all on function public.save_announcement_work_item(uuid,text,jsonb,text,timestamptz,timestamptz,boolean,timestamptz,text,public.app_role[],uuid[],text[]) from public,anon;
revoke all on function public.preview_announcement_work_item(text,jsonb,text,public.app_role[],uuid[]) from public,anon;
revoke all on function public.publish_announcement_work_item(uuid) from public,anon;
revoke all on function public.cancel_announcement_work_item(uuid) from public,anon;
revoke all on function public.service_publish_due_announcement_work_items(integer) from public,anon,authenticated;
revoke all on function public.get_communications_workspace() from public,anon;
revoke all on function public.get_announcement_work_items(text,text,integer,integer) from public,anon;
revoke all on function public.get_announcement_history(text,integer,integer) from public,anon;
revoke all on function public.get_notification_center(text,text,date,date,integer,integer) from public,anon;
revoke all on function public.retry_notification_job(uuid) from public,anon;
revoke all on function public.retry_all_failed_notifications() from public,anon;
revoke all on function public.service_get_announcement_email_recipients(uuid) from public,anon,authenticated;
grant execute on function public.save_announcement_work_item(uuid,text,jsonb,text,timestamptz,timestamptz,boolean,timestamptz,text,public.app_role[],uuid[],text[]) to authenticated;
grant execute on function public.preview_announcement_work_item(text,jsonb,text,public.app_role[],uuid[]) to authenticated;
grant execute on function public.publish_announcement_work_item(uuid) to authenticated;
grant execute on function public.cancel_announcement_work_item(uuid) to authenticated;
grant execute on function public.service_publish_due_announcement_work_items(integer) to service_role;
grant execute on function public.get_communications_workspace() to authenticated;
grant execute on function public.get_announcement_work_items(text,text,integer,integer) to authenticated;
grant execute on function public.get_announcement_history(text,integer,integer) to authenticated;
grant execute on function public.get_notification_center(text,text,date,date,integer,integer) to authenticated;
grant execute on function public.retry_notification_job(uuid) to authenticated;
grant execute on function public.retry_all_failed_notifications() to authenticated;
grant execute on function public.service_get_announcement_email_recipients(uuid) to service_role;

notify pgrst, 'reload schema';
commit;
