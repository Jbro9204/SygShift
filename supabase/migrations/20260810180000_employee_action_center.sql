begin;

set search_path = '';

-- Employee Action Center permissions remain configurable through the existing
-- Roles & Permissions workspace. Self-service access is deliberately non-MFA;
-- management and exports require an MFA-verified session.
insert into public.permission_catalog (
  code,
  category,
  name,
  description,
  risk_level,
  requires_mfa,
  locked,
  active
)
values
  ('actions.self.view', 'Employee Actions', 'View own action center', 'View and complete assigned announcements, training, and schedule acknowledgments.', 'standard', false, true, true),
  ('announcements.acknowledgments.manage', 'Announcements', 'Manage announcement acknowledgments', 'Require, revise, and report employee announcement acknowledgments.', 'sensitive', true, false, true),
  ('training.view', 'Training', 'View assigned training', 'View and complete assigned training content.', 'standard', false, true, true),
  ('training.manage', 'Training', 'Manage training', 'Create versioned training content and assign it to employees.', 'critical', true, false, true),
  ('training.export', 'Training', 'Export training records', 'Export employee training assignment and completion records.', 'sensitive', true, false, true),
  ('schedule.acknowledgments.manage', 'Schedule', 'Manage schedule acknowledgments', 'Review acknowledgment status for published employee schedules.', 'sensitive', true, false, true)
on conflict (code) do update
set
  category = excluded.category,
  name = excluded.name,
  description = excluded.description,
  risk_level = excluded.risk_level,
  requires_mfa = excluded.requires_mfa,
  active = true,
  updated_at = now();

with self_roles(role_code) as (
  values
    ('system_guard'),
    ('system_dispatcher'),
    ('system_scheduler'),
    ('system_recruiting_licensing'),
    ('system_supervisor'),
    ('system_admin')
), self_permissions(permission_code) as (
  values ('actions.self.view'), ('training.view')
)
insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, permission.permission_code, true
from self_roles seed
join public.access_roles role on role.code = seed.role_code
cross join self_permissions permission
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = now();

with management_permissions(role_code, permission_code) as (
  values
    ('system_scheduler', 'schedule.acknowledgments.manage'),
    ('system_supervisor', 'schedule.acknowledgments.manage'),
    ('system_admin', 'schedule.acknowledgments.manage'),
    ('system_admin', 'announcements.acknowledgments.manage'),
    ('system_admin', 'training.manage'),
    ('system_admin', 'training.export')
)
insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, seed.permission_code, true
from management_permissions seed
join public.access_roles role on role.code = seed.role_code
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = now();

-- Required employee announcements are a versioned extension of the existing
-- announcement delivery lane. Informational announcements continue unchanged.
alter table public.announcements
  add column if not exists root_announcement_id uuid references public.announcements(id) on delete restrict,
  add column if not exists supersedes_announcement_id uuid references public.announcements(id) on delete restrict,
  add column if not exists content_version integer not null default 1,
  add column if not exists acknowledgment_mode text not null default 'informational',
  add column if not exists acknowledgment_due_at timestamptz,
  add column if not exists content_digest text;

update public.announcements announcement
set
  root_announcement_id = announcement.id,
  content_digest = encode(
    extensions.digest(
      convert_to(announcement.title || E'\n' || announcement.body, 'UTF8'),
      'sha256'
    ),
    'hex'
  )
where announcement.root_announcement_id is null
   or announcement.content_digest is null;

alter table public.announcements
  alter column root_announcement_id set not null,
  alter column content_digest set not null,
  drop constraint if exists announcements_acknowledgment_mode_check,
  add constraint announcements_acknowledgment_mode_check
    check (acknowledgment_mode in ('informational', 'required')),
  drop constraint if exists announcements_content_version_positive,
  add constraint announcements_content_version_positive check (content_version > 0),
  drop constraint if exists announcements_content_digest_format,
  add constraint announcements_content_digest_format check (content_digest ~ '^[a-f0-9]{64}$');

create index if not exists announcements_root_version_idx
  on public.announcements(root_announcement_id, content_version desc);

create or replace function private.apply_announcement_version_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.root_announcement_id := coalesce(new.root_announcement_id, new.id);
  new.content_version := greatest(coalesce(new.content_version, 1), 1);
  new.content_digest := encode(
    extensions.digest(convert_to(new.title || E'\n' || new.body, 'UTF8'), 'sha256'),
    'hex'
  );
  return new;
end;
$$;

drop trigger if exists announcements_apply_version_defaults on public.announcements;
create trigger announcements_apply_version_defaults
before insert or update of title, body on public.announcements
for each row execute function private.apply_announcement_version_defaults();

create table public.announcement_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.announcements(id) on delete restrict,
  root_announcement_id uuid not null references public.announcements(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  announcement_version integer not null,
  content_digest text not null,
  title_snapshot text not null,
  body_snapshot text not null,
  assigned_at timestamptz not null default clock_timestamp(),
  due_at timestamptz,
  viewed_at timestamptz,
  acknowledged_at timestamptz,
  status text not null default 'pending',
  superseded_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint announcement_acknowledgments_unique unique (announcement_id, employee_id),
  constraint announcement_acknowledgments_version_positive check (announcement_version > 0),
  constraint announcement_acknowledgments_digest_format check (content_digest ~ '^[a-f0-9]{64}$'),
  constraint announcement_acknowledgments_status_check check (status in ('pending', 'viewed', 'acknowledged', 'superseded')),
  constraint announcement_acknowledgments_snapshot_present check (btrim(title_snapshot) <> '' and btrim(body_snapshot) <> '')
);

create index announcement_acknowledgments_employee_status_idx
  on public.announcement_acknowledgments(employee_id, status, due_at);
create index announcement_acknowledgments_announcement_status_idx
  on public.announcement_acknowledgments(announcement_id, status);

alter table public.announcement_acknowledgments enable row level security;
revoke all on table public.announcement_acknowledgments from public, anon, authenticated;

create trigger announcement_acknowledgments_updated_at
before update on public.announcement_acknowledgments
for each row execute function private.set_updated_at();

create trigger announcement_acknowledgments_audit
after insert or update on public.announcement_acknowledgments
for each row execute function private.write_audit_event();

create or replace function private.assign_required_announcement(
  target_announcement_id uuid
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  announcement public.announcements%rowtype;
  inserted_count integer := 0;
begin
  select item.* into announcement
  from public.announcements item
  where item.id = target_announcement_id;

  if announcement.id is null or announcement.acknowledgment_mode <> 'required' then
    return 0;
  end if;

  update public.announcement_acknowledgments acknowledgment
  set
    status = 'superseded',
    superseded_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where acknowledgment.root_announcement_id = announcement.root_announcement_id
    and acknowledgment.announcement_id <> announcement.id
    and acknowledgment.status <> 'superseded';

  insert into public.announcement_acknowledgments (
    announcement_id,
    root_announcement_id,
    employee_id,
    announcement_version,
    content_digest,
    title_snapshot,
    body_snapshot,
    due_at
  )
  select
    announcement.id,
    announcement.root_announcement_id,
    employee.id,
    announcement.content_version,
    announcement.content_digest,
    announcement.title,
    announcement.body,
    announcement.acknowledgment_due_at
  from public.employees employee
  where employee.status in ('active', 'leave')
    and employee.role = any(announcement.recipient_roles)
    and (
      not announcement.requires_armed
      or exists (
        select 1
        from public.employee_credentials credential
        where credential.employee_id = employee.id
          and credential.kind = 'armed_guard'
          and credential.status = 'active'
          and (credential.expires_on is null or credential.expires_on >= current_date)
      )
    )
  on conflict (announcement_id, employee_id) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.set_announcement_acknowledgment_requirement(
  target_announcement_id uuid,
  target_required boolean,
  target_due_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  announcement public.announcements%rowtype;
  assignment_count integer := 0;
begin
  if actor_id is null
     or not public.has_effective_permission('announcements.acknowledgments.manage')
     or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified announcement acknowledgment permission is required.';
  end if;

  select item.* into announcement
  from public.announcements item
  where item.id = target_announcement_id
  for update;

  if announcement.id is null then
    raise no_data_found using message = 'The announcement could not be found.';
  end if;

  update public.announcements item
  set
    acknowledgment_mode = case when target_required then 'required' else 'informational' end,
    acknowledgment_due_at = case when target_required then target_due_at else null end,
    content_digest = encode(
      extensions.digest(convert_to(item.title || E'\n' || item.body, 'UTF8'), 'sha256'),
      'hex'
    ),
    updated_at = clock_timestamp()
  where item.id = target_announcement_id
  returning * into announcement;

  if target_required then
    assignment_count := private.assign_required_announcement(announcement.id);
  else
    update public.announcement_acknowledgments acknowledgment
    set
      status = 'superseded',
      superseded_at = clock_timestamp(),
      updated_at = clock_timestamp()
    where acknowledgment.announcement_id = announcement.id
      and acknowledgment.status <> 'superseded';
  end if;

  return jsonb_build_object(
    'announcementId', announcement.id,
    'mode', announcement.acknowledgment_mode,
    'dueAt', announcement.acknowledgment_due_at,
    'assignmentCount', assignment_count
  );
end;
$$;

-- Publish the announcement and its acknowledgment requirement in one database
-- transaction. This prevents an email-visible announcement from being left in
-- an unintended informational state if recipient assignment fails.
create or replace function public.publish_templated_announcement_with_acknowledgment(
  target_template_key text,
  target_fields jsonb,
  target_expires_at timestamptz default null,
  target_required boolean default false,
  target_due_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  publication jsonb;
  requirement jsonb;
begin
  publication := public.publish_templated_announcement(
    target_template_key,
    target_fields,
    target_expires_at
  );

  if target_required then
    requirement := public.set_announcement_acknowledgment_requirement(
      (publication ->> 'id')::uuid,
      true,
      target_due_at
    );
  else
    requirement := jsonb_build_object('assignmentCount', 0);
  end if;

  return publication || jsonb_build_object(
    'contentVersion', 1,
    'assignmentCount', coalesce((requirement ->> 'assignmentCount')::integer, 0)
  );
end;
$$;

create or replace function public.revise_templated_announcement(
  target_announcement_id uuid,
  target_fields jsonb,
  target_expires_at timestamptz default null,
  target_required boolean default false,
  target_due_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  requested public.announcements%rowtype;
  latest public.announcements%rowtype;
  template public.announcement_templates%rowtype;
  clean_fields jsonb := coalesce(target_fields, '{}'::jsonb);
  subject text;
  body text;
  armed_required boolean;
  recipient_count integer;
  next_id uuid := gen_random_uuid();
  assignment_count integer := 0;
begin
  if actor_id is null or not public.has_effective_permission('announcements.send') or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified announcement send permission is required.';
  end if;

  if target_required and not public.has_effective_permission('announcements.acknowledgments.manage') then
    raise insufficient_privilege using message = 'Announcement acknowledgment permission is required.';
  end if;

  select item.* into requested
  from public.announcements item
  where item.id = target_announcement_id;

  if requested.id is null or requested.template_key is null then
    raise no_data_found using message = 'The announcement version could not be found.';
  end if;

  -- Lock the stable root row so two editors cannot publish the same next version.
  perform 1
  from public.announcements item
  where item.id = requested.root_announcement_id
  for update;

  select item.* into latest
  from public.announcements item
  where item.root_announcement_id = requested.root_announcement_id
  order by item.content_version desc, item.created_at desc
  limit 1;

  if latest.id is distinct from requested.id then
    raise serialization_failure using message = 'A newer announcement version already exists. Reload before revising it.';
  end if;

  select item.* into template
  from public.announcement_templates item
  where item.template_key = requested.template_key
    and item.is_active
    and item.template_key <> 'welcome_to_sygshift';

  if template.template_key is null then
    raise check_violation using message = 'The approved announcement template is no longer available.';
  end if;

  perform private.validate_template_fields(template, clean_fields);
  subject := private.render_announcement_template(template.subject_pattern, clean_fields);
  body := private.render_announcement_template(template.body_pattern, clean_fields);
  armed_required := private.template_requires_armed(template, clean_fields);
  recipient_count := private.count_announcement_recipients(template.recipient_roles, armed_required);

  if recipient_count <= 0 then
    raise check_violation using message = 'No eligible email recipients match this announcement.';
  end if;

  insert into public.announcements (
    id,
    kind,
    title,
    body,
    published_at,
    expires_at,
    created_by,
    template_key,
    template_fields,
    recipient_roles,
    requires_armed,
    root_announcement_id,
    supersedes_announcement_id,
    content_version,
    acknowledgment_mode,
    acknowledgment_due_at
  ) values (
    next_id,
    template.kind,
    subject,
    body,
    clock_timestamp(),
    target_expires_at,
    actor_id,
    template.template_key,
    clean_fields,
    template.recipient_roles,
    armed_required,
    requested.root_announcement_id,
    requested.id,
    requested.content_version + 1,
    case when target_required then 'required' else 'informational' end,
    case when target_required then target_due_at else null end
  );

  if target_required then
    assignment_count := private.assign_required_announcement(next_id);
  else
    update public.announcement_acknowledgments acknowledgment
    set status = 'superseded',
        superseded_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where acknowledgment.root_announcement_id = requested.root_announcement_id
      and acknowledgment.status <> 'superseded';
  end if;

  return jsonb_build_object(
    'id', next_id,
    'templateKey', template.template_key,
    'title', subject,
    'body', body,
    'kind', template.kind,
    'recipientRoles', template.recipient_roles,
    'requiresArmed', armed_required,
    'recipientCount', recipient_count,
    'contentVersion', requested.content_version + 1,
    'assignmentCount', assignment_count
  );
end;
$$;

create or replace function public.get_announcement_composer()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  can_view boolean := private.has_effective_permission_without_mfa('announcements.view')
    or private.has_effective_permission_without_mfa('announcements.send')
    or private.has_effective_permission_without_mfa('announcements.banner.manage');
  can_send boolean := private.has_effective_permission_without_mfa('announcements.send');
  can_manage_banner boolean := private.has_effective_permission_without_mfa('announcements.banner.manage');
begin
  if private.current_employee_id() is null or not can_view then
    raise insufficient_privilege using message = 'Announcements permission is required.';
  end if;

  return jsonb_build_object(
    'role', public.current_app_role(),
    'hasMfa', public.has_mfa(),
    'canSend', can_send,
    'canManageBanner', can_manage_banner,
    'activeBanner', public.get_active_announcement_banner(),
    'activeBanners', public.get_active_announcement_banners(),
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
        and template.template_key <> 'welcome_to_sygshift'
        and can_send
    ),
    'recentAnnouncements', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', announcement.id,
        'rootAnnouncementId', announcement.root_announcement_id,
        'contentVersion', announcement.content_version,
        'templateKey', announcement.template_key,
        'templateFields', announcement.template_fields,
        'title', announcement.title,
        'body', announcement.body,
        'kind', announcement.kind,
        'publishedAt', announcement.published_at,
        'expiresAt', announcement.expires_at,
        'recipientRoles', announcement.recipient_roles,
        'requiresArmed', announcement.requires_armed,
        'acknowledgmentMode', announcement.acknowledgment_mode,
        'acknowledgmentDueAt', announcement.acknowledgment_due_at,
        'createdBy', coalesce(author.preferred_name, author.first_name) || ' ' || author.last_name
      ) order by announcement.created_at desc), '[]'::jsonb)
      from (
        select item.*
        from public.announcements item
        where coalesce(item.template_key, '') <> 'welcome_to_sygshift'
          and not exists (
            select 1
            from public.announcements newer
            where newer.root_announcement_id = item.root_announcement_id
              and newer.content_version > item.content_version
          )
        order by item.created_at desc
        limit 12
      ) announcement
      join public.employees author on author.id = announcement.created_by
    )
  );
end;
$$;

-- Training is modeled as a stable course plus immutable published versions.
create table public.training_courses (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  description text,
  active boolean not null default true,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint training_courses_code_format check (code ~ '^[A-Z][A-Z0-9_-]{2,39}$'),
  constraint training_courses_title_present check (btrim(title) <> '')
);

create table public.training_course_versions (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.training_courses(id) on delete restrict,
  version_number integer not null,
  title text not null,
  description text,
  content_type text not null,
  content_url text,
  instructions text,
  effective_on date not null default current_date,
  default_due_days integer,
  completion_rule text not null default 'employee_attestation',
  requires_acknowledgment boolean not null default true,
  content_digest text not null,
  supersedes_version_id uuid references public.training_course_versions(id) on delete restrict,
  published_at timestamptz not null default clock_timestamp(),
  published_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint training_course_versions_unique unique (course_id, version_number),
  constraint training_course_versions_positive check (version_number > 0),
  constraint training_course_versions_title_present check (btrim(title) <> ''),
  constraint training_course_versions_type_check check (content_type in ('document', 'video', 'external_link', 'written')),
  constraint training_course_versions_completion_rule_check check (completion_rule in ('employee_attestation', 'administrator_verification')),
  constraint training_course_versions_content_present check (content_url is not null or btrim(coalesce(instructions, '')) <> ''),
  constraint training_course_versions_due_days_check check (default_due_days is null or default_due_days between 0 and 3650),
  constraint training_course_versions_digest_format check (content_digest ~ '^[a-f0-9]{64}$')
);

create table public.training_assignments (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.training_courses(id) on delete restrict,
  version_id uuid not null references public.training_course_versions(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  assigned_at timestamptz not null default clock_timestamp(),
  assigned_by uuid not null references public.employees(id) on delete restrict,
  due_at timestamptz,
  viewed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  completion_attestation text,
  completed_by uuid references public.employees(id) on delete restrict,
  status text not null default 'assigned',
  superseded_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint training_assignments_unique unique (version_id, employee_id),
  constraint training_assignments_status_check check (status in ('assigned', 'in_progress', 'completed', 'superseded')),
  constraint training_assignments_attestation_check check (completion_attestation is null or btrim(completion_attestation) <> '')
);

create index training_assignments_employee_status_idx
  on public.training_assignments(employee_id, status, due_at);
create index training_assignments_course_idx
  on public.training_assignments(course_id, version_id, status);

alter table public.training_courses enable row level security;
alter table public.training_course_versions enable row level security;
alter table public.training_assignments enable row level security;
revoke all on table public.training_courses from public, anon, authenticated;
revoke all on table public.training_course_versions from public, anon, authenticated;
revoke all on table public.training_assignments from public, anon, authenticated;

create trigger training_courses_updated_at
before update on public.training_courses
for each row execute function private.set_updated_at();
create trigger training_assignments_updated_at
before update on public.training_assignments
for each row execute function private.set_updated_at();

create trigger training_courses_audit
after insert or update or delete on public.training_courses
for each row execute function private.write_audit_event();
create trigger training_course_versions_audit
after insert on public.training_course_versions
for each row execute function private.write_audit_event();
create trigger training_assignments_audit
after insert or update on public.training_assignments
for each row execute function private.write_audit_event();

create trigger training_course_versions_append_only
before update or delete on public.training_course_versions
for each row execute function private.prevent_append_only_change();

create or replace function public.publish_training_version(
  target_course_id uuid,
  target_code text,
  target_title text,
  target_description text,
  target_content_type text,
  target_content_url text,
  target_instructions text,
  target_effective_on date,
  target_due_at timestamptz,
  target_employee_ids uuid[] default array[]::uuid[],
  target_roles public.app_role[] default array[]::public.app_role[],
  target_site_ids uuid[] default array[]::uuid[],
  target_states text[] default array[]::text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  course public.training_courses%rowtype;
  prior_version public.training_course_versions%rowtype;
  new_version public.training_course_versions%rowtype;
  next_version integer;
  clean_code text := upper(btrim(coalesce(target_code, '')));
  clean_title text := btrim(coalesce(target_title, ''));
  clean_description text := nullif(btrim(coalesce(target_description, '')), '');
  clean_url text := nullif(btrim(coalesce(target_content_url, '')), '');
  clean_instructions text := nullif(btrim(coalesce(target_instructions, '')), '');
  clean_states text[];
  content_fingerprint text;
  assignment_count integer := 0;
begin
  if actor_id is null or not public.has_effective_permission('training.manage') or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified training management permission is required.';
  end if;

  if clean_code !~ '^[A-Z][A-Z0-9_-]{2,39}$' then
    raise check_violation using message = 'Training code must contain 3 to 40 letters, numbers, dashes, or underscores.';
  end if;
  if clean_title = '' then
    raise check_violation using message = 'Training title is required.';
  end if;
  if target_content_type not in ('document', 'video', 'external_link', 'written') then
    raise check_violation using message = 'Choose a supported training content type.';
  end if;
  if clean_url is null and clean_instructions is null then
    raise check_violation using message = 'Add training instructions or a content link.';
  end if;
  if coalesce(cardinality(target_employee_ids), 0)
     + coalesce(cardinality(target_roles), 0)
     + coalesce(cardinality(target_site_ids), 0)
     + coalesce(cardinality(target_states), 0) = 0 then
    raise check_violation using message = 'Select at least one employee, role, site, or state audience.';
  end if;

  clean_states := array(
    select distinct upper(btrim(state_value))
    from unnest(coalesce(target_states, array[]::text[])) state_value
    where btrim(state_value) <> ''
  );

  if target_course_id is null then
    insert into public.training_courses (code, title, description, created_by)
    values (clean_code, clean_title, clean_description, actor_id)
    returning * into course;
  else
    select item.* into course
    from public.training_courses item
    where item.id = target_course_id
    for update;

    if course.id is null then
      raise no_data_found using message = 'The training item could not be found.';
    end if;

    update public.training_courses item
    set title = clean_title,
        description = clean_description,
        active = true,
        updated_at = clock_timestamp()
    where item.id = course.id
    returning * into course;
  end if;

  select version.* into prior_version
  from public.training_course_versions version
  where version.course_id = course.id
  order by version.version_number desc
  limit 1;

  next_version := coalesce(prior_version.version_number, 0) + 1;
  content_fingerprint := encode(
    extensions.digest(
      convert_to(
        concat_ws(E'\n', clean_title, clean_description, target_content_type, clean_url, clean_instructions, target_effective_on::text),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  insert into public.training_course_versions (
    course_id,
    version_number,
    title,
    description,
    content_type,
    content_url,
    instructions,
    effective_on,
    requires_acknowledgment,
    content_digest,
    supersedes_version_id,
    published_by
  ) values (
    course.id,
    next_version,
    clean_title,
    clean_description,
    target_content_type,
    clean_url,
    clean_instructions,
    coalesce(target_effective_on, current_date),
    true,
    content_fingerprint,
    prior_version.id,
    actor_id
  )
  returning * into new_version;

  if prior_version.id is not null then
    update public.training_assignments assignment
    set
      status = 'superseded',
      superseded_at = clock_timestamp(),
      updated_at = clock_timestamp()
    where assignment.course_id = course.id
      and assignment.version_id = prior_version.id
      and assignment.status <> 'superseded';
  end if;

  with eligible_employee as (
    select distinct employee.id
    from public.employees employee
    left join private.employee_contacts contact on contact.employee_id = employee.id
    where employee.status in ('active', 'leave')
      and (
        employee.id = any(coalesce(target_employee_ids, array[]::uuid[]))
        or employee.role = any(coalesce(target_roles, array[]::public.app_role[]))
        or upper(coalesce(contact.region, '')) = any(clean_states)
        or exists (
          select 1
          from public.shift_assignments assignment
          join public.shifts shift on shift.id = assignment.shift_id
          join public.schedules schedule on schedule.id = shift.schedule_id
          left join public.posts post on post.id = shift.post_id
          left join public.events event on event.id = shift.event_id
          where assignment.employee_id = employee.id
            and assignment.status in ('assigned', 'confirmed', 'completed')
            and schedule.status = 'published'
            and shift.ends_at >= clock_timestamp()
            and coalesce(post.site_id, event.site_id) = any(coalesce(target_site_ids, array[]::uuid[]))
        )
      )
  )
  insert into public.training_assignments (
    course_id,
    version_id,
    employee_id,
    assigned_by,
    due_at
  )
  select course.id, new_version.id, eligible_employee.id, actor_id, target_due_at
  from eligible_employee
  on conflict (version_id, employee_id) do nothing;

  get diagnostics assignment_count = row_count;

  return jsonb_build_object(
    'courseId', course.id,
    'versionId', new_version.id,
    'versionNumber', new_version.version_number,
    'assignmentCount', assignment_count
  );
end;
$$;

create or replace function public.get_training_catalog()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null or not public.has_effective_permission('training.manage') or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified training management permission is required.';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'courseId', course.id,
      'code', course.code,
      'title', version.title,
      'description', version.description,
      'contentType', version.content_type,
      'contentUrl', version.content_url,
      'instructions', version.instructions,
      'effectiveOn', version.effective_on,
      'currentVersionId', version.id,
      'currentVersion', version.version_number,
      'active', course.active,
      'updatedAt', course.updated_at
    ) order by version.title, course.code)
    from public.training_courses course
    join lateral (
      select published.*
      from public.training_course_versions published
      where published.course_id = course.id
      order by published.version_number desc
      limit 1
    ) version on true
  ), '[]'::jsonb);
end;
$$;

-- Published schedule acknowledgments store the exact employee slice, not just
-- a pointer to a mutable schedule UI.
create table public.schedule_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  schedule_id uuid not null references public.schedules(id) on delete restrict,
  week_starts_on date not null,
  schedule_revision integer not null,
  shifts_snapshot jsonb not null,
  shifts_digest text not null,
  published_at timestamptz not null,
  assigned_at timestamptz not null default clock_timestamp(),
  viewed_at timestamptz,
  acknowledged_at timestamptz,
  status text not null default 'pending',
  superseded_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint schedule_acknowledgments_unique unique (schedule_id, employee_id),
  constraint schedule_acknowledgments_status_check check (status in ('pending', 'viewed', 'acknowledged', 'superseded')),
  constraint schedule_acknowledgments_snapshot_array check (jsonb_typeof(shifts_snapshot) = 'array'),
  constraint schedule_acknowledgments_digest_format check (shifts_digest ~ '^[a-f0-9]{64}$')
);

create index schedule_acknowledgments_employee_status_idx
  on public.schedule_acknowledgments(employee_id, status, week_starts_on desc);
create index schedule_acknowledgments_week_status_idx
  on public.schedule_acknowledgments(week_starts_on desc, status);

alter table public.schedule_acknowledgments enable row level security;
revoke all on table public.schedule_acknowledgments from public, anon, authenticated;

create trigger schedule_acknowledgments_updated_at
before update on public.schedule_acknowledgments
for each row execute function private.set_updated_at();
create trigger schedule_acknowledgments_audit
after insert or update on public.schedule_acknowledgments
for each row execute function private.write_audit_event();

create or replace function private.create_schedule_acknowledgments(target_schedule_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  schedule_record public.schedules%rowtype;
  employee_record record;
  snapshot jsonb;
  fingerprint text;
  prior_acknowledgment public.schedule_acknowledgments%rowtype;
  inserted_count integer := 0;
begin
  select schedule.* into schedule_record
  from public.schedules schedule
  where schedule.id = target_schedule_id
    and schedule.status = 'published';

  if schedule_record.id is null then
    return 0;
  end if;

  for employee_record in
    select distinct employee.id
    from public.employees employee
    join public.shift_assignments assignment on assignment.employee_id = employee.id
    join public.shifts shift on shift.id = assignment.shift_id
    where shift.schedule_id = schedule_record.id
      and employee.status in ('active', 'leave')
      and employee.employment_type in ('hourly', 'flex')
      and assignment.status in ('assigned', 'confirmed', 'completed')
      and shift.canceled_at is null
  loop
    select coalesce(jsonb_agg(jsonb_build_object(
      'shiftId', shift.id,
      'startsAt', shift.starts_at,
      'endsAt', shift.ends_at,
      'timeZone', shift.time_zone,
      'siteCode', site.code,
      'siteName', site.name,
      'postName', post.name,
      'eventName', event.name,
      'requiresArmed', shift.requires_armed,
      'isOvertime', shift.is_overtime
    ) order by shift.starts_at, shift.ends_at, shift.id), '[]'::jsonb)
    into snapshot
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    left join public.posts post on post.id = shift.post_id
    left join public.events event on event.id = shift.event_id
    left join public.sites site on site.id = coalesce(post.site_id, event.site_id)
    where shift.schedule_id = schedule_record.id
      and assignment.employee_id = employee_record.id
      and assignment.status in ('assigned', 'confirmed', 'completed')
      and shift.canceled_at is null;

    fingerprint := encode(extensions.digest(convert_to(snapshot::text, 'UTF8'), 'sha256'), 'hex');

    select acknowledgment.* into prior_acknowledgment
    from public.schedule_acknowledgments acknowledgment
    where acknowledgment.employee_id = employee_record.id
      and acknowledgment.week_starts_on = schedule_record.week_starts_on
      and acknowledgment.status <> 'superseded'
    order by acknowledgment.schedule_revision desc, acknowledgment.created_at desc
    limit 1
    for update;

    if prior_acknowledgment.id is not null and prior_acknowledgment.shifts_digest = fingerprint then
      continue;
    end if;

    if prior_acknowledgment.id is not null then
      update public.schedule_acknowledgments acknowledgment
      set
        status = 'superseded',
        superseded_at = clock_timestamp(),
        updated_at = clock_timestamp()
      where acknowledgment.id = prior_acknowledgment.id;
    end if;

    insert into public.schedule_acknowledgments (
      employee_id,
      schedule_id,
      week_starts_on,
      schedule_revision,
      shifts_snapshot,
      shifts_digest,
      published_at
    ) values (
      employee_record.id,
      schedule_record.id,
      schedule_record.week_starts_on,
      schedule_record.revision,
      snapshot,
      fingerprint,
      schedule_record.published_at
    )
    on conflict (schedule_id, employee_id) do nothing;

    inserted_count := inserted_count + 1;
  end loop;

  return inserted_count;
end;
$$;

create or replace function private.schedule_acknowledgment_publish_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform private.create_schedule_acknowledgments(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists schedules_create_acknowledgments on public.schedules;
create trigger schedules_create_acknowledgments
after insert or update of status on public.schedules
for each row execute function private.schedule_acknowledgment_publish_trigger();

-- One query supplies a concise employee action queue while preserving record
-- type boundaries and histories behind the scenes.
create or replace function public.get_employee_action_center()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  announcement_items jsonb;
  training_items jsonb;
  schedule_items jsonb;
begin
  if actor_id is null or not public.has_effective_permission('actions.self.view') then
    raise insufficient_privilege using message = 'Employee Action Center access is required.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', acknowledgment.id,
    'announcementId', acknowledgment.announcement_id,
    'version', acknowledgment.announcement_version,
    'title', acknowledgment.title_snapshot,
    'body', acknowledgment.body_snapshot,
    'assignedAt', acknowledgment.assigned_at,
    'dueAt', acknowledgment.due_at,
    'viewedAt', acknowledgment.viewed_at,
    'acknowledgedAt', acknowledgment.acknowledged_at,
    'status', acknowledgment.status
  ) order by acknowledgment.assigned_at desc), '[]'::jsonb)
  into announcement_items
  from public.announcement_acknowledgments acknowledgment
  where acknowledgment.employee_id = actor_id
    and acknowledgment.status <> 'superseded';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', assignment.id,
    'courseId', course.id,
    'versionId', version.id,
    'version', version.version_number,
    'title', version.title,
    'description', version.description,
    'contentType', version.content_type,
    'contentUrl', version.content_url,
    'instructions', version.instructions,
    'effectiveOn', version.effective_on,
    'assignedAt', assignment.assigned_at,
    'dueAt', assignment.due_at,
    'viewedAt', assignment.viewed_at,
    'completedAt', assignment.completed_at,
    'status', case
      when assignment.status in ('assigned', 'in_progress') and assignment.due_at < clock_timestamp() then 'overdue'
      else assignment.status
    end
  ) order by assignment.due_at nulls last, assignment.assigned_at desc), '[]'::jsonb)
  into training_items
  from public.training_assignments assignment
  join public.training_courses course on course.id = assignment.course_id
  join public.training_course_versions version on version.id = assignment.version_id
  where assignment.employee_id = actor_id
    and assignment.status <> 'superseded';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', acknowledgment.id,
    'scheduleId', acknowledgment.schedule_id,
    'weekStartsOn', acknowledgment.week_starts_on,
    'scheduleRevision', acknowledgment.schedule_revision,
    'shifts', acknowledgment.shifts_snapshot,
    'publishedAt', acknowledgment.published_at,
    'viewedAt', acknowledgment.viewed_at,
    'acknowledgedAt', acknowledgment.acknowledged_at,
    'status', acknowledgment.status
  ) order by acknowledgment.week_starts_on desc, acknowledgment.schedule_revision desc), '[]'::jsonb)
  into schedule_items
  from public.schedule_acknowledgments acknowledgment
  where acknowledgment.employee_id = actor_id
    and acknowledgment.status <> 'superseded';

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'summary', jsonb_build_object(
      'announcementCount', (select count(*) from public.announcement_acknowledgments item where item.employee_id = actor_id and item.status in ('pending', 'viewed')),
      'trainingCount', (select count(*) from public.training_assignments item where item.employee_id = actor_id and item.status in ('assigned', 'in_progress')),
      'scheduleCount', (select count(*) from public.schedule_acknowledgments item where item.employee_id = actor_id and item.status in ('pending', 'viewed'))
    ),
    'announcements', announcement_items,
    'training', training_items,
    'schedules', schedule_items
  );
end;
$$;

create or replace function public.mark_employee_action_viewed(
  target_action_type text,
  target_action_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if target_action_type = 'announcement' then
    update public.announcement_acknowledgments item
    set viewed_at = coalesce(item.viewed_at, clock_timestamp()),
        status = case when item.status = 'pending' then 'viewed' else item.status end,
        updated_at = clock_timestamp()
    where item.id = target_action_id
      and item.employee_id = actor_id
      and item.status <> 'superseded';
  elsif target_action_type = 'training' then
    update public.training_assignments item
    set viewed_at = coalesce(item.viewed_at, clock_timestamp()),
        started_at = coalesce(item.started_at, clock_timestamp()),
        status = case when item.status = 'assigned' then 'in_progress' else item.status end,
        updated_at = clock_timestamp()
    where item.id = target_action_id
      and item.employee_id = actor_id
      and item.status <> 'superseded';
  elsif target_action_type = 'schedule' then
    update public.schedule_acknowledgments item
    set viewed_at = coalesce(item.viewed_at, clock_timestamp()),
        status = case when item.status = 'pending' then 'viewed' else item.status end,
        updated_at = clock_timestamp()
    where item.id = target_action_id
      and item.employee_id = actor_id
      and item.status <> 'superseded';
  else
    raise check_violation using message = 'Choose a supported employee action type.';
  end if;

  if not found then
    raise no_data_found using message = 'The selected employee action is no longer available.';
  end if;

  return public.get_employee_action_center();
end;
$$;

create or replace function public.complete_employee_action(
  target_action_type text,
  target_action_id uuid,
  target_attestation text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_attestation text := nullif(btrim(coalesce(target_attestation, '')), '');
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if target_action_type = 'announcement' then
    update public.announcement_acknowledgments item
    set viewed_at = coalesce(item.viewed_at, clock_timestamp()),
        acknowledged_at = clock_timestamp(),
        status = 'acknowledged',
        updated_at = clock_timestamp()
    where item.id = target_action_id
      and item.employee_id = actor_id
      and item.status in ('pending', 'viewed');
  elsif target_action_type = 'training' then
    if clean_attestation is null then
      raise check_violation using message = 'Confirm that you completed and reviewed this training.';
    end if;
    update public.training_assignments item
    set viewed_at = coalesce(item.viewed_at, clock_timestamp()),
        started_at = coalesce(item.started_at, clock_timestamp()),
        completed_at = clock_timestamp(),
        completed_by = actor_id,
        completion_attestation = clean_attestation,
        status = 'completed',
        updated_at = clock_timestamp()
    where item.id = target_action_id
      and item.employee_id = actor_id
      and item.status in ('assigned', 'in_progress');
  elsif target_action_type = 'schedule' then
    update public.schedule_acknowledgments item
    set viewed_at = coalesce(item.viewed_at, clock_timestamp()),
        acknowledged_at = clock_timestamp(),
        status = 'acknowledged',
        updated_at = clock_timestamp()
    where item.id = target_action_id
      and item.employee_id = actor_id
      and item.status in ('pending', 'viewed');
  else
    raise check_violation using message = 'Choose a supported employee action type.';
  end if;

  if not found then
    raise no_data_found using message = 'This employee action was already completed or is no longer current.';
  end if;

  return public.get_employee_action_center();
end;
$$;

create or replace function public.get_employee_action_compliance_report()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null or not public.has_mfa() or not (
    public.has_effective_permission('announcements.acknowledgments.manage')
    or public.has_effective_permission('training.manage')
    or public.has_effective_permission('schedule.acknowledgments.manage')
  ) then
    raise insufficient_privilege using message = 'MFA-verified employee action reporting permission is required.';
  end if;

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'announcements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', acknowledgment.id,
        'employeeId', employee.id,
        'employeeName', btrim(concat_ws(' ', employee.first_name, employee.last_name)),
        'title', acknowledgment.title_snapshot,
        'version', acknowledgment.announcement_version,
        'assignedAt', acknowledgment.assigned_at,
        'viewedAt', acknowledgment.viewed_at,
        'acknowledgedAt', acknowledgment.acknowledged_at,
        'status', acknowledgment.status
      ) order by acknowledgment.assigned_at desc, employee.last_name, employee.first_name)
      from public.announcement_acknowledgments acknowledgment
      join public.employees employee on employee.id = acknowledgment.employee_id
    ), '[]'::jsonb),
    'training', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', assignment.id,
        'employeeId', employee.id,
        'employeeName', btrim(concat_ws(' ', employee.first_name, employee.last_name)),
        'title', version.title,
        'version', version.version_number,
        'assignedAt', assignment.assigned_at,
        'dueAt', assignment.due_at,
        'completedAt', assignment.completed_at,
        'attestation', assignment.completion_attestation,
        'status', case when assignment.status in ('assigned', 'in_progress') and assignment.due_at < clock_timestamp() then 'overdue' else assignment.status end
      ) order by assignment.assigned_at desc, employee.last_name, employee.first_name)
      from public.training_assignments assignment
      join public.training_courses course on course.id = assignment.course_id
      join public.training_course_versions version on version.id = assignment.version_id
      join public.employees employee on employee.id = assignment.employee_id
    ), '[]'::jsonb),
    'schedules', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', acknowledgment.id,
        'employeeId', employee.id,
        'employeeName', btrim(concat_ws(' ', employee.first_name, employee.last_name)),
        'weekStartsOn', acknowledgment.week_starts_on,
        'scheduleRevision', acknowledgment.schedule_revision,
        'publishedAt', acknowledgment.published_at,
        'acknowledgedAt', acknowledgment.acknowledged_at,
        'status', acknowledgment.status
      ) order by acknowledgment.week_starts_on desc, employee.last_name, employee.first_name)
      from public.schedule_acknowledgments acknowledgment
      join public.employees employee on employee.id = acknowledgment.employee_id
    ), '[]'::jsonb)
  );
end;
$$;

-- California Baton Permit uses the existing sensitive, audited credential and
-- document workflows. Presence is tracked; it never declares legal eligibility.
insert into public.credential_types (
  code,
  legacy_kind,
  name,
  category,
  description,
  issuing_authority,
  expiration_required,
  affects_work_eligibility,
  warning_days,
  renewal_instructions,
  employee_email_instructions,
  active
)
values (
  'ca_baton_permit',
  'other',
  'California Baton Permit',
  'State Permit',
  'Tracks a California baton permit record and verification. This record alone does not establish assignment eligibility.',
  null,
  true,
  false,
  array[90, 60, 30, 14, 7],
  'Confirm company policy and applicable California requirements before assignment decisions.',
  'Provide a current permit copy and renewal information to the Recruiting and Licensing Coordinator.',
  true
)
on conflict (code) do update
set
  name = excluded.name,
  category = excluded.category,
  description = excluded.description,
  expiration_required = excluded.expiration_required,
  affects_work_eligibility = excluded.affects_work_eligibility,
  warning_days = excluded.warning_days,
  renewal_instructions = excluded.renewal_instructions,
  employee_email_instructions = excluded.employee_email_instructions,
  active = true,
  updated_at = now();

revoke all on function private.assign_required_announcement(uuid) from public, anon, authenticated;
revoke all on function private.apply_announcement_version_defaults() from public, anon, authenticated;
revoke all on function private.create_schedule_acknowledgments(uuid) from public, anon, authenticated;
revoke all on function private.schedule_acknowledgment_publish_trigger() from public, anon, authenticated;
revoke all on function public.set_announcement_acknowledgment_requirement(uuid, boolean, timestamptz) from public, anon;
revoke all on function public.publish_templated_announcement_with_acknowledgment(text, jsonb, timestamptz, boolean, timestamptz) from public, anon;
revoke all on function public.revise_templated_announcement(uuid, jsonb, timestamptz, boolean, timestamptz) from public, anon;
revoke all on function public.publish_training_version(uuid, text, text, text, text, text, text, date, timestamptz, uuid[], public.app_role[], uuid[], text[]) from public, anon;
revoke all on function public.get_training_catalog() from public, anon;
revoke all on function public.get_employee_action_center() from public, anon;
revoke all on function public.mark_employee_action_viewed(text, uuid) from public, anon;
revoke all on function public.complete_employee_action(text, uuid, text) from public, anon;
revoke all on function public.get_employee_action_compliance_report() from public, anon;

grant execute on function public.set_announcement_acknowledgment_requirement(uuid, boolean, timestamptz) to authenticated;
grant execute on function public.publish_templated_announcement_with_acknowledgment(text, jsonb, timestamptz, boolean, timestamptz) to authenticated;
grant execute on function public.revise_templated_announcement(uuid, jsonb, timestamptz, boolean, timestamptz) to authenticated;
grant execute on function public.publish_training_version(uuid, text, text, text, text, text, text, date, timestamptz, uuid[], public.app_role[], uuid[], text[]) to authenticated;
grant execute on function public.get_training_catalog() to authenticated;
grant execute on function public.get_employee_action_center() to authenticated;
grant execute on function public.mark_employee_action_viewed(text, uuid) to authenticated;
grant execute on function public.complete_employee_action(text, uuid, text) to authenticated;
grant execute on function public.get_employee_action_compliance_report() to authenticated;

comment on table public.announcement_acknowledgments is
  'Version-specific receipt acknowledgments. Acknowledgment is not an electronic signature.';
comment on table public.training_course_versions is
  'Immutable published training content versions.';
comment on table public.schedule_acknowledgments is
  'Version-specific acknowledgment of an hourly employee published shift snapshot; never a payroll blocker.';
comment on function public.publish_training_version(uuid, text, text, text, text, text, text, date, timestamptz, uuid[], public.app_role[], uuid[], text[]) is
  'Publishes an immutable training version, supersedes prior assignments, and resolves employee audiences transactionally.';

notify pgrst, 'reload schema';

commit;
