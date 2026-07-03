begin;

create schema if not exists private;

revoke all on schema private from public;

create type public.app_role as enum ('guard', 'supervisor', 'admin');
create type public.employment_type as enum ('hourly', 'salary');
create type public.employee_status as enum ('active', 'leave', 'inactive', 'separated');
create type public.schedule_status as enum ('draft', 'published', 'superseded', 'archived');
create type public.assignment_status as enum ('assigned', 'confirmed', 'canceled', 'completed');
create type public.request_status as enum ('pending', 'approved', 'declined', 'withdrawn', 'canceled');
create type public.credential_kind as enum (
  'guard_license',
  'armed_guard',
  'driver_license',
  'first_aid_cpr',
  'site_training',
  'other'
);
create type public.credential_status as enum ('pending', 'active', 'expired', 'suspended', 'revoked');
create type public.time_event_kind as enum ('clock_in', 'break_start', 'break_end', 'clock_out');
create type public.time_event_source as enum ('web', 'mobile_web', 'supervisor', 'import', 'system');
create type public.announcement_kind as enum ('general', 'open_shift', 'overtime', 'event');
create type public.import_status as enum ('registered', 'extracting', 'review', 'reconciled', 'promoted', 'failed');
create type public.issue_severity as enum ('information', 'warning', 'blocking');

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  employee_number text unique,
  username text not null unique,
  first_name text not null,
  middle_name text,
  last_name text not null,
  preferred_name text,
  role public.app_role not null default 'guard',
  employment_type public.employment_type not null default 'hourly',
  status public.employee_status not null default 'active',
  photo_path text,
  hired_on date,
  separated_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employees_username_format check (username ~ '^[a-z][a-z0-9]*$'),
  constraint employees_name_present check (btrim(first_name) <> '' and btrim(last_name) <> ''),
  constraint employees_separation_dates check (separated_on is null or hired_on is null or separated_on >= hired_on)
);

create table private.employee_accounts (
  employee_id uuid primary key references public.employees(id) on delete restrict,
  auth_user_id uuid not null unique references auth.users(id) on delete restrict,
  invited_at timestamptz,
  activated_at timestamptz,
  disabled_at timestamptz,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table private.employee_contacts (
  employee_id uuid primary key references public.employees(id) on delete restrict,
  personal_email text,
  company_email text,
  mobile_phone text,
  emergency_contact_name text,
  emergency_contact_phone text,
  address_line_1 text,
  address_line_2 text,
  city text,
  region text,
  postal_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table private.username_registry (
  username text primary key,
  employee_id uuid not null unique,
  reserved_at timestamptz not null default now()
);

create table public.employee_credentials (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  kind public.credential_kind not null,
  status public.credential_status not null default 'pending',
  credential_number text,
  issuing_authority text,
  valid_from date,
  expires_on date,
  verified_at timestamptz,
  verified_by uuid references public.employees(id) on delete restrict,
  document_path text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_credentials_dates check (expires_on is null or valid_from is null or expires_on >= valid_from)
);

create index employee_credentials_employee_idx on public.employee_credentials(employee_id);
create index employee_credentials_expiration_idx on public.employee_credentials(expires_on) where status = 'active';

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  code text unique,
  name text not null,
  address_line_1 text,
  address_line_2 text,
  city text,
  region text,
  postal_code text,
  time_zone text not null default 'America/Denver',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sites_name_present check (btrim(name) <> '')
);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete restrict,
  name text not null,
  requires_armed boolean not null default false,
  active boolean not null default true,
  default_start_time time,
  default_end_time time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint posts_name_present check (btrim(name) <> ''),
  constraint posts_site_name_unique unique (site_id, name)
);

create index posts_site_idx on public.posts(site_id);

create table private.site_secrets (
  site_id uuid primary key references public.sites(id) on delete restrict,
  encrypted_instructions bytea not null,
  encryption_key_version integer not null,
  updated_by uuid references public.employees(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  site_id uuid references public.sites(id) on delete restrict,
  location_name text,
  address_line_1 text,
  city text,
  region text,
  postal_code text,
  time_zone text not null default 'America/Denver',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  requires_armed boolean not null default false,
  active boolean not null default true,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint events_name_present check (btrim(name) <> ''),
  constraint events_time_order check (ends_at > starts_at),
  constraint events_location_present check (site_id is not null or btrim(coalesce(location_name, '')) <> '')
);

create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  week_starts_on date not null,
  revision integer not null default 1,
  status public.schedule_status not null default 'draft',
  previous_revision_id uuid references public.schedules(id) on delete restrict,
  published_at timestamptz,
  published_by uuid references public.employees(id) on delete restrict,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schedules_revision_positive check (revision > 0),
  constraint schedules_week_revision_unique unique (week_starts_on, revision),
  constraint schedules_publish_fields check (
    (status <> 'published') or (published_at is not null and published_by is not null)
  )
);

create index schedules_week_idx on public.schedules(week_starts_on desc);

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.schedules(id) on delete restrict,
  post_id uuid references public.posts(id) on delete restrict,
  event_id uuid references public.events(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  time_zone text not null default 'America/Denver',
  headcount_required integer not null default 1,
  requires_armed boolean not null default false,
  is_open boolean not null default false,
  is_overtime boolean not null default false,
  notes text,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shifts_location_exactly_one check (num_nonnulls(post_id, event_id) = 1),
  constraint shifts_time_order check (ends_at > starts_at),
  constraint shifts_headcount_positive check (headcount_required > 0)
);

create index shifts_schedule_idx on public.shifts(schedule_id);
create index shifts_time_idx on public.shifts(starts_at, ends_at);
create index shifts_open_idx on public.shifts(starts_at) where is_open;

create table public.shift_assignments (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.shifts(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  status public.assignment_status not null default 'assigned',
  assigned_by uuid not null references public.employees(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  confirmed_at timestamptz,
  canceled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_assignments_unique unique (shift_id, employee_id)
);

create index shift_assignments_employee_idx on public.shift_assignments(employee_id, status);

create table public.shift_requests (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.shifts(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  status public.request_status not null default 'pending',
  employee_note text,
  decision_note text,
  decided_by uuid references public.employees(id) on delete restrict,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_requests_unique unique (shift_id, employee_id)
);

create table public.time_off_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  starts_on date not null,
  ends_on date not null,
  partial_day_start time,
  partial_day_end time,
  reason text,
  status public.request_status not null default 'pending',
  decided_by uuid references public.employees(id) on delete restrict,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint time_off_dates check (ends_on >= starts_on),
  constraint time_off_partial_times check (
    (partial_day_start is null and partial_day_end is null)
    or (partial_day_start is not null and partial_day_end is not null and partial_day_end > partial_day_start)
  )
);

create index time_off_employee_dates_idx on public.time_off_requests(employee_id, starts_on, ends_on);

create table public.call_off_reports (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.shifts(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  reason text,
  reported_at timestamptz not null default now(),
  acknowledged_by uuid references public.employees(id) on delete restrict,
  acknowledged_at timestamptz,
  announcement_id uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint call_off_unique unique (shift_id, employee_id)
);

create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  kind public.announcement_kind not null,
  title text not null,
  body text not null,
  shift_id uuid references public.shifts(id) on delete restrict,
  event_id uuid references public.events(id) on delete restrict,
  published_at timestamptz,
  expires_at timestamptz,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint announcements_title_present check (btrim(title) <> ''),
  constraint announcements_body_present check (btrim(body) <> ''),
  constraint announcements_expiration check (expires_at is null or published_at is null or expires_at > published_at)
);

alter table public.call_off_reports
  add constraint call_off_announcement_fk
  foreign key (announcement_id) references public.announcements(id) on delete restrict;

create table public.time_events (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  shift_id uuid references public.shifts(id) on delete restrict,
  kind public.time_event_kind not null,
  recorded_at timestamptz not null default clock_timestamp(),
  client_recorded_at timestamptz,
  source public.time_event_source not null,
  idempotency_key text not null unique,
  created_by uuid references public.employees(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index time_events_employee_time_idx on public.time_events(employee_id, recorded_at);
create index time_events_shift_idx on public.time_events(shift_id, recorded_at);

create table public.time_event_corrections (
  id uuid primary key default gen_random_uuid(),
  time_event_id uuid not null references public.time_events(id) on delete restrict,
  replacement_time timestamptz,
  voided boolean not null default false,
  reason text not null,
  requested_by uuid not null references public.employees(id) on delete restrict,
  approved_by uuid references public.employees(id) on delete restrict,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint time_event_corrections_reason_present check (btrim(reason) <> ''),
  constraint time_event_corrections_action check (voided or replacement_time is not null)
);

create table private.audit_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default clock_timestamp(),
  auth_user_id uuid,
  employee_id uuid,
  request_id text,
  schema_name text not null,
  table_name text not null,
  operation text not null,
  row_id text,
  old_record jsonb,
  new_record jsonb
);

create index audit_events_target_idx on private.audit_events(table_name, row_id, occurred_at desc);
create index audit_events_actor_idx on private.audit_events(employee_id, occurred_at desc);

create table private.source_files (
  id uuid primary key default gen_random_uuid(),
  original_filename text not null,
  sha256 text not null unique,
  byte_size bigint not null,
  workbook_modified_at timestamptz,
  storage_path text not null,
  received_at timestamptz not null default now(),
  received_by uuid references public.employees(id) on delete restrict,
  constraint source_files_sha256_format check (sha256 ~ '^[a-f0-9]{64}$'),
  constraint source_files_size_positive check (byte_size > 0)
);

create table private.import_runs (
  id uuid primary key default gen_random_uuid(),
  source_file_id uuid not null references private.source_files(id) on delete restrict,
  status public.import_status not null default 'registered',
  extractor_version text not null,
  started_at timestamptz,
  completed_at timestamptz,
  promoted_at timestamptz,
  promoted_by uuid references public.employees(id) on delete restrict,
  source_cell_count bigint,
  normalized_record_count bigint,
  blocking_issue_count integer not null default 0,
  warning_count integer not null default 0,
  reconciliation_digest text,
  created_at timestamptz not null default now(),
  constraint import_runs_counts_nonnegative check (
    blocking_issue_count >= 0 and warning_count >= 0
    and coalesce(source_cell_count, 0) >= 0 and coalesce(normalized_record_count, 0) >= 0
  ),
  constraint import_runs_promotion_safe check (
    status <> 'promoted' or (blocking_issue_count = 0 and promoted_at is not null and promoted_by is not null)
  )
);

create table private.source_sheets (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null references private.import_runs(id) on delete restrict,
  sheet_index integer not null,
  name text not null,
  hidden boolean not null default false,
  max_row integer not null,
  max_column integer not null,
  constraint source_sheets_dimensions_nonnegative check (max_row >= 0 and max_column >= 0),
  constraint source_sheets_order_unique unique (import_run_id, sheet_index),
  constraint source_sheets_name_unique unique (import_run_id, name)
);

create table private.source_cells (
  id bigint generated always as identity primary key,
  source_sheet_id uuid not null references private.source_sheets(id) on delete restrict,
  cell_address text not null,
  raw_value jsonb,
  displayed_value text,
  formula text,
  number_format text,
  style_fingerprint text,
  comment_text text,
  hyperlink text,
  hidden_by_row boolean not null default false,
  hidden_by_column boolean not null default false,
  constraint source_cells_address_unique unique (source_sheet_id, cell_address)
);

create table private.import_issues (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null references private.import_runs(id) on delete restrict,
  source_cell_id bigint references private.source_cells(id) on delete restrict,
  severity public.issue_severity not null,
  code text not null,
  message text not null,
  resolution text,
  resolved_by uuid references public.employees(id) on delete restrict,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint import_issues_resolution_complete check (
    (resolved_at is null and resolved_by is null)
    or (resolved_at is not null and resolved_by is not null and btrim(coalesce(resolution, '')) <> '')
  )
);

create table private.source_links (
  id bigint generated always as identity primary key,
  import_run_id uuid not null references private.import_runs(id) on delete restrict,
  source_cell_id bigint not null references private.source_cells(id) on delete restrict,
  target_table text not null,
  target_id uuid not null,
  target_field text,
  transformation text,
  created_at timestamptz not null default now()
);

create table private.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  message_type text not null,
  aggregate_type text not null,
  aggregate_id uuid not null,
  recipient_employee_id uuid references public.employees(id) on delete restrict,
  payload jsonb not null,
  idempotency_key text not null unique,
  available_at timestamptz not null default now(),
  attempted_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  attempt_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  constraint notification_attempts_nonnegative check (attempt_count >= 0)
);

create function private.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select account.employee_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where account.auth_user_id = (select auth.uid())
    and account.disabled_at is null
    and employee.status = 'active'
  limit 1
$$;

create function public.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_employee_id()
$$;

create function public.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select employee.role
  from public.employees employee
  where employee.id = private.current_employee_id()
$$;

create function public.has_mfa()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'aal') = 'aal2', false)
$$;

create function public.is_supervisor_or_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_app_role() in ('supervisor', 'admin'), false)
$$;

create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_app_role() = 'admin', false)
$$;

create function public.has_valid_credential(
  employee uuid,
  credential public.credential_kind,
  on_date date default current_date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.employee_credentials item
    where item.employee_id = employee
      and item.kind = credential
      and item.status = 'active'
      and (item.valid_from is null or item.valid_from <= on_date)
      and (item.expires_on is null or item.expires_on >= on_date)
  )
$$;

create function private.assign_username()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_username text;
  candidate text;
  suffix integer := 2;
begin
  base_username := regexp_replace(
    lower(left(new.first_name, 1) || new.last_name),
    '[^a-z0-9]',
    '',
    'g'
  );

  if base_username !~ '^[a-z][a-z0-9]*$' then
    raise exception 'A username cannot be generated from the supplied name.';
  end if;

  perform pg_advisory_xact_lock(hashtext(base_username));
  candidate := base_username;

  while exists (select 1 from private.username_registry item where item.username = candidate) loop
    candidate := base_username || suffix::text;
    suffix := suffix + 1;
  end loop;

  new.username := candidate;
  insert into private.username_registry (username, employee_id) values (candidate, new.id);
  return new;
end
$$;

create function private.prevent_username_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.username is distinct from old.username then
    raise exception 'Usernames are immutable.';
  end if;
  return new;
end
$$;

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end
$$;

create function private.protect_published_schedule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'published' then
    if tg_op = 'UPDATE'
      and new.status = 'superseded'
      and (to_jsonb(new) - 'status' - 'updated_at') = (to_jsonb(old) - 'status' - 'updated_at')
    then
      return new;
    end if;
    raise exception 'Published schedules are immutable; create a new revision.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

create function private.protect_published_schedule_child()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent_schedule_id uuid;
  parent_status public.schedule_status;
begin
  if tg_table_name = 'shifts' then
    parent_schedule_id := case when tg_op = 'DELETE' then old.schedule_id else new.schedule_id end;
  else
    select shift.schedule_id into parent_schedule_id
    from public.shifts shift
    where shift.id = case when tg_op = 'DELETE' then old.shift_id else new.shift_id end;
  end if;

  select schedule.status into parent_status
  from public.schedules schedule
  where schedule.id = parent_schedule_id;

  if parent_status = 'published' then
    raise exception 'Published schedule records are immutable; create a new revision.';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end
$$;

create function private.set_shift_security_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.post_id is not null then
    select post.requires_armed, site.time_zone
      into new.requires_armed, new.time_zone
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = new.post_id;
  else
    select event.requires_armed, event.time_zone
      into new.requires_armed, new.time_zone
    from public.events event
    where event.id = new.event_id;
  end if;

  return new;
end
$$;

create function private.enforce_shift_qualification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  shift_requires_armed boolean;
  shift_date date;
begin
  if tg_table_name = 'shift_assignments' and new.status = 'canceled' then
    return new;
  end if;

  if tg_table_name = 'shift_requests' and new.status in ('withdrawn', 'canceled', 'declined') then
    return new;
  end if;

  select shift.requires_armed, (shift.starts_at at time zone shift.time_zone)::date
    into shift_requires_armed, shift_date
  from public.shifts shift
  where shift.id = new.shift_id;

  if shift_requires_armed
    and not public.has_valid_credential(new.employee_id, 'armed_guard', shift_date)
  then
    raise exception 'The employee does not hold a valid armed qualification for this shift.';
  end if;

  return new;
end
$$;

create function private.enforce_assignment_capacity_and_overlap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_shift public.shifts%rowtype;
  active_assignment_count integer;
begin
  if new.status = 'canceled' then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.shift_id::text));

  select * into target_shift
  from public.shifts shift
  where shift.id = new.shift_id;

  select count(*) into active_assignment_count
  from public.shift_assignments assignment
  where assignment.shift_id = new.shift_id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and assignment.id <> new.id;

  if active_assignment_count >= target_shift.headcount_required then
    raise exception 'The shift already has its required number of assigned employees.';
  end if;

  if exists (
    select 1
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    where assignment.employee_id = new.employee_id
      and assignment.id <> new.id
      and assignment.status in ('assigned', 'confirmed', 'completed')
      and tstzrange(shift.starts_at, shift.ends_at, '[)')
        && tstzrange(target_shift.starts_at, target_shift.ends_at, '[)')
  ) then
    raise exception 'The employee is already assigned to an overlapping shift.';
  end if;

  return new;
end
$$;

create function private.prevent_append_only_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only.', tg_table_name;
end
$$;

create function private.write_audit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  before_record jsonb;
  after_record jsonb;
  target_id text;
begin
  if tg_op = 'INSERT' then
    after_record := to_jsonb(new);
    target_id := after_record ->> 'id';
  elsif tg_op = 'UPDATE' then
    before_record := to_jsonb(old);
    after_record := to_jsonb(new);
    target_id := coalesce(after_record ->> 'id', before_record ->> 'id');
  else
    before_record := to_jsonb(old);
    target_id := before_record ->> 'id';
  end if;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    request_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    (select auth.uid()),
    private.current_employee_id(),
    nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-request-id',
    tg_table_schema,
    tg_table_name,
    tg_op,
    target_id,
    before_record,
    after_record
  );

  return case when tg_op = 'DELETE' then old else new end;
end
$$;

create trigger employees_assign_username
before insert on public.employees
for each row execute function private.assign_username();

create trigger employees_username_immutable
before update of username on public.employees
for each row execute function private.prevent_username_change();

create trigger schedules_published_immutable
before update or delete on public.schedules
for each row execute function private.protect_published_schedule();

create trigger shifts_set_security_fields
before insert or update of post_id, event_id on public.shifts
for each row execute function private.set_shift_security_fields();

create trigger shifts_published_immutable
before insert or update or delete on public.shifts
for each row execute function private.protect_published_schedule_child();

create trigger assignments_require_qualification
before insert or update of shift_id, employee_id, status on public.shift_assignments
for each row execute function private.enforce_shift_qualification();

create trigger assignments_capacity_and_overlap
before insert or update of shift_id, employee_id, status on public.shift_assignments
for each row execute function private.enforce_assignment_capacity_and_overlap();

create trigger shift_requests_require_qualification
before insert or update of shift_id, employee_id, status on public.shift_requests
for each row execute function private.enforce_shift_qualification();

create trigger time_events_append_only
before update or delete on public.time_events
for each row execute function private.prevent_append_only_change();

create trigger time_event_corrections_append_only
before update or delete on public.time_event_corrections
for each row execute function private.prevent_append_only_change();

create trigger source_cells_append_only
before update or delete on private.source_cells
for each row execute function private.prevent_append_only_change();

do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'employees',
    'employee_credentials',
    'sites',
    'posts',
    'events',
    'schedules',
    'shifts',
    'shift_assignments',
    'shift_requests',
    'time_off_requests',
    'call_off_reports',
    'announcements'
  ]
  loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function private.set_updated_at()',
      relation_name || '_set_updated_at',
      relation_name
    );
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function private.write_audit_event()',
      relation_name || '_audit',
      relation_name
    );
  end loop;
end
$$;

alter table public.employees enable row level security;
alter table public.employee_credentials enable row level security;
alter table public.sites enable row level security;
alter table public.posts enable row level security;
alter table public.events enable row level security;
alter table public.schedules enable row level security;
alter table public.shifts enable row level security;
alter table public.shift_assignments enable row level security;
alter table public.shift_requests enable row level security;
alter table public.time_off_requests enable row level security;
alter table public.call_off_reports enable row level security;
alter table public.announcements enable row level security;
alter table public.time_events enable row level security;
alter table public.time_event_corrections enable row level security;

create policy employees_read on public.employees
for select to authenticated
using (
  status = 'active'
  or id = public.current_employee_id()
  or public.is_supervisor_or_admin()
);

create policy employees_admin_insert on public.employees
for insert to authenticated
with check (public.is_admin() and public.has_mfa());

create policy employees_admin_update on public.employees
for update to authenticated
using (public.is_admin() and public.has_mfa())
with check (public.is_admin() and public.has_mfa());

create policy credentials_read on public.employee_credentials
for select to authenticated
using (employee_id = public.current_employee_id() or public.is_supervisor_or_admin());

create policy credentials_admin_write on public.employee_credentials
for all to authenticated
using (public.is_admin() and public.has_mfa())
with check (public.is_admin() and public.has_mfa());

create policy sites_read on public.sites
for select to authenticated
using (active or public.is_supervisor_or_admin());

create policy sites_admin_write on public.sites
for all to authenticated
using (public.is_admin() and public.has_mfa())
with check (public.is_admin() and public.has_mfa());

create policy posts_read on public.posts
for select to authenticated
using (active or public.is_supervisor_or_admin());

create policy posts_supervisor_write on public.posts
for all to authenticated
using (public.is_supervisor_or_admin() and public.has_mfa())
with check (public.is_supervisor_or_admin() and public.has_mfa());

create policy events_read on public.events
for select to authenticated
using (active or public.is_supervisor_or_admin());

create policy events_supervisor_write on public.events
for all to authenticated
using (public.is_supervisor_or_admin() and public.has_mfa())
with check (public.is_supervisor_or_admin() and public.has_mfa());

create policy schedules_read on public.schedules
for select to authenticated
using (status = 'published' or public.is_supervisor_or_admin());

create policy schedules_supervisor_write on public.schedules
for all to authenticated
using (public.is_supervisor_or_admin() and public.has_mfa())
with check (public.is_supervisor_or_admin() and public.has_mfa());

create policy shifts_read on public.shifts
for select to authenticated
using (
  public.is_supervisor_or_admin()
  or (
    exists (
      select 1 from public.schedules schedule
      where schedule.id = shifts.schedule_id and schedule.status = 'published'
    )
    and (
      not requires_armed
      or public.has_valid_credential(
        public.current_employee_id(),
        'armed_guard',
        (starts_at at time zone time_zone)::date
      )
    )
  )
);

create policy shifts_supervisor_write on public.shifts
for all to authenticated
using (public.is_supervisor_or_admin() and public.has_mfa())
with check (public.is_supervisor_or_admin() and public.has_mfa());

create policy assignments_read on public.shift_assignments
for select to authenticated
using (
  public.is_supervisor_or_admin()
  or exists (
    select 1 from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    where shift.id = shift_assignments.shift_id and schedule.status = 'published'
  )
);

create policy assignments_supervisor_write on public.shift_assignments
for all to authenticated
using (public.is_supervisor_or_admin() and public.has_mfa())
with check (public.is_supervisor_or_admin() and public.has_mfa());

create policy shift_requests_read on public.shift_requests
for select to authenticated
using (employee_id = public.current_employee_id() or public.is_supervisor_or_admin());

create policy shift_requests_guard_insert on public.shift_requests
for insert to authenticated
with check (
  employee_id = public.current_employee_id()
  and status = 'pending'
  and exists (select 1 from public.shifts shift where shift.id = shift_id and shift.is_open)
);

create policy shift_requests_guard_update on public.shift_requests
for update to authenticated
using (employee_id = public.current_employee_id() and status = 'pending')
with check (employee_id = public.current_employee_id() and status = 'withdrawn');

create policy shift_requests_supervisor_update on public.shift_requests
for update to authenticated
using (public.is_supervisor_or_admin() and public.has_mfa())
with check (public.is_supervisor_or_admin() and public.has_mfa());

create policy time_off_read on public.time_off_requests
for select to authenticated
using (employee_id = public.current_employee_id() or public.is_supervisor_or_admin());

create policy time_off_guard_insert on public.time_off_requests
for insert to authenticated
with check (employee_id = public.current_employee_id() and status = 'pending');

create policy time_off_guard_update on public.time_off_requests
for update to authenticated
using (employee_id = public.current_employee_id() and status = 'pending')
with check (employee_id = public.current_employee_id() and status in ('pending', 'withdrawn'));

create policy time_off_supervisor_update on public.time_off_requests
for update to authenticated
using (public.is_supervisor_or_admin() and public.has_mfa())
with check (public.is_supervisor_or_admin() and public.has_mfa());

create policy call_off_read on public.call_off_reports
for select to authenticated
using (employee_id = public.current_employee_id() or public.is_supervisor_or_admin());

create policy call_off_guard_insert on public.call_off_reports
for insert to authenticated
with check (
  employee_id = public.current_employee_id()
  and exists (
    select 1
    from public.shift_assignments assignment
    where assignment.shift_id = call_off_reports.shift_id
      and assignment.employee_id = public.current_employee_id()
      and assignment.status in ('assigned', 'confirmed')
  )
);

create policy call_off_supervisor_update on public.call_off_reports
for update to authenticated
using (public.is_supervisor_or_admin() and public.has_mfa())
with check (public.is_supervisor_or_admin() and public.has_mfa());

create policy announcements_read on public.announcements
for select to authenticated
using (published_at is not null and (expires_at is null or expires_at > now()) or public.is_supervisor_or_admin());

create policy announcements_supervisor_write on public.announcements
for all to authenticated
using (public.is_supervisor_or_admin() and public.has_mfa())
with check (public.is_supervisor_or_admin() and public.has_mfa());

create policy time_events_read on public.time_events
for select to authenticated
using (employee_id = public.current_employee_id() or public.is_supervisor_or_admin());

create policy time_event_corrections_read on public.time_event_corrections
for select to authenticated
using (
  public.is_supervisor_or_admin()
  or exists (
    select 1 from public.time_events event
    where event.id = time_event_corrections.time_event_id
      and event.employee_id = public.current_employee_id()
  )
);

revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

grant select on public.employees, public.employee_credentials, public.sites, public.posts,
  public.events, public.schedules, public.shifts, public.shift_assignments,
  public.shift_requests, public.time_off_requests, public.call_off_reports,
  public.announcements, public.time_events, public.time_event_corrections
to authenticated;

grant insert, update, delete on public.employees, public.employee_credentials, public.sites,
  public.posts, public.events, public.schedules, public.shifts, public.shift_assignments,
  public.announcements
to authenticated;

grant insert, update on public.shift_requests, public.time_off_requests, public.call_off_reports
to authenticated;

revoke all on all functions in schema public from public, anon;
grant execute on function public.current_employee_id() to authenticated;
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.has_mfa() to authenticated;
grant execute on function public.is_supervisor_or_admin() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.has_valid_credential(uuid, public.credential_kind, date) to authenticated;

revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
grant usage on schema private to service_role;
grant all on all tables in schema private to service_role;
grant all on all sequences in schema private to service_role;
grant execute on all functions in schema private to service_role;

commit;
