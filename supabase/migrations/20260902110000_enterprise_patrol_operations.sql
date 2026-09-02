begin;

-- This release may add Patrol records and focused permissions, but it must not
-- rewrite existing employee, scheduling, timekeeping, or access-assignment data.
create temporary table patrol_release_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.schedules) as schedule_count,
  (select count(*) from public.shifts) as shift_count,
  (select count(*) from public.shift_assignments) as assignment_count,
  (select count(*) from public.time_events) as time_event_count,
  (select count(*) from public.employee_access_roles) as access_role_count,
  (select count(*) from public.employee_permission_overrides) as permission_override_count;

insert into public.permission_catalog (code, category, name, description, risk_level, requires_mfa, locked, active)
values
  ('patrol.self.view', 'Patrol', 'View assigned patrols', 'View personal patrol assignments, requirements, and completed hits.', 'standard', false, true, true),
  ('patrol.hits.complete', 'Patrol', 'Complete patrol hits', 'Complete required and makeup patrol hits with notes and approved evidence.', 'standard', false, true, true),
  ('patrol.hits.extra', 'Patrol', 'Record extra patrol hits', 'Record an additional authorized patrol hit without changing required totals.', 'standard', false, true, true),
  ('patrol.evidence.upload', 'Patrol', 'Upload patrol evidence', 'Upload photos or videos to an assigned patrol hit when the route allows it.', 'standard', false, true, true),
  ('patrol.evidence.view', 'Patrol', 'View patrol evidence', 'Preview and download protected patrol evidence.', 'sensitive', true, true, true),
  ('patrol.operations.view', 'Patrol', 'View patrol operations', 'View active patrol progress, exceptions, makeup work, and guard activity.', 'sensitive', true, true, true),
  ('patrol.routes.manage', 'Patrol', 'Manage patrol routes', 'Build, version, activate, pause, and archive patrol routes and requirements.', 'critical', true, true, true),
  ('patrol.assignments.manage', 'Patrol', 'Manage patrol assignments', 'Connect a versioned patrol route to an assigned published schedule shift.', 'critical', true, true, true),
  ('patrol.exceptions.manage', 'Patrol', 'Manage patrol exceptions', 'Review missed hits, assign makeup work, and record documented corrections.', 'critical', true, true, true),
  ('patrol.reports.view', 'Patrol', 'View patrol reports', 'View filtered patrol activity, exceptions, evidence, and compliance reporting.', 'sensitive', true, true, true),
  ('patrol.reports.export', 'Patrol', 'Export patrol reports', 'Export protected patrol reports in approved internal or client-ready formats.', 'critical', true, true, true),
  ('patrol.audit.view', 'Patrol', 'View patrol audit history', 'View route versions and patrol record audit history.', 'critical', true, true, true)
on conflict (code) do update
set category = excluded.category,
    name = excluded.name,
    description = excluded.description,
    risk_level = excluded.risk_level,
    requires_mfa = excluded.requires_mfa,
    locked = excluded.locked,
    active = true,
    updated_at = now();

-- Every active employee may see and complete only patrol work explicitly assigned
-- to them. These permissions deliberately do not require MFA on a guard's phone.
insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, permission.code, true
from public.access_roles role
cross join public.permission_catalog permission
where role.code = 'system_guard'
  and permission.code in ('patrol.self.view', 'patrol.hits.complete', 'patrol.hits.extra', 'patrol.evidence.upload')
on conflict (role_id, permission_code) do update set enabled = true, updated_at = now();

-- Preserve the existing patrol role boundary while adding focused permissions.
insert into public.access_role_permissions (role_id, permission_code, enabled)
select distinct existing.role_id, permission.code, true
from public.access_role_permissions existing
cross join public.permission_catalog permission
where existing.permission_code = 'patrol.view'
  and existing.enabled
  and permission.code in ('patrol.self.view', 'patrol.operations.view', 'patrol.reports.view')
on conflict (role_id, permission_code) do update set enabled = true, updated_at = now();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select distinct existing.role_id, permission.code, true
from public.access_role_permissions existing
cross join public.permission_catalog permission
where existing.permission_code = 'patrol.manage'
  and existing.enabled
  and permission.code in (
    'patrol.self.view', 'patrol.hits.complete', 'patrol.hits.extra', 'patrol.evidence.upload',
    'patrol.evidence.view', 'patrol.operations.view', 'patrol.routes.manage',
    'patrol.assignments.manage', 'patrol.exceptions.manage', 'patrol.reports.view',
    'patrol.reports.export', 'patrol.audit.view'
  )
on conflict (role_id, permission_code) do update set enabled = true, updated_at = now();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, permission.code, true
from public.access_roles role
cross join public.permission_catalog permission
where role.code = 'system_admin'
  and permission.code like 'patrol.%'
on conflict (role_id, permission_code) do update set enabled = true, updated_at = now();

create table public.patrol_routes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  requires_armed boolean not null default false,
  status text not null default 'draft',
  time_zone text not null default 'America/Denver',
  current_version_id uuid,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_by uuid not null references public.employees(id) on delete restrict,
  updated_at timestamptz not null default now(),
  constraint patrol_routes_code_format check (code ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  constraint patrol_routes_name_present check (btrim(name) <> ''),
  constraint patrol_routes_status_check check (status in ('draft', 'active', 'paused', 'archived')),
  constraint patrol_routes_time_zone_check check (time_zone in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'))
);

create table public.patrol_route_versions (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.patrol_routes(id) on delete restrict,
  version_number integer not null,
  effective_from date,
  effective_through date,
  change_reason text not null,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint patrol_route_versions_number_positive check (version_number > 0),
  constraint patrol_route_versions_reason_present check (length(btrim(change_reason)) >= 5),
  constraint patrol_route_versions_date_order check (effective_through is null or effective_from is null or effective_through >= effective_from),
  constraint patrol_route_versions_unique unique (route_id, version_number)
);

alter table public.patrol_routes
  add constraint patrol_routes_current_version_fk foreign key (current_version_id) references public.patrol_route_versions(id) on delete restrict;

create table public.patrol_route_stops (
  id uuid primary key default gen_random_uuid(),
  route_version_id uuid not null references public.patrol_route_versions(id) on delete restrict,
  stable_key uuid not null default gen_random_uuid(),
  sequence_number integer not null,
  location_label text not null,
  site_id uuid references public.sites(id) on delete restrict,
  post_id uuid references public.posts(id) on delete restrict,
  address_line_1 text,
  city text,
  region text,
  postal_code text,
  latitude numeric(9,6),
  longitude numeric(9,6),
  geofence_radius_meters integer,
  instructions text,
  allow_photos boolean not null default true,
  allow_videos boolean not null default true,
  require_evidence boolean not null default false,
  evidence_instructions text,
  standard_video_limit_seconds integer not null default 180,
  incident_video_limit_seconds integer not null default 900,
  created_at timestamptz not null default now(),
  constraint patrol_route_stops_sequence_positive check (sequence_number > 0),
  constraint patrol_route_stops_location_present check (btrim(location_label) <> ''),
  constraint patrol_route_stops_coordinates_pair check (num_nonnulls(latitude, longitude) in (0, 2)),
  constraint patrol_route_stops_latitude_check check (latitude is null or latitude between -90 and 90),
  constraint patrol_route_stops_longitude_check check (longitude is null or longitude between -180 and 180),
  constraint patrol_route_stops_radius_check check (geofence_radius_meters is null or geofence_radius_meters between 25 and 5000),
  constraint patrol_route_stops_video_limits check (standard_video_limit_seconds between 30 and 1800 and incident_video_limit_seconds between standard_video_limit_seconds and 3600),
  constraint patrol_route_stops_version_sequence_unique unique (route_version_id, sequence_number),
  constraint patrol_route_stops_version_key_unique unique (route_version_id, stable_key)
);

create table public.patrol_stop_requirements (
  id uuid primary key default gen_random_uuid(),
  stop_id uuid not null references public.patrol_route_stops(id) on delete restrict,
  day_of_week smallint not null,
  requirement_label text not null default 'Night patrol',
  required_hits integer not null,
  status text not null default 'active',
  window_start time,
  window_end time,
  minimum_spacing_minutes integer,
  sequence_required boolean not null default false,
  created_at timestamptz not null default now(),
  constraint patrol_stop_requirements_day_check check (day_of_week between 0 and 6),
  constraint patrol_stop_requirements_label_present check (btrim(requirement_label) <> ''),
  constraint patrol_stop_requirements_hits_positive check (required_hits between 1 and 50),
  constraint patrol_stop_requirements_status_check check (status in ('active', 'paused')),
  constraint patrol_stop_requirements_window_pair check (num_nonnulls(window_start, window_end) in (0, 2)),
  constraint patrol_stop_requirements_spacing_check check (minimum_spacing_minutes is null or minimum_spacing_minutes between 1 and 720),
  constraint patrol_stop_requirements_unique unique (stop_id, day_of_week, requirement_label)
);

create table public.patrol_assignments (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.patrol_routes(id) on delete restrict,
  route_version_id uuid not null references public.patrol_route_versions(id) on delete restrict,
  shift_id uuid not null references public.shifts(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  service_date date not null,
  status text not null default 'active',
  assigned_by uuid not null references public.employees(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  completed_at timestamptz,
  canceled_at timestamptz,
  cancellation_reason text,
  constraint patrol_assignments_status_check check (status in ('active', 'completed', 'canceled')),
  constraint patrol_assignments_cancellation_check check (status <> 'canceled' or (canceled_at is not null and length(btrim(cancellation_reason)) >= 5)),
  constraint patrol_assignments_unique unique (route_version_id, shift_id, employee_id)
);

create table public.patrol_hit_obligations (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.patrol_assignments(id) on delete restrict,
  stop_id uuid not null references public.patrol_route_stops(id) on delete restrict,
  requirement_id uuid not null references public.patrol_stop_requirements(id) on delete restrict,
  hit_number integer not null,
  due_start_at timestamptz not null,
  due_end_at timestamptz not null,
  status text not null default 'scheduled',
  completed_hit_id uuid,
  reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint patrol_hit_obligations_number_positive check (hit_number > 0),
  constraint patrol_hit_obligations_time_order check (due_end_at > due_start_at),
  constraint patrol_hit_obligations_status_check check (status in ('scheduled', 'due', 'late', 'completed', 'missed', 'waived')),
  constraint patrol_hit_obligations_unique unique (assignment_id, requirement_id, hit_number)
);

create table public.patrol_makeup_assignments (
  id uuid primary key default gen_random_uuid(),
  obligation_id uuid not null references public.patrol_hit_obligations(id) on delete restrict,
  assigned_patrol_assignment_id uuid not null references public.patrol_assignments(id) on delete restrict,
  assigned_to uuid not null references public.employees(id) on delete restrict,
  reason text not null,
  status text not null default 'assigned',
  assigned_by uuid not null references public.employees(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  completed_hit_id uuid,
  completed_at timestamptz,
  canceled_at timestamptz,
  constraint patrol_makeup_assignments_reason_present check (length(btrim(reason)) >= 5),
  constraint patrol_makeup_assignments_status_check check (status in ('assigned', 'completed', 'canceled'))
);

create table public.patrol_hits (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.patrol_assignments(id) on delete restrict,
  stop_id uuid not null references public.patrol_route_stops(id) on delete restrict,
  obligation_id uuid references public.patrol_hit_obligations(id) on delete restrict,
  makeup_assignment_id uuid references public.patrol_makeup_assignments(id) on delete restrict,
  classification text not null,
  status text not null default 'draft',
  outcome text,
  note text,
  extra_reason text,
  location_status text not null default 'not_configured',
  latitude numeric(9,6),
  longitude numeric(9,6),
  accuracy_meters numeric(8,2),
  client_recorded_at timestamptz,
  submitted_at timestamptz,
  submitted_by uuid not null references public.employees(id) on delete restrict,
  idempotency_key uuid not null,
  invalidated_at timestamptz,
  invalidated_by uuid references public.employees(id) on delete restrict,
  invalidation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint patrol_hits_classification_check check (classification in ('required', 'makeup', 'extra')),
  constraint patrol_hits_status_check check (status in ('draft', 'submitted', 'invalidated')),
  constraint patrol_hits_outcome_check check (outcome is null or outcome in ('secure', 'attention_needed', 'incident', 'unable_to_access', 'other')),
  constraint patrol_hits_reference_check check (
    (classification = 'required' and obligation_id is not null and makeup_assignment_id is null)
    or (classification = 'makeup' and obligation_id is not null and makeup_assignment_id is not null)
    or (classification = 'extra' and obligation_id is null and makeup_assignment_id is null)
  ),
  constraint patrol_hits_extra_reason_check check (classification <> 'extra' or length(btrim(coalesce(extra_reason, ''))) >= 5),
  constraint patrol_hits_coordinates_pair check (num_nonnulls(latitude, longitude) in (0, 2)),
  constraint patrol_hits_location_status_check check (location_status in ('not_configured', 'verified', 'outside_geofence', 'unavailable', 'declined')),
  constraint patrol_hits_idempotency_unique unique (submitted_by, idempotency_key)
);

alter table public.patrol_hit_obligations
  add constraint patrol_hit_obligations_completed_hit_fk foreign key (completed_hit_id) references public.patrol_hits(id) on delete restrict;
alter table public.patrol_makeup_assignments
  add constraint patrol_makeup_assignments_completed_hit_fk foreign key (completed_hit_id) references public.patrol_hits(id) on delete restrict;

create table public.patrol_hit_evidence (
  id uuid primary key default gen_random_uuid(),
  hit_id uuid not null references public.patrol_hits(id) on delete restrict,
  media_kind text not null,
  status text not null default 'pending_upload',
  bucket_name text not null default 'patrol-evidence',
  object_key text not null unique,
  original_filename text not null,
  mime_type text not null,
  byte_size bigint not null,
  duration_seconds integer,
  sha256_checksum text,
  idempotency_key uuid not null,
  uploaded_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default now(),
  stored_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references public.employees(id) on delete restrict,
  deletion_reason text,
  constraint patrol_hit_evidence_kind_check check (media_kind in ('photo', 'video')),
  constraint patrol_hit_evidence_status_check check (status in ('pending_upload', 'stored', 'failed', 'deleted')),
  constraint patrol_hit_evidence_size_check check (byte_size between 1 and 524288000),
  constraint patrol_hit_evidence_duration_check check (duration_seconds is null or duration_seconds between 1 and 3600),
  constraint patrol_hit_evidence_filename_present check (btrim(original_filename) <> ''),
  constraint patrol_hit_evidence_mime_present check (btrim(mime_type) <> ''),
  constraint patrol_hit_evidence_idempotency_unique unique (uploaded_by, idempotency_key)
);

create index patrol_route_versions_route_idx on public.patrol_route_versions(route_id, version_number desc);
create index patrol_route_stops_version_idx on public.patrol_route_stops(route_version_id, sequence_number);
create index patrol_requirements_stop_day_idx on public.patrol_stop_requirements(stop_id, day_of_week);
create index patrol_assignments_employee_idx on public.patrol_assignments(employee_id, status, service_date desc);
create index patrol_assignments_shift_idx on public.patrol_assignments(shift_id, status);
create index patrol_obligations_status_idx on public.patrol_hit_obligations(status, due_end_at);
create unique index patrol_makeup_assignments_open_unique on public.patrol_makeup_assignments(obligation_id) where status = 'assigned';
create index patrol_hits_assignment_idx on public.patrol_hits(assignment_id, submitted_at desc);
create index patrol_hits_submitted_idx on public.patrol_hits(submitted_at desc) where status = 'submitted';
create index patrol_evidence_hit_idx on public.patrol_hit_evidence(hit_id, status);

alter table public.patrol_routes enable row level security;
alter table public.patrol_route_versions enable row level security;
alter table public.patrol_route_stops enable row level security;
alter table public.patrol_stop_requirements enable row level security;
alter table public.patrol_assignments enable row level security;
alter table public.patrol_hit_obligations enable row level security;
alter table public.patrol_makeup_assignments enable row level security;
alter table public.patrol_hits enable row level security;
alter table public.patrol_hit_evidence enable row level security;

revoke all on table public.patrol_routes, public.patrol_route_versions, public.patrol_route_stops,
  public.patrol_stop_requirements, public.patrol_assignments, public.patrol_hit_obligations,
  public.patrol_makeup_assignments, public.patrol_hits, public.patrol_hit_evidence from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'patrol-evidence',
  'patrol-evidence',
  false,
  524288000,
  array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.patrol_note_is_meaningful(value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select length(btrim(coalesce(value, ''))) >= 20
    and array_length(regexp_split_to_array(btrim(value), '\s+'), 1) >= 4
    and btrim(value) !~* '^(.)(\1){9,}$'
$$;

create or replace function private.patrol_can_manage()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin() or public.has_effective_permission('patrol.manage') or public.has_effective_permission('patrol.routes.manage')
$$;

create or replace function private.reconcile_patrol_obligations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare affected integer;
begin
  update public.patrol_hit_obligations obligation
  set status = case
      when obligation.due_end_at < now() then 'missed'
      when obligation.due_start_at <= now() then 'due'
      else 'scheduled'
    end,
    reconciled_at = now()
  where obligation.status in ('scheduled', 'due', 'late')
    and not exists (
      select 1 from public.patrol_hits hit
      where hit.id = obligation.completed_hit_id and hit.status = 'submitted'
    );
  get diagnostics affected = row_count;
  return affected;
end
$$;

create or replace function public.get_patrol_workspace()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  can_manage boolean;
  can_operate boolean;
  payload jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to open Patrol.';
  end if;
  if not (
    public.has_effective_permission('patrol.self.view')
    or public.has_effective_permission('patrol.view')
    or public.has_effective_permission('patrol.manage')
  ) then
    raise insufficient_privilege using message = 'Patrol access is required.';
  end if;

  perform private.reconcile_patrol_obligations();
  can_manage := private.patrol_can_manage();
  can_operate := can_manage or public.has_effective_permission('patrol.operations.view');

  select jsonb_build_object(
    'actor', jsonb_build_object(
      'employeeId', actor_id,
      'canManageRoutes', can_manage or public.has_effective_permission('patrol.routes.manage'),
      'canManageAssignments', can_manage or public.has_effective_permission('patrol.assignments.manage'),
      'canManageExceptions', can_manage or public.has_effective_permission('patrol.exceptions.manage'),
      'canViewOperations', can_operate,
      'canViewEvidence', can_manage or public.has_effective_permission('patrol.evidence.view'),
      'canExportReports', can_manage or public.has_effective_permission('patrol.reports.export')
    ),
    'routes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', route.id,
        'code', route.code,
        'name', route.name,
        'requiresArmed', route.requires_armed,
        'status', route.status,
        'timeZone', route.time_zone,
        'versionId', version.id,
        'versionNumber', version.version_number,
        'effectiveFrom', version.effective_from,
        'effectiveThrough', version.effective_through,
        'changeReason', version.change_reason,
        'stops', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', stop.id,
            'stableKey', stop.stable_key,
            'sequence', stop.sequence_number,
            'locationLabel', stop.location_label,
            'siteId', stop.site_id,
            'postId', stop.post_id,
            'addressLine1', stop.address_line_1,
            'city', stop.city,
            'region', stop.region,
            'postalCode', stop.postal_code,
            'latitude', stop.latitude,
            'longitude', stop.longitude,
            'geofenceRadiusMeters', stop.geofence_radius_meters,
            'instructions', stop.instructions,
            'allowPhotos', stop.allow_photos,
            'allowVideos', stop.allow_videos,
            'requireEvidence', stop.require_evidence,
            'evidenceInstructions', stop.evidence_instructions,
            'standardVideoLimitSeconds', stop.standard_video_limit_seconds,
            'incidentVideoLimitSeconds', stop.incident_video_limit_seconds,
            'requirements', coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', requirement.id,
                'dayOfWeek', requirement.day_of_week,
                'label', requirement.requirement_label,
                'requiredHits', requirement.required_hits,
                'status', requirement.status,
                'windowStart', requirement.window_start,
                'windowEnd', requirement.window_end,
                'minimumSpacingMinutes', requirement.minimum_spacing_minutes,
                'sequenceRequired', requirement.sequence_required
              ) order by requirement.day_of_week, requirement.requirement_label)
              from public.patrol_stop_requirements requirement
              where requirement.stop_id = stop.id
            ), '[]'::jsonb)
          ) order by stop.sequence_number)
          from public.patrol_route_stops stop
          where stop.route_version_id = version.id
        ), '[]'::jsonb)
      ) order by route.name)
      from public.patrol_routes route
      join public.patrol_route_versions version on version.id = route.current_version_id
      where can_operate
         or exists (
           select 1 from public.patrol_assignments assignment
           where assignment.route_id = route.id and assignment.employee_id = actor_id and assignment.status <> 'canceled'
         )
    ), '[]'::jsonb),
    'locations', case when can_manage or public.has_effective_permission('patrol.routes.manage') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'siteId', site.id,
        'siteName', site.name,
        'siteCode', site.code,
        'postId', post.id,
        'postName', post.name,
        'requiresArmed', post.requires_armed,
        'addressLine1', site.address_line_1,
        'city', site.city,
        'region', site.region,
        'postalCode', site.postal_code,
        'timeZone', site.time_zone
      ) order by site.name, post.name)
      from public.sites site
      join public.posts post on post.site_id = site.id and post.active
      where site.active
    ), '[]'::jsonb) else '[]'::jsonb end,
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', assignment.id,
        'routeId', assignment.route_id,
        'routeVersionId', assignment.route_version_id,
        'routeName', route.name,
        'requiresArmed', route.requires_armed,
        'shiftId', assignment.shift_id,
        'employeeId', assignment.employee_id,
        'employeeName', concat_ws(' ', employee.first_name, employee.last_name),
        'serviceDate', assignment.service_date,
        'status', assignment.status,
        'startsAt', shift.starts_at,
        'endsAt', shift.ends_at,
        'timeZone', shift.time_zone,
        'obligations', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', obligation.id,
            'stopId', obligation.stop_id,
            'locationLabel', stop.location_label,
            'requirementId', obligation.requirement_id,
            'requirementLabel', requirement.requirement_label,
            'hitNumber', obligation.hit_number,
            'dueStartAt', obligation.due_start_at,
            'dueEndAt', obligation.due_end_at,
            'status', obligation.status,
            'completedHitId', obligation.completed_hit_id,
            'allowPhotos', stop.allow_photos,
            'allowVideos', stop.allow_videos,
            'requireEvidence', stop.require_evidence,
            'evidenceInstructions', stop.evidence_instructions,
            'locationConfigured', stop.latitude is not null
          ) order by stop.sequence_number, obligation.due_start_at, obligation.hit_number)
          from public.patrol_hit_obligations obligation
          join public.patrol_route_stops stop on stop.id = obligation.stop_id
          join public.patrol_stop_requirements requirement on requirement.id = obligation.requirement_id
          where obligation.assignment_id = assignment.id
        ), '[]'::jsonb),
        'hits', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', hit.id,
            'stopId', hit.stop_id,
            'locationLabel', stop.location_label,
            'obligationId', hit.obligation_id,
            'classification', hit.classification,
            'status', hit.status,
            'outcome', hit.outcome,
            'note', hit.note,
            'extraReason', hit.extra_reason,
            'locationStatus', hit.location_status,
            'submittedAt', hit.submitted_at,
            'evidence', coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', evidence.id,
                'kind', evidence.media_kind,
                'status', evidence.status,
                'filename', evidence.original_filename,
                'mimeType', evidence.mime_type,
                'byteSize', evidence.byte_size,
                'durationSeconds', evidence.duration_seconds,
                'createdAt', evidence.created_at
              ) order by evidence.created_at)
              from public.patrol_hit_evidence evidence
              where evidence.hit_id = hit.id and evidence.status <> 'deleted'
            ), '[]'::jsonb)
          ) order by hit.created_at desc)
          from public.patrol_hits hit
          join public.patrol_route_stops stop on stop.id = hit.stop_id
          where hit.assignment_id = assignment.id and hit.status <> 'invalidated'
        ), '[]'::jsonb)
      ) order by shift.starts_at desc)
      from public.patrol_assignments assignment
      join public.patrol_routes route on route.id = assignment.route_id
      join public.shifts shift on shift.id = assignment.shift_id
      join public.employees employee on employee.id = assignment.employee_id
      where (can_operate or assignment.employee_id = actor_id)
        and assignment.status <> 'canceled'
        and shift.ends_at >= now() - interval '14 days'
    ), '[]'::jsonb),
    'scheduleCandidates', case when can_manage or public.has_effective_permission('patrol.assignments.manage') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'shiftId', shift.id,
        'startsAt', shift.starts_at,
        'endsAt', shift.ends_at,
        'timeZone', shift.time_zone,
        'requiresArmed', shift.requires_armed,
        'siteName', site.name,
        'postName', post.name,
        'employeeId', assignment.employee_id,
        'employeeName', concat_ws(' ', employee.first_name, employee.last_name)
      ) order by shift.starts_at)
      from public.shifts shift
      join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
      join public.shift_assignments assignment on assignment.shift_id = shift.id and assignment.status in ('assigned', 'confirmed')
      join public.employees employee on employee.id = assignment.employee_id
      left join public.posts post on post.id = shift.post_id
      left join public.sites site on site.id = post.site_id
      where shift.ends_at >= now() - interval '1 day'
        and shift.starts_at <= now() + interval '60 days'
        and not exists (
          select 1 from public.patrol_assignments patrol_assignment
          where patrol_assignment.shift_id = shift.id and patrol_assignment.employee_id = assignment.employee_id and patrol_assignment.status <> 'canceled'
        )
      limit 100
    ), '[]'::jsonb) else '[]'::jsonb end,
    'makeupQueue', coalesce((
      select jsonb_agg(jsonb_build_object(
        'obligationId', obligation.id,
        'assignmentId', assignment.id,
        'routeName', route.name,
        'employeeId', assignment.employee_id,
        'employeeName', concat_ws(' ', employee.first_name, employee.last_name),
        'locationLabel', stop.location_label,
        'serviceDate', assignment.service_date,
        'dueEndAt', obligation.due_end_at,
        'status', obligation.status
      ) order by obligation.due_end_at desc)
      from public.patrol_hit_obligations obligation
      join public.patrol_assignments assignment on assignment.id = obligation.assignment_id
      join public.patrol_routes route on route.id = assignment.route_id
      join public.patrol_route_stops stop on stop.id = obligation.stop_id
      join public.employees employee on employee.id = assignment.employee_id
      where can_operate and obligation.status = 'missed'
        and not exists (select 1 from public.patrol_makeup_assignments makeup where makeup.obligation_id = obligation.id and makeup.status in ('assigned', 'completed'))
    ), '[]'::jsonb)
  ) into payload;

  return payload;
end
$$;

create or replace function public.save_patrol_route(target_route jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  route_id uuid;
  version_id uuid := gen_random_uuid();
  next_version integer;
  route_status text;
  route_code text;
  route_name text;
  route_time_zone text;
  stop_payload jsonb;
  requirement_payload jsonb;
  stop_id uuid;
  stable_key uuid;
  sequence_value integer := 0;
begin
  if actor_id is null or not (private.patrol_can_manage() or public.has_effective_permission('patrol.routes.manage')) then
    raise insufficient_privilege using message = 'Patrol Route Management permission is required.';
  end if;

  route_id := nullif(target_route ->> 'id', '')::uuid;
  route_code := lower(btrim(coalesce(target_route ->> 'code', '')));
  route_name := btrim(coalesce(target_route ->> 'name', ''));
  route_status := coalesce(nullif(target_route ->> 'status', ''), 'draft');
  route_time_zone := coalesce(nullif(target_route ->> 'timeZone', ''), 'America/Denver');
  if route_code !~ '^[a-z0-9][a-z0-9-]{1,62}$' or route_name = '' then
    raise exception using errcode = '22023', message = 'Route code and name are required.';
  end if;
  if route_status not in ('draft', 'active', 'paused', 'archived') then
    raise exception using errcode = '22023', message = 'Choose a valid route status.';
  end if;
  if route_time_zone not in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles') then
    raise exception using errcode = '22023', message = 'Choose a supported continental U.S. time zone.';
  end if;
  if jsonb_array_length(coalesce(target_route -> 'stops', '[]'::jsonb)) = 0 then
    raise exception using errcode = '22023', message = 'Add at least one route stop.';
  end if;

  if route_id is null then
    route_id := gen_random_uuid();
    insert into public.patrol_routes(id, code, name, requires_armed, status, time_zone, created_by, updated_by)
    values (route_id, route_code, route_name, coalesce((target_route ->> 'requiresArmed')::boolean, false), route_status, route_time_zone, actor_id, actor_id);
    next_version := 1;
  else
    perform 1 from public.patrol_routes where id = route_id for update;
    if not found then raise exception using errcode = 'P0002', message = 'Patrol route was not found.'; end if;
    select coalesce(max(version_number), 0) + 1 into next_version from public.patrol_route_versions where route_id = save_patrol_route.route_id;
    update public.patrol_routes
    set code = route_code,
        name = route_name,
        requires_armed = coalesce((target_route ->> 'requiresArmed')::boolean, false),
        status = route_status,
        time_zone = route_time_zone,
        updated_by = actor_id,
        updated_at = now()
    where id = route_id;
  end if;

  insert into public.patrol_route_versions(id, route_id, version_number, effective_from, effective_through, change_reason, created_by)
  values (
    version_id,
    route_id,
    next_version,
    nullif(target_route ->> 'effectiveFrom', '')::date,
    nullif(target_route ->> 'effectiveThrough', '')::date,
    btrim(coalesce(nullif(target_route ->> 'changeReason', ''), 'Initial route configuration')),
    actor_id
  );

  for stop_payload in select value from jsonb_array_elements(target_route -> 'stops') loop
    sequence_value := sequence_value + 1;
    stop_id := gen_random_uuid();
    stable_key := coalesce(nullif(stop_payload ->> 'stableKey', '')::uuid, gen_random_uuid());
    insert into public.patrol_route_stops(
      id, route_version_id, stable_key, sequence_number, location_label, site_id, post_id,
      address_line_1, city, region, postal_code, latitude, longitude, geofence_radius_meters,
      instructions, allow_photos, allow_videos, require_evidence, evidence_instructions,
      standard_video_limit_seconds, incident_video_limit_seconds
    ) values (
      stop_id, version_id, stable_key, sequence_value, btrim(coalesce(stop_payload ->> 'locationLabel', '')),
      nullif(stop_payload ->> 'siteId', '')::uuid, nullif(stop_payload ->> 'postId', '')::uuid,
      nullif(btrim(coalesce(stop_payload ->> 'addressLine1', '')), ''), nullif(btrim(coalesce(stop_payload ->> 'city', '')), ''),
      nullif(btrim(coalesce(stop_payload ->> 'region', '')), ''), nullif(btrim(coalesce(stop_payload ->> 'postalCode', '')), ''),
      nullif(stop_payload ->> 'latitude', '')::numeric, nullif(stop_payload ->> 'longitude', '')::numeric,
      nullif(stop_payload ->> 'geofenceRadiusMeters', '')::integer,
      nullif(btrim(coalesce(stop_payload ->> 'instructions', '')), ''),
      coalesce((stop_payload ->> 'allowPhotos')::boolean, true), coalesce((stop_payload ->> 'allowVideos')::boolean, true),
      coalesce((stop_payload ->> 'requireEvidence')::boolean, false), nullif(btrim(coalesce(stop_payload ->> 'evidenceInstructions', '')), ''),
      coalesce(nullif(stop_payload ->> 'standardVideoLimitSeconds', '')::integer, 180),
      coalesce(nullif(stop_payload ->> 'incidentVideoLimitSeconds', '')::integer, 900)
    );
    if btrim(coalesce(stop_payload ->> 'locationLabel', '')) = '' then
      raise exception using errcode = '22023', message = 'Every patrol stop needs a location name.';
    end if;

    for requirement_payload in select value from jsonb_array_elements(coalesce(stop_payload -> 'requirements', '[]'::jsonb)) loop
      insert into public.patrol_stop_requirements(
        stop_id, day_of_week, requirement_label, required_hits, status, window_start, window_end,
        minimum_spacing_minutes, sequence_required
      ) values (
        stop_id,
        (requirement_payload ->> 'dayOfWeek')::smallint,
        btrim(coalesce(nullif(requirement_payload ->> 'label', ''), 'Night patrol')),
        (requirement_payload ->> 'requiredHits')::integer,
        coalesce(nullif(requirement_payload ->> 'status', ''), 'active'),
        nullif(requirement_payload ->> 'windowStart', '')::time,
        nullif(requirement_payload ->> 'windowEnd', '')::time,
        nullif(requirement_payload ->> 'minimumSpacingMinutes', '')::integer,
        coalesce((requirement_payload ->> 'sequenceRequired')::boolean, false)
      );
    end loop;
  end loop;

  update public.patrol_routes set current_version_id = version_id, updated_at = now() where id = route_id;
  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values ((select auth.uid()), actor_id, 'public', 'patrol_routes', case when next_version = 1 then 'insert' else 'version' end, route_id::text,
    jsonb_build_object('routeId', route_id, 'versionId', version_id, 'versionNumber', next_version, 'status', route_status, 'changeReason', target_route ->> 'changeReason'));
  return route_id;
end
$$;

create or replace function public.link_patrol_route_shift(target_route_id uuid, target_shift_id uuid, target_employee_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  route_record public.patrol_routes%rowtype;
  shift_record public.shifts%rowtype;
  assignment_id uuid;
  local_day smallint;
  local_date date;
  requirement_record record;
  counter integer;
begin
  if actor_id is null or not (private.patrol_can_manage() or public.has_effective_permission('patrol.assignments.manage')) then
    raise insufficient_privilege using message = 'Patrol Assignment Management permission is required.';
  end if;
  select * into route_record from public.patrol_routes where id = target_route_id and status = 'active' and current_version_id is not null;
  if not found then raise exception using errcode = '22023', message = 'Activate the patrol route before assigning it.'; end if;
  select shift.* into shift_record
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
  join public.shift_assignments assigned on assigned.shift_id = shift.id and assigned.employee_id = target_employee_id and assigned.status in ('assigned', 'confirmed')
  where shift.id = target_shift_id;
  if not found then raise exception using errcode = '22023', message = 'Choose a published shift assigned to this employee.'; end if;
  if route_record.requires_armed and not shift_record.requires_armed then
    raise exception using errcode = '22023', message = 'An armed patrol route must be linked to an armed shift.';
  end if;

  local_day := extract(dow from shift_record.starts_at at time zone route_record.time_zone)::smallint;
  local_date := (shift_record.starts_at at time zone route_record.time_zone)::date;
  insert into public.patrol_assignments(route_id, route_version_id, shift_id, employee_id, service_date, assigned_by)
  values (route_record.id, route_record.current_version_id, target_shift_id, target_employee_id, local_date, actor_id)
  on conflict (route_version_id, shift_id, employee_id) do update set status = 'active', canceled_at = null, cancellation_reason = null
  returning id into assignment_id;

  for requirement_record in
    select requirement.*, stop.sequence_number
    from public.patrol_stop_requirements requirement
    join public.patrol_route_stops stop on stop.id = requirement.stop_id
    where stop.route_version_id = route_record.current_version_id
      and requirement.day_of_week = local_day
      and requirement.status = 'active'
    order by stop.sequence_number, requirement.requirement_label
  loop
    for counter in 1..requirement_record.required_hits loop
      insert into public.patrol_hit_obligations(
        assignment_id, stop_id, requirement_id, hit_number, due_start_at, due_end_at
      ) values (
        assignment_id,
        requirement_record.stop_id,
        requirement_record.id,
        counter,
        case when requirement_record.window_start is null then shift_record.starts_at
             else (local_date + requirement_record.window_start) at time zone route_record.time_zone end,
        case when requirement_record.window_end is null then shift_record.ends_at
             when requirement_record.window_end > requirement_record.window_start then (local_date + requirement_record.window_end) at time zone route_record.time_zone
             else (local_date + 1 + requirement_record.window_end) at time zone route_record.time_zone end
      ) on conflict (assignment_id, requirement_id, hit_number) do nothing;
    end loop;
  end loop;

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values ((select auth.uid()), actor_id, 'public', 'patrol_assignments', 'link_shift', assignment_id::text,
    jsonb_build_object('routeId', route_record.id, 'routeVersionId', route_record.current_version_id, 'shiftId', target_shift_id, 'employeeId', target_employee_id));
  return assignment_id;
end
$$;

create or replace function public.save_patrol_hit(
  target_hit_id uuid,
  target_assignment_id uuid,
  target_stop_id uuid,
  target_obligation_id uuid,
  target_makeup_assignment_id uuid,
  target_classification text,
  target_outcome text,
  target_note text,
  target_extra_reason text,
  target_location_status text,
  target_latitude numeric,
  target_longitude numeric,
  target_accuracy_meters numeric,
  target_client_recorded_at timestamptz,
  target_idempotency_key uuid,
  target_submit boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  can_manage boolean;
  hit_id uuid;
  assignment_record public.patrol_assignments%rowtype;
  stop_record public.patrol_route_stops%rowtype;
  stored_evidence_count integer;
  resolved_location_status text;
  distance_meters numeric;
  obligation_record record;
  previous_submitted_at timestamptz;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active SygShift account is required.'; end if;
  can_manage := private.patrol_can_manage() or public.has_effective_permission('patrol.exceptions.manage');
  if not (public.has_effective_permission('patrol.hits.complete') or can_manage) then
    raise insufficient_privilege using message = 'Patrol Hit Completion permission is required.';
  end if;
  if target_classification = 'extra' and not (public.has_effective_permission('patrol.hits.extra') or can_manage) then
    raise insufficient_privilege using message = 'Extra Patrol Hit permission is required.';
  end if;

  select * into assignment_record from public.patrol_assignments where id = target_assignment_id and status = 'active';
  if not found or (assignment_record.employee_id <> actor_id and not can_manage) then
    raise insufficient_privilege using message = 'This active patrol assignment is not available to you.';
  end if;
  select * into stop_record from public.patrol_route_stops where id = target_stop_id and route_version_id = assignment_record.route_version_id;
  if not found then raise exception using errcode = '22023', message = 'Choose a stop from this patrol route.'; end if;
  if stop_record.latitude is null then
    resolved_location_status := 'not_configured';
  elsif target_latitude is null or target_longitude is null then
    resolved_location_status := case when target_location_status = 'declined' then 'declined' else 'unavailable' end;
  else
    distance_meters := 6371000 * 2 * asin(sqrt(
      power(sin(radians((target_latitude - stop_record.latitude)::double precision) / 2), 2)
      + cos(radians(stop_record.latitude::double precision)) * cos(radians(target_latitude::double precision))
      * power(sin(radians((target_longitude - stop_record.longitude)::double precision) / 2), 2)
    ));
    resolved_location_status := case when distance_meters <= coalesce(stop_record.geofence_radius_meters, 250) then 'verified' else 'outside_geofence' end;
  end if;
  if target_classification = 'required' then
    select obligation.*, requirement.minimum_spacing_minutes, requirement.sequence_required, stop.sequence_number
    into obligation_record
    from public.patrol_hit_obligations obligation
    join public.patrol_stop_requirements requirement on requirement.id = obligation.requirement_id
    join public.patrol_route_stops stop on stop.id = obligation.stop_id
    where obligation.id = target_obligation_id
      and obligation.assignment_id = assignment_record.id
      and obligation.stop_id = stop_record.id
      and obligation.status <> 'completed';
    if not found then raise exception using errcode = '22023', message = 'Choose an incomplete required patrol hit.'; end if;
  end if;
  if target_classification = 'makeup' and not exists (
    select 1 from public.patrol_makeup_assignments makeup where makeup.id = target_makeup_assignment_id and makeup.obligation_id = target_obligation_id and makeup.assigned_patrol_assignment_id = assignment_record.id and makeup.assigned_to = actor_id and makeup.status = 'assigned'
  ) then raise exception using errcode = '22023', message = 'Choose an active makeup assignment.'; end if;

  if target_hit_id is null then
    insert into public.patrol_hits(
      assignment_id, stop_id, obligation_id, makeup_assignment_id, classification, outcome, note, extra_reason,
      location_status, latitude, longitude, accuracy_meters, client_recorded_at, submitted_by, idempotency_key
    ) values (
      assignment_record.id, stop_record.id, target_obligation_id, target_makeup_assignment_id, target_classification,
      nullif(target_outcome, ''), nullif(btrim(coalesce(target_note, '')), ''), nullif(btrim(coalesce(target_extra_reason, '')), ''),
      resolved_location_status,
      target_latitude, target_longitude, target_accuracy_meters, target_client_recorded_at, actor_id, target_idempotency_key
    ) on conflict (submitted_by, idempotency_key) do update set updated_at = now()
    returning id into hit_id;
  else
    select id into hit_id from public.patrol_hits where id = target_hit_id and status = 'draft' and (submitted_by = actor_id or can_manage) for update;
    if hit_id is null then raise exception using errcode = '22023', message = 'The patrol hit draft is no longer editable.'; end if;
    update public.patrol_hits
    set outcome = nullif(target_outcome, ''), note = nullif(btrim(coalesce(target_note, '')), ''),
        extra_reason = nullif(btrim(coalesce(target_extra_reason, '')), ''),
        location_status = resolved_location_status,
        latitude = target_latitude, longitude = target_longitude, accuracy_meters = target_accuracy_meters,
        client_recorded_at = target_client_recorded_at, updated_at = now()
    where id = hit_id;
  end if;

  if target_submit then
    if not private.patrol_note_is_meaningful(target_note) then
      raise exception using errcode = '22023', message = 'Add a meaningful patrol note with at least 20 characters and four words.';
    end if;
    if target_outcome not in ('secure', 'attention_needed', 'incident', 'unable_to_access', 'other') then
      raise exception using errcode = '22023', message = 'Choose the patrol outcome.';
    end if;
    if target_classification = 'required' and obligation_record.minimum_spacing_minutes is not null then
      select max(prior_hit.submitted_at) into previous_submitted_at
      from public.patrol_hits prior_hit
      join public.patrol_hit_obligations prior_obligation on prior_obligation.id = prior_hit.obligation_id
      where prior_obligation.assignment_id = assignment_record.id
        and prior_obligation.requirement_id = obligation_record.requirement_id
        and prior_hit.status = 'submitted';
      if previous_submitted_at is not null and now() < previous_submitted_at + make_interval(mins => obligation_record.minimum_spacing_minutes) then
        raise exception using errcode = '22023', message = format('Wait until the configured %s-minute spacing has elapsed before submitting this hit.', obligation_record.minimum_spacing_minutes);
      end if;
    end if;
    if target_classification = 'required' and obligation_record.sequence_required and exists (
      select 1
      from public.patrol_hit_obligations earlier
      join public.patrol_route_stops earlier_stop on earlier_stop.id = earlier.stop_id
      where earlier.assignment_id = assignment_record.id
        and earlier_stop.sequence_number < obligation_record.sequence_number
        and earlier.status not in ('completed', 'waived')
    ) then
      raise exception using errcode = '22023', message = 'Complete the earlier route stops before submitting this sequence-controlled hit.';
    end if;
    select count(*) into stored_evidence_count from public.patrol_hit_evidence where hit_id = save_patrol_hit.hit_id and status = 'stored';
    if stop_record.require_evidence and stored_evidence_count = 0 then
      raise exception using errcode = '22023', message = 'This stop requires a photo or video before submission.';
    end if;
    update public.patrol_hits set status = 'submitted', submitted_at = now(), updated_at = now() where id = hit_id;
    if target_classification = 'required' then
      update public.patrol_hit_obligations set status = 'completed', completed_hit_id = hit_id, reconciled_at = now() where id = target_obligation_id;
    elsif target_classification = 'makeup' then
      update public.patrol_makeup_assignments set status = 'completed', completed_hit_id = hit_id, completed_at = now() where id = target_makeup_assignment_id;
    end if;
    insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
    values ((select auth.uid()), actor_id, 'public', 'patrol_hits', 'submit', hit_id::text,
      jsonb_build_object('assignmentId', assignment_record.id, 'stopId', stop_record.id, 'classification', target_classification, 'outcome', target_outcome, 'locationStatus', resolved_location_status, 'distanceMeters', distance_meters, 'evidenceCount', stored_evidence_count));
  end if;
  return hit_id;
end
$$;

create or replace function public.assign_patrol_makeup(target_obligation_id uuid, target_assignment_id uuid, target_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id(); makeup_id uuid; employee_id uuid;
begin
  if actor_id is null or not (private.patrol_can_manage() or public.has_effective_permission('patrol.exceptions.manage')) then
    raise insufficient_privilege using message = 'Patrol Exception Management permission is required.';
  end if;
  if not exists (select 1 from public.patrol_hit_obligations where id = target_obligation_id and status = 'missed') then
    raise exception using errcode = '22023', message = 'Only a missed patrol hit can be assigned for makeup.';
  end if;
  select assignment.employee_id into employee_id from public.patrol_assignments assignment where assignment.id = target_assignment_id and assignment.status = 'active';
  if employee_id is null then raise exception using errcode = '22023', message = 'Choose an active patrol assignment for the makeup hit.'; end if;
  insert into public.patrol_makeup_assignments(obligation_id, assigned_patrol_assignment_id, assigned_to, reason, assigned_by)
  values (target_obligation_id, target_assignment_id, employee_id, btrim(target_reason), actor_id)
  returning id into makeup_id;
  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values ((select auth.uid()), actor_id, 'public', 'patrol_makeup_assignments', 'assign', makeup_id::text,
    jsonb_build_object('obligationId', target_obligation_id, 'assignmentId', target_assignment_id, 'assignedTo', employee_id, 'reason', btrim(target_reason)));
  return makeup_id;
end
$$;

create or replace function public.get_patrol_report(target_from date, target_through date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id(); payload jsonb;
begin
  if actor_id is null or not (
    private.patrol_can_manage() or public.has_effective_permission('patrol.reports.view') or public.has_effective_permission('reports.view')
  ) then raise insufficient_privilege using message = 'Patrol Report access is required.'; end if;
  if target_from is null or target_through is null or target_through < target_from or target_through - target_from > 366 then
    raise exception using errcode = '22023', message = 'Choose a valid report range of 366 days or fewer.';
  end if;
  perform private.reconcile_patrol_obligations();
  select jsonb_build_object(
    'generatedAt', now(),
    'canExport', private.patrol_can_manage() or public.has_effective_permission('patrol.reports.export'),
    'summary', jsonb_build_object(
      'required', count(*) filter (where obligation.id is not null),
      'completed', count(*) filter (where obligation.status = 'completed'),
      'missed', count(*) filter (where obligation.status = 'missed'),
      'extra', (select count(*) from public.patrol_hits extra_hit join public.patrol_assignments extra_assignment on extra_assignment.id = extra_hit.assignment_id where extra_hit.classification = 'extra' and extra_hit.status = 'submitted' and extra_assignment.service_date between target_from and target_through),
      'incidents', (select count(*) from public.patrol_hits incident_hit join public.patrol_assignments incident_assignment on incident_assignment.id = incident_hit.assignment_id where incident_hit.outcome = 'incident' and incident_hit.status = 'submitted' and incident_assignment.service_date between target_from and target_through),
      'evidence', (select count(*) from public.patrol_hit_evidence evidence join public.patrol_hits evidence_hit on evidence_hit.id = evidence.hit_id join public.patrol_assignments evidence_assignment on evidence_assignment.id = evidence_hit.assignment_id where evidence.status = 'stored' and evidence_assignment.service_date between target_from and target_through)
    ),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'obligationId', obligation.id,
      'serviceDate', assignment.service_date,
      'routeName', route.name,
      'armed', route.requires_armed,
      'employeeName', concat_ws(' ', employee.first_name, employee.last_name),
      'employeeNumber', employee.employee_number,
      'locationLabel', stop.location_label,
      'requirementLabel', requirement.requirement_label,
      'hitNumber', obligation.hit_number,
      'dueStartAt', obligation.due_start_at,
      'dueEndAt', obligation.due_end_at,
      'status', obligation.status,
      'completedAt', hit.submitted_at,
      'outcome', hit.outcome,
      'note', hit.note,
      'locationStatus', hit.location_status,
      'evidenceCount', (select count(*) from public.patrol_hit_evidence evidence where evidence.hit_id = hit.id and evidence.status = 'stored')
    ) order by assignment.service_date desc, route.name, stop.sequence_number, obligation.hit_number) filter (where obligation.id is not null), '[]'::jsonb)
  ) into payload
  from public.patrol_assignments assignment
  join public.patrol_routes route on route.id = assignment.route_id
  join public.employees employee on employee.id = assignment.employee_id
  join public.patrol_hit_obligations obligation on obligation.assignment_id = assignment.id
  join public.patrol_route_stops stop on stop.id = obligation.stop_id
  join public.patrol_stop_requirements requirement on requirement.id = obligation.requirement_id
  left join public.patrol_hits hit on hit.id = obligation.completed_hit_id and hit.status = 'submitted'
  where assignment.service_date between target_from and target_through and assignment.status <> 'canceled';
  return payload;
end
$$;

create or replace function public.authorize_patrol_report_export(target_from date, target_through date, target_profile text, target_format text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id(); audit_id bigint;
begin
  if actor_id is null or not (private.patrol_can_manage() or public.has_effective_permission('patrol.reports.export')) then
    raise insufficient_privilege using message = 'Patrol Report Export permission is required.';
  end if;
  if target_profile not in ('internal', 'client') or target_format not in ('xlsx', 'csv', 'pdf') then
    raise exception using errcode = '22023', message = 'Choose an approved report profile and format.';
  end if;
  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values ((select auth.uid()), actor_id, 'public', 'patrol_reports', 'export', null,
    jsonb_build_object('from', target_from, 'through', target_through, 'profile', target_profile, 'format', target_format))
  returning id into audit_id;
  return jsonb_build_object('authorizedAt', now(), 'auditId', audit_id);
end
$$;

-- Service-only evidence lifecycle used by the Worker. The browser receives only a
-- short-lived signed upload token for one random private object key.
create or replace function public.service_begin_patrol_evidence_upload(
  target_actor_id uuid,
  target_hit_id uuid,
  target_media_kind text,
  target_original_filename text,
  target_mime_type text,
  target_byte_size bigint,
  target_duration_seconds integer,
  target_idempotency_key uuid,
  target_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare hit_record record; evidence_id uuid; object_key text; max_seconds integer;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  select hit.*, assignment.employee_id, stop.allow_photos, stop.allow_videos, stop.standard_video_limit_seconds, stop.incident_video_limit_seconds
  into hit_record
  from public.patrol_hits hit
  join public.patrol_assignments assignment on assignment.id = hit.assignment_id
  join public.patrol_route_stops stop on stop.id = hit.stop_id
  where hit.id = target_hit_id and hit.status = 'draft';
  if not found then raise exception using errcode = '22023', message = 'The patrol hit draft is not available for evidence.'; end if;
  if not (hit_record.employee_id = target_actor_id and 'patrol.evidence.upload' = any(private.employee_effective_permissions(target_actor_id))) then
    raise insufficient_privilege using message = 'This patrol hit is not available to you.';
  end if;
  if target_media_kind = 'photo' and (not hit_record.allow_photos or target_mime_type not in ('image/jpeg', 'image/png', 'image/webp') or target_byte_size > 26214400) then
    raise exception using errcode = '22023', message = 'This stop does not accept that photo.';
  elsif target_media_kind = 'video' then
    max_seconds := case when hit_record.outcome = 'incident' then hit_record.incident_video_limit_seconds else hit_record.standard_video_limit_seconds end;
    if not hit_record.allow_videos or target_mime_type not in ('video/mp4', 'video/webm', 'video/quicktime') or target_byte_size > 524288000 or target_duration_seconds is null or target_duration_seconds > max_seconds then
      raise exception using errcode = '22023', message = format('This stop accepts videos up to %s minutes and 500 MB.', ceil(max_seconds / 60.0));
    end if;
  else
    raise exception using errcode = '22023', message = 'Choose an approved photo or video.';
  end if;
  evidence_id := gen_random_uuid();
  object_key := concat(target_actor_id, '/', target_hit_id, '/', evidence_id, '-', regexp_replace(lower(target_original_filename), '[^a-z0-9._-]+', '-', 'g'));
  insert into public.patrol_hit_evidence(id, hit_id, media_kind, object_key, original_filename, mime_type, byte_size, duration_seconds, idempotency_key, uploaded_by)
  values (evidence_id, target_hit_id, target_media_kind, object_key, left(target_original_filename, 255), target_mime_type, target_byte_size, target_duration_seconds, target_idempotency_key, target_actor_id)
  on conflict (uploaded_by, idempotency_key) do update set original_filename = excluded.original_filename
  returning id, patrol_hit_evidence.object_key into evidence_id, object_key;
  insert into private.audit_events(employee_id, request_id, schema_name, table_name, operation, row_id, new_record)
  values (target_actor_id, target_request_id, 'public', 'patrol_hit_evidence', 'authorize_upload', evidence_id::text,
    jsonb_build_object('hitId', target_hit_id, 'kind', target_media_kind, 'mimeType', target_mime_type, 'byteSize', target_byte_size, 'durationSeconds', target_duration_seconds));
  return jsonb_build_object('evidenceId', evidence_id, 'bucket', 'patrol-evidence', 'objectKey', object_key);
end
$$;

create or replace function public.service_complete_patrol_evidence_upload(
  target_actor_id uuid,
  target_evidence_id uuid,
  target_observed_byte_size bigint,
  target_observed_mime_type text,
  target_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare evidence_record public.patrol_hit_evidence%rowtype;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  select * into evidence_record from public.patrol_hit_evidence where id = target_evidence_id for update;
  if not found or evidence_record.uploaded_by <> target_actor_id then raise insufficient_privilege using message = 'This evidence upload is not available to you.'; end if;
  if evidence_record.status = 'stored' then return jsonb_build_object('evidenceId', evidence_record.id, 'status', 'stored'); end if;
  if target_observed_byte_size <> evidence_record.byte_size or lower(split_part(target_observed_mime_type, ';', 1)) <> evidence_record.mime_type then
    update public.patrol_hit_evidence set status = 'failed' where id = target_evidence_id;
    raise exception using errcode = '22023', message = 'The stored evidence does not match the authorized file.';
  end if;
  update public.patrol_hit_evidence set status = 'stored', stored_at = now() where id = target_evidence_id;
  insert into private.audit_events(employee_id, request_id, schema_name, table_name, operation, row_id, new_record)
  values (target_actor_id, target_request_id, 'public', 'patrol_hit_evidence', 'store', target_evidence_id::text,
    jsonb_build_object('hitId', evidence_record.hit_id, 'kind', evidence_record.media_kind, 'byteSize', evidence_record.byte_size));
  return jsonb_build_object('evidenceId', target_evidence_id, 'status', 'stored');
end
$$;

create or replace function public.service_fail_patrol_evidence_upload(
  target_actor_id uuid,
  target_evidence_id uuid,
  target_failure_code text,
  target_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare evidence_record public.patrol_hit_evidence%rowtype;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  select * into evidence_record from public.patrol_hit_evidence where id = target_evidence_id for update;
  if not found or evidence_record.uploaded_by <> target_actor_id then raise insufficient_privilege using message = 'This evidence upload is not available to you.'; end if;
  update public.patrol_hit_evidence set status = 'failed' where id = target_evidence_id and status = 'pending_upload';
  insert into private.audit_events(employee_id, request_id, schema_name, table_name, operation, row_id, new_record)
  values (target_actor_id, target_request_id, 'public', 'patrol_hit_evidence', 'upload_failed', target_evidence_id::text,
    jsonb_build_object('hitId', evidence_record.hit_id, 'failureCode', left(target_failure_code, 100)));
  return jsonb_build_object('evidenceId', target_evidence_id, 'status', 'failed');
end
$$;

create or replace function public.service_get_patrol_evidence_access(target_actor_id uuid, target_evidence_id uuid, target_action text, target_request_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare evidence_record record; can_access boolean;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if target_action not in ('preview', 'download') then raise exception using errcode = '22023', message = 'Choose preview or download.'; end if;
  select evidence.*, assignment.employee_id into evidence_record
  from public.patrol_hit_evidence evidence
  join public.patrol_hits hit on hit.id = evidence.hit_id
  join public.patrol_assignments assignment on assignment.id = hit.assignment_id
  where evidence.id = target_evidence_id and evidence.status = 'stored';
  if not found then raise exception using errcode = 'P0002', message = 'Patrol evidence was not found.'; end if;
  can_access := evidence_record.employee_id = target_actor_id
    or 'patrol.manage' = any(private.employee_effective_permissions(target_actor_id))
    or 'patrol.evidence.view' = any(private.employee_effective_permissions(target_actor_id));
  if not can_access then raise insufficient_privilege using message = 'Patrol Evidence access is required.'; end if;
  insert into private.audit_events(employee_id, request_id, schema_name, table_name, operation, row_id, new_record)
  values (target_actor_id, target_request_id, 'public', 'patrol_hit_evidence', target_action, target_evidence_id::text,
    jsonb_build_object('hitId', evidence_record.hit_id, 'action', target_action));
  return jsonb_build_object('bucket', evidence_record.bucket_name, 'objectKey', evidence_record.object_key,
    'filename', evidence_record.original_filename, 'mimeType', evidence_record.mime_type, 'action', target_action,
    'ownerEmployeeId', evidence_record.employee_id);
end
$$;

create or replace function public.service_reconcile_patrol_obligations()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  return jsonb_build_object('updated', private.reconcile_patrol_obligations(), 'ranAt', now());
end
$$;

revoke all on function public.get_patrol_workspace() from public, anon;
revoke all on function public.save_patrol_route(jsonb) from public, anon;
revoke all on function public.link_patrol_route_shift(uuid, uuid, uuid) from public, anon;
revoke all on function public.save_patrol_hit(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, numeric, numeric, numeric, timestamptz, uuid, boolean) from public, anon;
revoke all on function public.assign_patrol_makeup(uuid, uuid, text) from public, anon;
revoke all on function public.get_patrol_report(date, date) from public, anon;
revoke all on function public.authorize_patrol_report_export(date, date, text, text) from public, anon;
revoke all on function public.service_begin_patrol_evidence_upload(uuid, uuid, text, text, text, bigint, integer, uuid, text) from public, anon, authenticated;
revoke all on function public.service_complete_patrol_evidence_upload(uuid, uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.service_fail_patrol_evidence_upload(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.service_get_patrol_evidence_access(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.service_reconcile_patrol_obligations() from public, anon, authenticated;

grant execute on function public.get_patrol_workspace() to authenticated;
grant execute on function public.save_patrol_route(jsonb) to authenticated;
grant execute on function public.link_patrol_route_shift(uuid, uuid, uuid) to authenticated;
grant execute on function public.save_patrol_hit(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, numeric, numeric, numeric, timestamptz, uuid, boolean) to authenticated;
grant execute on function public.assign_patrol_makeup(uuid, uuid, text) to authenticated;
grant execute on function public.get_patrol_report(date, date) to authenticated;
grant execute on function public.authorize_patrol_report_export(date, date, text, text) to authenticated;
grant execute on function public.service_begin_patrol_evidence_upload(uuid, uuid, text, text, text, bigint, integer, uuid, text) to service_role;
grant execute on function public.service_complete_patrol_evidence_upload(uuid, uuid, bigint, text, text) to service_role;
grant execute on function public.service_fail_patrol_evidence_upload(uuid, uuid, text, text) to service_role;
grant execute on function public.service_get_patrol_evidence_access(uuid, uuid, text, text) to service_role;
grant execute on function public.service_reconcile_patrol_obligations() to service_role;

-- Deterministic route seeds without relying on names of real Site/Post records.
with actor as (
  select employee.id from public.employees employee where employee.role = 'admin' and employee.status = 'active' order by employee.created_at limit 1
), seed(code, name, requires_armed) as (
  values ('mg-properties-patrol', 'MG Properties Patrol', false), ('patrol-hits-armed', 'Patrol hits (not MG properties)', true)
)
insert into public.patrol_routes(code, name, requires_armed, status, time_zone, created_by, updated_by)
select seed.code, seed.name, seed.requires_armed, 'draft', 'America/Denver', actor.id, actor.id from seed cross join actor
on conflict (code) do nothing;

with actor as (
  select employee.id from public.employees employee where employee.role = 'admin' and employee.status = 'active' order by employee.created_at limit 1
), routes as (
  select route.id from public.patrol_routes route where route.code in ('mg-properties-patrol', 'patrol-hits-armed') and route.current_version_id is null
)
insert into public.patrol_route_versions(route_id, version_number, change_reason, created_by)
select routes.id, 1, 'Initial route configuration from the approved patrol spreadsheet', actor.id from routes cross join actor;

update public.patrol_routes route
set current_version_id = version.id
from public.patrol_route_versions version
where version.route_id = route.id and version.version_number = 1 and route.current_version_id is null;

with stop_seed(route_code, sequence_number, location_label, allow_photos, allow_videos) as (
  values
    ('mg-properties-patrol', 1, 'Stone Cliff Apts', true, true),
    ('mg-properties-patrol', 2, 'Malbec', true, true),
    ('mg-properties-patrol', 3, 'Neon Local', true, true),
    ('mg-properties-patrol', 4, 'Bear Valley Park', true, true),
    ('mg-properties-patrol', 5, 'Elm Grove', true, true),
    ('mg-properties-patrol', 6, 'Syracuse', true, true),
    ('patrol-hits-armed', 1, 'Cherry Tree', true, true),
    ('patrol-hits-armed', 2, 'Hestia', true, true),
    ('patrol-hits-armed', 3, 'Parc at CC', true, true),
    ('patrol-hits-armed', 4, 'Anythink', true, true),
    ('patrol-hits-armed', 5, 'PERA-W', true, true)
)
insert into public.patrol_route_stops(route_version_id, sequence_number, location_label, allow_photos, allow_videos, require_evidence, evidence_instructions)
select route.current_version_id, seed.sequence_number, seed.location_label, seed.allow_photos, seed.allow_videos, false,
  'Evidence is optional unless management enables the requirement for a future route version.'
from stop_seed seed
join public.patrol_routes route on route.code = seed.route_code
where not exists (select 1 from public.patrol_route_stops stop where stop.route_version_id = route.current_version_id and stop.sequence_number = seed.sequence_number);

with weekdays(day_of_week) as (values (0),(1),(2),(3),(4),(5),(6)),
requirements(route_code, location_label, day_of_week, label, hit_count, status) as (
  select 'mg-properties-patrol', 'Stone Cliff Apts', d.day_of_week, 'Night patrol', case when d.day_of_week in (5,6) then 2 else 1 end, 'active' from weekdays d
  union all select 'mg-properties-patrol', 'Malbec', d.day_of_week, 'Night patrol', 1, 'active' from weekdays d
  union all select 'mg-properties-patrol', 'Neon Local', d.day_of_week, 'Night patrol', 4, 'active' from weekdays d where d.day_of_week in (1,2,3)
  union all select 'mg-properties-patrol', 'Bear Valley Park', d.day_of_week, 'Night patrol', 1, 'active' from weekdays d
  union all select 'mg-properties-patrol', 'Elm Grove', d.day_of_week, 'Night patrol', 3, 'paused' from weekdays d where d.day_of_week in (0,5,6)
  union all select 'mg-properties-patrol', 'Syracuse', d.day_of_week, 'Night patrol', 4, 'active' from weekdays d where d.day_of_week in (1,2,3,4)
  union all select 'patrol-hits-armed', 'Cherry Tree', d.day_of_week, 'Night patrol', 4, 'active' from weekdays d
  union all select 'patrol-hits-armed', 'Hestia', d.day_of_week, 'Night patrol', 4, 'active' from weekdays d
  union all select 'patrol-hits-armed', 'Parc at CC', d.day_of_week, 'Night patrol', 4, 'active' from weekdays d
  union all select 'patrol-hits-armed', 'Anythink', d.day_of_week, 'Night patrol', 11, 'active' from weekdays d
  union all select 'patrol-hits-armed', 'Anythink', 1, 'Day shift', 2, 'active'
  union all select 'patrol-hits-armed', 'PERA-W', 6, 'Night patrol', 1, 'active'
)
insert into public.patrol_stop_requirements(stop_id, day_of_week, requirement_label, required_hits, status)
select stop.id, requirements.day_of_week, requirements.label, requirements.hit_count, requirements.status
from requirements
join public.patrol_routes route on route.code = requirements.route_code
join public.patrol_route_stops stop on stop.route_version_id = route.current_version_id and stop.location_label = requirements.location_label
on conflict (stop_id, day_of_week, requirement_label) do nothing;

do $$
declare baseline patrol_release_baseline%rowtype;
begin
  select * into baseline from patrol_release_baseline;
  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.schedule_count <> (select count(*) from public.schedules)
    or baseline.shift_count <> (select count(*) from public.shifts)
    or baseline.assignment_count <> (select count(*) from public.shift_assignments)
    or baseline.time_event_count <> (select count(*) from public.time_events)
    or baseline.access_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.permission_override_count <> (select count(*) from public.employee_permission_overrides)
  then
    raise exception 'Patrol release preservation check failed; existing workforce data changed unexpectedly.';
  end if;
end
$$;

commit;
