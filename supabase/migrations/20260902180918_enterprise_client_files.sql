begin;

create temporary table client_file_release_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.sites) as site_count,
  (select count(*) from public.posts) as post_count,
  (select count(*) from public.shifts) as shift_count,
  (select count(*) from public.shift_assignments) as assignment_count,
  (select count(*) from public.time_events) as time_event_count,
  (select count(*) from public.employee_access_roles) as access_role_count,
  (select count(*) from public.employee_permission_overrides) as permission_override_count,
  (select count(*) from public.patrol_routes) as patrol_route_count,
  (select count(*) from public.patrol_hits) as patrol_hit_count;

insert into public.permission_catalog (code, category, name, description, risk_level, requires_mfa, locked, active)
values
  ('clients.view', 'Client Files', 'View client files', 'View client profiles, contacts, linked sites, and nonrestricted operational summaries.', 'sensitive', true, true, true),
  ('clients.manage', 'Client Files', 'Manage client files', 'Create and maintain client profiles, contacts, service status, and site relationships.', 'critical', true, true, true),
  ('clients.documents.view', 'Client Files', 'View client documents', 'View and download approved client-file documents.', 'sensitive', true, true, true),
  ('clients.documents.manage', 'Client Files', 'Manage client documents', 'Upload, classify, replace, and archive client-file documents.', 'critical', true, true, true),
  ('clients.contracts.view', 'Client Files', 'View contracts and pricing', 'View highly restricted proposals, contracts, amendments, and pricing records.', 'critical', true, true, true),
  ('clients.activity.view', 'Client Files', 'View client activity', 'View linked shifts, patrol hits, reports, incidents, and service history.', 'sensitive', true, true, true),
  ('clients.activity.manage', 'Client Files', 'Manage client activity', 'Create and correct client service records without rewriting source operational records.', 'critical', true, true, true),
  ('clients.reports.export', 'Client Files', 'Export client reporting', 'Export filtered client activity and status reports.', 'critical', true, true, true),
  ('clients.import.manage', 'Client Files', 'Manage client imports', 'Review and promote staged client source rows into controlled Client Files.', 'critical', true, true, true),
  ('clients.portal.publish', 'Client Files', 'Publish client portal records', 'Approve, publish, withdraw, and audit client-visible records for a future portal.', 'critical', true, true, true)
on conflict (code) do update set
  category = excluded.category,
  name = excluded.name,
  description = excluded.description,
  risk_level = excluded.risk_level,
  requires_mfa = excluded.requires_mfa,
  locked = excluded.locked,
  active = true,
  updated_at = now();

insert into public.access_role_permissions(role_id, permission_code, enabled)
select role.id, permission.code, true
from public.access_roles role
cross join public.permission_catalog permission
where role.code = 'system_admin' and permission.code like 'clients.%'
on conflict (role_id, permission_code) do update set enabled = true, updated_at = now();

insert into public.access_role_permissions(role_id, permission_code, enabled)
select role.id, permission.code, true
from public.access_roles role
cross join public.permission_catalog permission
where role.code = 'operations_manager'
  and permission.code in (
    'clients.view', 'clients.manage', 'clients.documents.view', 'clients.documents.manage',
    'clients.activity.view', 'clients.activity.manage', 'clients.reports.export', 'clients.import.manage'
  )
on conflict (role_id, permission_code) do update set enabled = true, updated_at = now();

insert into public.access_role_permissions(role_id, permission_code, enabled)
select role.id, permission.code, true
from public.access_roles role
cross join public.permission_catalog permission
where role.code = 'system_supervisor'
  and permission.code in ('clients.view', 'clients.documents.view', 'clients.activity.view')
on conflict (role_id, permission_code) do update set enabled = true, updated_at = now();

insert into public.access_role_permissions(role_id, permission_code, enabled)
select role.id, permission.code, true
from public.access_roles role
cross join public.permission_catalog permission
where role.code in ('system_dispatcher', 'system_scheduler')
  and permission.code in ('clients.view', 'clients.activity.view')
on conflict (role_id, permission_code) do update set enabled = true, updated_at = now();

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  client_number text not null unique,
  legal_name text not null,
  display_name text not null,
  dba_name text,
  status text not null default 'prospect',
  service_tier text,
  industry text,
  account_owner_employee_id uuid references public.employees(id) on delete restrict,
  billing_email text,
  billing_phone text,
  website text,
  address_line_1 text,
  address_line_2 text,
  city text,
  region text,
  postal_code text,
  time_zone text not null default 'America/Denver',
  service_started_on date,
  service_ended_on date,
  renewal_on date,
  internal_notes text,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_by uuid not null references public.employees(id) on delete restrict,
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references public.employees(id) on delete restrict,
  constraint clients_number_format check (client_number ~ '^CLI-[0-9]{4,}$'),
  constraint clients_legal_name_present check (btrim(legal_name) <> ''),
  constraint clients_display_name_present check (btrim(display_name) <> ''),
  constraint clients_status_check check (status in ('prospect', 'onboarding', 'active', 'paused', 'former', 'do_not_renew', 'archived')),
  constraint clients_date_order check (service_ended_on is null or service_started_on is null or service_ended_on >= service_started_on),
  constraint clients_time_zone_check check (time_zone in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'))
);

create unique index clients_legal_name_active_uidx on public.clients(lower(legal_name)) where archived_at is null;
create index clients_status_name_idx on public.clients(status, display_name) where archived_at is null;

create table public.client_contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  first_name text not null,
  last_name text not null,
  title text,
  email text,
  phone text,
  contact_type text not null default 'operations',
  primary_contact boolean not null default false,
  emergency_contact boolean not null default false,
  notes text,
  active boolean not null default true,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_by uuid not null references public.employees(id) on delete restrict,
  updated_at timestamptz not null default now(),
  constraint client_contacts_first_present check (btrim(first_name) <> ''),
  constraint client_contacts_last_present check (btrim(last_name) <> ''),
  constraint client_contacts_type_check check (contact_type in ('executive', 'operations', 'billing', 'emergency', 'legal', 'other')),
  constraint client_contacts_channel_check check (email is not null or phone is not null)
);

create unique index client_contacts_primary_uidx on public.client_contacts(client_id) where primary_contact and active;
create index client_contacts_client_idx on public.client_contacts(client_id, active, last_name, first_name);

alter table public.sites
  add column if not exists client_id uuid references public.clients(id) on delete restrict,
  add column if not exists latitude numeric(9,6),
  add column if not exists longitude numeric(9,6),
  add column if not exists geofence_radius_meters integer;

alter table public.sites
  add constraint sites_coordinates_pair check (num_nonnulls(latitude, longitude) in (0, 2)),
  add constraint sites_geofence_radius_check check (geofence_radius_meters is null or geofence_radius_meters between 10 and 5000);

create index if not exists sites_client_idx on public.sites(client_id, active, name);

alter table public.patrol_route_stops
  add column if not exists client_id uuid references public.clients(id) on delete restrict;
alter table public.patrol_hits
  add column if not exists client_id uuid references public.clients(id) on delete restrict;
alter table public.events
  add column if not exists client_id uuid references public.clients(id) on delete restrict;
create index if not exists patrol_route_stops_client_idx on public.patrol_route_stops(client_id, route_version_id);
create index if not exists patrol_hits_client_idx on public.patrol_hits(client_id, submitted_at desc) where client_id is not null;
create index if not exists events_client_idx on public.events(client_id, starts_at desc) where client_id is not null;

update public.patrol_route_stops stop
set client_id = site.client_id
from public.sites site
where site.id = stop.site_id and stop.client_id is null and site.client_id is not null;

update public.patrol_hits hit
set client_id = stop.client_id
from public.patrol_route_stops stop
where stop.id = hit.stop_id and hit.client_id is null and stop.client_id is not null;

update public.events event
set client_id = site.client_id
from public.sites site
where site.id = event.site_id and event.client_id is null and site.client_id is not null;

create or replace function private.apply_client_relationships()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'patrol_route_stops' then
    if new.site_id is not null then select site.client_id into new.client_id from public.sites site where site.id = new.site_id; end if;
  elsif tg_table_name = 'patrol_hits' then
    select coalesce(stop.client_id, site.client_id) into new.client_id from public.patrol_route_stops stop left join public.sites site on site.id=stop.site_id where stop.id=new.stop_id;
  elsif tg_table_name = 'events' and new.site_id is not null then
    select site.client_id into new.client_id from public.sites site where site.id=new.site_id;
  end if;
  return new;
end $$;

drop trigger if exists patrol_route_stops_client_relationship on public.patrol_route_stops;
create trigger patrol_route_stops_client_relationship before insert or update of site_id on public.patrol_route_stops for each row execute function private.apply_client_relationships();
drop trigger if exists patrol_hits_client_relationship on public.patrol_hits;
create trigger patrol_hits_client_relationship before insert or update of stop_id on public.patrol_hits for each row execute function private.apply_client_relationships();
drop trigger if exists events_client_relationship on public.events;
create trigger events_client_relationship before insert or update of site_id on public.events for each row execute function private.apply_client_relationships();

create table public.client_service_records (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  site_id uuid references public.sites(id) on delete restrict,
  post_id uuid references public.posts(id) on delete restrict,
  shift_id uuid references public.shifts(id) on delete restrict,
  patrol_hit_id uuid references public.patrol_hits(id) on delete restrict,
  occurred_at timestamptz not null,
  record_type text not null,
  title text not null,
  summary text not null,
  severity text not null default 'routine',
  guard_employee_id uuid references public.employees(id) on delete restrict,
  source_system text not null default 'sygshift',
  source_record_id uuid,
  status text not null default 'final',
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_by uuid not null references public.employees(id) on delete restrict,
  updated_at timestamptz not null default now(),
  invalidated_at timestamptz,
  invalidated_by uuid references public.employees(id) on delete restrict,
  invalidation_reason text,
  constraint client_service_records_type_check check (record_type in ('daily_activity', 'incident', 'dispatch_note', 'inspection', 'patrol_summary', 'client_contact', 'other')),
  constraint client_service_records_title_present check (btrim(title) <> ''),
  constraint client_service_records_summary_present check (length(btrim(summary)) >= 5),
  constraint client_service_records_severity_check check (severity in ('routine', 'attention', 'urgent', 'critical')),
  constraint client_service_records_status_check check (status in ('draft', 'final', 'corrected', 'invalidated'))
);

create index client_service_records_client_time_idx on public.client_service_records(client_id, occurred_at desc) where invalidated_at is null;

create table public.client_documents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  site_id uuid references public.sites(id) on delete restrict,
  service_record_id uuid references public.client_service_records(id) on delete restrict,
  category text not null,
  title text not null,
  description text,
  access_classification text not null default 'confidential',
  portal_state text not null default 'internal_only',
  bucket_name text not null default 'client-documents',
  object_key text not null unique,
  original_filename text not null,
  mime_type text not null,
  byte_size bigint not null,
  sha256_checksum text not null,
  upload_request_id uuid not null unique,
  upload_state text not null default 'pending',
  effective_on date,
  expires_on date,
  uploaded_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default now(),
  stored_at timestamptz,
  archived_at timestamptz,
  archived_by uuid references public.employees(id) on delete restrict,
  archive_reason text,
  constraint client_documents_category_check check (category in ('proposal', 'contract', 'amendment', 'pricing', 'post_order', 'insurance', 'correspondence', 'report', 'photo', 'video', 'other')),
  constraint client_documents_access_check check (access_classification in ('confidential', 'restricted', 'highly_restricted')),
  constraint client_documents_portal_state_check check (portal_state in ('internal_only', 'eligible_to_share', 'awaiting_approval', 'published_to_client', 'withdrawn')),
  constraint client_documents_upload_state_check check (upload_state in ('pending', 'stored', 'failed')),
  constraint client_documents_title_present check (btrim(title) <> ''),
  constraint client_documents_filename_present check (btrim(original_filename) <> ''),
  constraint client_documents_size_check check (byte_size between 1 and 26214400),
  constraint client_documents_checksum_check check (sha256_checksum ~ '^[a-f0-9]{64}$'),
  constraint client_documents_date_order check (expires_on is null or effective_on is null or expires_on >= effective_on)
);

create index client_documents_client_idx on public.client_documents(client_id, created_at desc) where archived_at is null and upload_state = 'stored';

create table public.client_portal_publications (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  resource_type text not null,
  resource_id uuid not null,
  state text not null default 'eligible_to_share',
  approved_by uuid references public.employees(id) on delete restrict,
  approved_at timestamptz,
  published_by uuid references public.employees(id) on delete restrict,
  published_at timestamptz,
  withdrawn_by uuid references public.employees(id) on delete restrict,
  withdrawn_at timestamptz,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_portal_publications_resource_type_check check (resource_type in ('document', 'service_record', 'patrol_hit', 'report')),
  constraint client_portal_publications_state_check check (state in ('eligible_to_share', 'awaiting_approval', 'published_to_client', 'withdrawn')),
  constraint client_portal_publications_unique unique (client_id, resource_type, resource_id)
);

create table private.client_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  source_sha256 text not null unique,
  status text not null default 'staged',
  row_count integer not null default 0,
  staged_by uuid references public.employees(id) on delete restrict,
  staged_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint client_import_batches_status_check check (status in ('staged', 'in_review', 'completed', 'canceled')),
  constraint client_import_batches_checksum_check check (source_sha256 ~ '^[a-f0-9]{64}$')
);

create table private.client_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references private.client_import_batches(id) on delete restrict,
  source_tab text not null,
  source_row integer not null,
  source_payload jsonb not null,
  suggested_status text,
  review_state text not null default 'needs_review',
  matched_client_id uuid references public.clients(id) on delete restrict,
  promoted_client_id uuid references public.clients(id) on delete restrict,
  reviewed_by uuid references public.employees(id) on delete restrict,
  reviewed_at timestamptz,
  review_note text,
  constraint client_import_rows_source_unique unique (batch_id, source_tab, source_row),
  constraint client_import_rows_review_state_check check (review_state in ('needs_review', 'matched', 'promoted', 'ignored'))
);

create index client_import_rows_queue_idx on private.client_import_rows(batch_id, review_state, source_tab, source_row);

alter table public.clients enable row level security;
alter table public.client_contacts enable row level security;
alter table public.client_service_records enable row level security;
alter table public.client_documents enable row level security;
alter table public.client_portal_publications enable row level security;

revoke all on table public.clients, public.client_contacts, public.client_service_records, public.client_documents, public.client_portal_publications from public, anon, authenticated;
revoke all on table private.client_import_batches, private.client_import_rows from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('client-documents', 'client-documents', false, 26214400, array['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists client_documents_direct_access on storage.objects;

create or replace function private.client_can(target_permission text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_admin() or public.has_effective_permission(target_permission)
$$;

create or replace function public.get_clients_workspace(
  target_search text default null,
  target_status text default 'all',
  target_page integer default 1,
  target_page_size integer default 10
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  clean_search text := lower(btrim(coalesce(target_search, '')));
  clean_page integer := greatest(coalesce(target_page, 1), 1);
  clean_page_size integer := case when target_page_size in (5, 10, 20) then target_page_size else 10 end;
  total_count integer;
begin
  if private.current_employee_id() is null or not private.client_can('clients.view') then
    raise insufficient_privilege using message = 'Client File access is required.';
  end if;

  select count(*)::integer into total_count
  from public.clients client
  where client.archived_at is null
    and (target_status = 'all' or client.status = target_status)
    and (clean_search = '' or lower(concat_ws(' ', client.client_number, client.legal_name, client.display_name, client.dba_name, client.city, client.region)) like '%' || clean_search || '%');

  return jsonb_build_object(
    'actor', jsonb_build_object(
      'canManage', private.client_can('clients.manage'),
      'canManageDocuments', private.client_can('clients.documents.manage'),
      'canViewContracts', private.client_can('clients.contracts.view'),
      'canViewActivity', private.client_can('clients.activity.view'),
      'canManageActivity', private.client_can('clients.activity.manage'),
      'canExport', private.client_can('clients.reports.export'),
      'canManageImports', private.client_can('clients.import.manage'),
      'canPublishPortal', private.client_can('clients.portal.publish')
    ),
    'metrics', jsonb_build_object(
      'active', (select count(*) from public.clients where status = 'active' and archived_at is null),
      'prospects', (select count(*) from public.clients where status = 'prospect' and archived_at is null),
      'renewalsDue', (select count(*) from public.clients where status in ('active', 'paused') and renewal_on between current_date and current_date + 90 and archived_at is null),
      'needsAttention', (select count(*) from public.clients where archived_at is null and (status in ('onboarding', 'do_not_renew') or (status = 'active' and not exists (select 1 from public.sites where sites.client_id = clients.id))))
    ),
    'clients', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', client.id, 'clientNumber', client.client_number, 'legalName', client.legal_name,
        'displayName', client.display_name, 'dbaName', client.dba_name, 'status', client.status,
        'city', client.city, 'region', client.region, 'timeZone', client.time_zone,
        'renewalOn', client.renewal_on, 'siteCount', (select count(*) from public.sites site where site.client_id = client.id),
        'contactCount', (select count(*) from public.client_contacts contact where contact.client_id = client.id and contact.active),
        'documentCount', (select count(*) from public.client_documents document where document.client_id = client.id and document.upload_state = 'stored' and document.archived_at is null)
      ) order by client.display_name)
      from (
        select * from public.clients client
        where client.archived_at is null
          and (target_status = 'all' or client.status = target_status)
          and (clean_search = '' or lower(concat_ws(' ', client.client_number, client.legal_name, client.display_name, client.dba_name, client.city, client.region)) like '%' || clean_search || '%')
        order by client.display_name
        limit clean_page_size offset (clean_page - 1) * clean_page_size
      ) client
    ), '[]'::jsonb),
    'pagination', jsonb_build_object('page', clean_page, 'pageSize', clean_page_size, 'totalCount', total_count, 'totalPages', case when total_count = 0 then 0 else ceil(total_count::numeric / clean_page_size)::integer end),
    'importQueueCount', case when private.client_can('clients.import.manage') then (select count(*) from private.client_import_rows where review_state = 'needs_review') else 0 end
  );
end $$;

create or replace function public.get_client_file(
  target_client_id uuid,
  target_activity_page integer default 1,
  target_activity_page_size integer default 10,
  target_document_page integer default 1,
  target_document_page_size integer default 10
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  client_record public.clients%rowtype;
  activity_page integer := greatest(coalesce(target_activity_page, 1), 1);
  activity_size integer := case when target_activity_page_size in (5, 10, 20) then target_activity_page_size else 10 end;
  document_page integer := greatest(coalesce(target_document_page, 1), 1);
  document_size integer := case when target_document_page_size in (5, 10, 20) then target_document_page_size else 10 end;
  can_activity boolean := private.client_can('clients.activity.view');
  can_documents boolean := private.client_can('clients.documents.view');
  can_contracts boolean := private.client_can('clients.contracts.view');
begin
  if private.current_employee_id() is null or not private.client_can('clients.view') then raise insufficient_privilege using message = 'Client File access is required.'; end if;
  select * into client_record from public.clients where id = target_client_id and archived_at is null;
  if not found then raise no_data_found using message = 'Client File was not found.'; end if;

  return jsonb_build_object(
    'actor', jsonb_build_object('canManage', private.client_can('clients.manage'), 'canViewDocuments', can_documents, 'canManageDocuments', private.client_can('clients.documents.manage'), 'canViewContracts', can_contracts, 'canViewActivity', can_activity, 'canManageActivity', private.client_can('clients.activity.manage'), 'canExport', private.client_can('clients.reports.export')),
    'client', jsonb_build_object(
      'id', client_record.id, 'clientNumber', client_record.client_number, 'legalName', client_record.legal_name,
      'displayName', client_record.display_name, 'dbaName', client_record.dba_name, 'status', client_record.status,
      'serviceTier', client_record.service_tier, 'industry', client_record.industry,
      'accountOwnerEmployeeId', client_record.account_owner_employee_id, 'billingEmail', client_record.billing_email,
      'billingPhone', client_record.billing_phone, 'website', client_record.website, 'addressLine1', client_record.address_line_1,
      'addressLine2', client_record.address_line_2, 'city', client_record.city, 'region', client_record.region,
      'postalCode', client_record.postal_code, 'timeZone', client_record.time_zone,
      'serviceStartedOn', client_record.service_started_on, 'serviceEndedOn', client_record.service_ended_on,
      'renewalOn', client_record.renewal_on, 'internalNotes', client_record.internal_notes
    ),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', contact.id, 'firstName', contact.first_name, 'lastName', contact.last_name, 'title', contact.title, 'email', contact.email, 'phone', contact.phone, 'contactType', contact.contact_type, 'primaryContact', contact.primary_contact, 'emergencyContact', contact.emergency_contact, 'notes', contact.notes, 'active', contact.active) order by contact.primary_contact desc, contact.last_name, contact.first_name) from public.client_contacts contact where contact.client_id = target_client_id and contact.active), '[]'::jsonb),
    'sites', coalesce((select jsonb_agg(jsonb_build_object('id', site.id, 'code', site.code, 'name', site.name, 'addressLine1', site.address_line_1, 'addressLine2', site.address_line_2, 'city', site.city, 'region', site.region, 'postalCode', site.postal_code, 'timeZone', site.time_zone, 'active', site.active, 'latitude', site.latitude, 'longitude', site.longitude, 'geofenceRadiusMeters', site.geofence_radius_meters, 'posts', coalesce((select jsonb_agg(jsonb_build_object('id', post.id, 'name', post.name, 'requiresArmed', post.requires_armed, 'active', post.active) order by post.name) from public.posts post where post.site_id = site.id), '[]'::jsonb)) order by site.active desc, site.name) from public.sites site where site.client_id = target_client_id), '[]'::jsonb),
    'unassignedSites', case when private.client_can('clients.manage') then coalesce((select jsonb_agg(jsonb_build_object('id', site.id, 'name', site.name, 'code', site.code, 'city', site.city, 'region', site.region) order by site.name) from (select * from public.sites where client_id is null order by name limit 20) site), '[]'::jsonb) else '[]'::jsonb end,
    'documents', case when can_documents then coalesce((select jsonb_agg(jsonb_build_object('id', document.id, 'category', document.category, 'title', document.title, 'description', document.description, 'accessClassification', document.access_classification, 'portalState', document.portal_state, 'filename', document.original_filename, 'mimeType', document.mime_type, 'byteSize', document.byte_size, 'effectiveOn', document.effective_on, 'expiresOn', document.expires_on, 'createdAt', document.created_at) order by document.created_at desc) from (select * from public.client_documents document where document.client_id = target_client_id and document.upload_state = 'stored' and document.archived_at is null and (document.category not in ('proposal', 'contract', 'amendment', 'pricing') or can_contracts) order by document.created_at desc limit document_size offset (document_page - 1) * document_size) document), '[]'::jsonb) else '[]'::jsonb end,
    'documentPagination', jsonb_build_object('page', document_page, 'pageSize', document_size, 'totalCount', case when can_documents then (select count(*) from public.client_documents document where document.client_id = target_client_id and document.upload_state = 'stored' and document.archived_at is null and (document.category not in ('proposal', 'contract', 'amendment', 'pricing') or can_contracts)) else 0 end),
    'activity', case when can_activity then coalesce((
      with activity as (
        select shift.id as id, 'shift'::text as kind, shift.starts_at as occurred_at, site.name || ' · ' || post.name as title, concat(shift.headcount_required, ' required · ', count(assignment.id), ' assigned') as detail, site.id as site_id, post.id as post_id
        from public.shifts shift join public.posts post on post.id = shift.post_id join public.sites site on site.id = post.site_id left join public.shift_assignments assignment on assignment.shift_id = shift.id and assignment.status <> 'canceled'
        where site.client_id = target_client_id group by shift.id, site.id, site.name, post.id, post.name
        union all
        select shift.id, 'shift', shift.starts_at, event.name, concat(shift.headcount_required, ' required · ', count(assignment.id), ' assigned'), event.site_id, null::uuid
        from public.shifts shift join public.events event on event.id = shift.event_id left join public.shift_assignments assignment on assignment.shift_id=shift.id and assignment.status <> 'canceled'
        where event.client_id=target_client_id group by shift.id,event.id,event.name,event.site_id
        union all
        select hit.id, 'patrol_hit', coalesce(hit.submitted_at, hit.created_at), stop.location_label, concat(initcap(hit.classification), ' · ', coalesce(hit.outcome, hit.status), ' · ', employee.first_name, ' ', employee.last_name), stop.site_id, stop.post_id
        from public.patrol_hits hit join public.patrol_route_stops stop on stop.id = hit.stop_id join public.employees employee on employee.id = hit.submitted_by
        where coalesce(hit.client_id, stop.client_id) = target_client_id and hit.invalidated_at is null
        union all
        select record.id, record.record_type, record.occurred_at, record.title, record.summary, record.site_id, record.post_id
        from public.client_service_records record where record.client_id = target_client_id and record.invalidated_at is null
      )
      select jsonb_agg(jsonb_build_object('id', item.id, 'kind', item.kind, 'occurredAt', item.occurred_at, 'title', item.title, 'detail', item.detail, 'siteId', item.site_id, 'postId', item.post_id) order by item.occurred_at desc, item.id desc)
      from (select * from activity order by occurred_at desc, id desc limit activity_size offset (activity_page - 1) * activity_size) item
    ), '[]'::jsonb) else '[]'::jsonb end,
    'activityPagination', jsonb_build_object('page', activity_page, 'pageSize', activity_size)
  );
end $$;

create or replace function public.upsert_client(target_client jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor_id uuid := private.current_employee_id(); target_id uuid; next_number text;
begin
  if actor_id is null or not private.client_can('clients.manage') then raise insufficient_privilege using message = 'Client management permission is required.'; end if;
  target_id := nullif(target_client->>'id', '')::uuid;
  if btrim(coalesce(target_client->>'legalName', '')) = '' or btrim(coalesce(target_client->>'displayName', '')) = '' then raise check_violation using message = 'Legal name and display name are required.'; end if;
  if target_id is null then
    select 'CLI-' || lpad((coalesce(max(substring(client_number from '[0-9]+')::integer), 999) + 1)::text, 4, '0') into next_number from public.clients;
    insert into public.clients(client_number, legal_name, display_name, dba_name, status, service_tier, industry, account_owner_employee_id, billing_email, billing_phone, website, address_line_1, address_line_2, city, region, postal_code, time_zone, service_started_on, service_ended_on, renewal_on, internal_notes, created_by, updated_by)
    values(next_number, btrim(target_client->>'legalName'), btrim(target_client->>'displayName'), nullif(btrim(target_client->>'dbaName'), ''), coalesce(nullif(target_client->>'status', ''), 'prospect'), nullif(btrim(target_client->>'serviceTier'), ''), nullif(btrim(target_client->>'industry'), ''), nullif(target_client->>'accountOwnerEmployeeId', '')::uuid, nullif(btrim(target_client->>'billingEmail'), ''), nullif(btrim(target_client->>'billingPhone'), ''), nullif(btrim(target_client->>'website'), ''), nullif(btrim(target_client->>'addressLine1'), ''), nullif(btrim(target_client->>'addressLine2'), ''), nullif(btrim(target_client->>'city'), ''), nullif(btrim(target_client->>'region'), ''), nullif(btrim(target_client->>'postalCode'), ''), coalesce(nullif(target_client->>'timeZone', ''), 'America/Denver'), nullif(target_client->>'serviceStartedOn', '')::date, nullif(target_client->>'serviceEndedOn', '')::date, nullif(target_client->>'renewalOn', '')::date, nullif(btrim(target_client->>'internalNotes'), ''), actor_id, actor_id) returning id into target_id;
  else
    update public.clients set legal_name=btrim(target_client->>'legalName'), display_name=btrim(target_client->>'displayName'), dba_name=nullif(btrim(target_client->>'dbaName'), ''), status=coalesce(nullif(target_client->>'status',''), status), service_tier=nullif(btrim(target_client->>'serviceTier'), ''), industry=nullif(btrim(target_client->>'industry'), ''), account_owner_employee_id=nullif(target_client->>'accountOwnerEmployeeId','')::uuid, billing_email=nullif(btrim(target_client->>'billingEmail'), ''), billing_phone=nullif(btrim(target_client->>'billingPhone'), ''), website=nullif(btrim(target_client->>'website'), ''), address_line_1=nullif(btrim(target_client->>'addressLine1'), ''), address_line_2=nullif(btrim(target_client->>'addressLine2'), ''), city=nullif(btrim(target_client->>'city'), ''), region=nullif(btrim(target_client->>'region'), ''), postal_code=nullif(btrim(target_client->>'postalCode'), ''), time_zone=coalesce(nullif(target_client->>'timeZone',''), time_zone), service_started_on=nullif(target_client->>'serviceStartedOn','')::date, service_ended_on=nullif(target_client->>'serviceEndedOn','')::date, renewal_on=nullif(target_client->>'renewalOn','')::date, internal_notes=nullif(btrim(target_client->>'internalNotes'), ''), updated_by=actor_id, updated_at=clock_timestamp() where id=target_id and archived_at is null;
    if not found then raise no_data_found using message = 'Client File was not found.'; end if;
  end if;
  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record) values((select auth.uid()), actor_id, 'public', 'clients', 'CLIENT_FILE_SAVED', target_id::text, jsonb_build_object('clientId', target_id, 'reason', coalesce(target_client->>'changeReason','Client File updated')));
  return target_id;
end $$;

create or replace function public.upsert_client_contact(target_contact jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor_id uuid := private.current_employee_id(); target_id uuid := nullif(target_contact->>'id','')::uuid; parent_id uuid := nullif(target_contact->>'clientId','')::uuid;
begin
  if actor_id is null or not private.client_can('clients.manage') then raise insufficient_privilege using message = 'Client management permission is required.'; end if;
  if parent_id is null or not exists(select 1 from public.clients where id=parent_id and archived_at is null) then raise no_data_found using message='Client File was not found.'; end if;
  if coalesce((target_contact->>'primaryContact')::boolean,false) then update public.client_contacts set primary_contact=false, updated_by=actor_id, updated_at=clock_timestamp() where client_id=parent_id and primary_contact and id is distinct from target_id; end if;
  if target_id is null then insert into public.client_contacts(client_id,first_name,last_name,title,email,phone,contact_type,primary_contact,emergency_contact,notes,active,created_by,updated_by) values(parent_id,btrim(target_contact->>'firstName'),btrim(target_contact->>'lastName'),nullif(btrim(target_contact->>'title'),''),nullif(btrim(target_contact->>'email'),''),nullif(btrim(target_contact->>'phone'),''),coalesce(nullif(target_contact->>'contactType',''),'operations'),coalesce((target_contact->>'primaryContact')::boolean,false),coalesce((target_contact->>'emergencyContact')::boolean,false),nullif(btrim(target_contact->>'notes'),''),coalesce((target_contact->>'active')::boolean,true),actor_id,actor_id) returning id into target_id;
  else update public.client_contacts set first_name=btrim(target_contact->>'firstName'),last_name=btrim(target_contact->>'lastName'),title=nullif(btrim(target_contact->>'title'),''),email=nullif(btrim(target_contact->>'email'),''),phone=nullif(btrim(target_contact->>'phone'),''),contact_type=coalesce(nullif(target_contact->>'contactType',''),contact_type),primary_contact=coalesce((target_contact->>'primaryContact')::boolean,false),emergency_contact=coalesce((target_contact->>'emergencyContact')::boolean,false),notes=nullif(btrim(target_contact->>'notes'),''),active=coalesce((target_contact->>'active')::boolean,true),updated_by=actor_id,updated_at=clock_timestamp() where id=target_id and client_id=parent_id; if not found then raise no_data_found using message='Client contact was not found.'; end if; end if;
  return target_id;
end $$;

create or replace function public.assign_site_to_client(target_site_id uuid, target_client_id uuid, target_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare actor_id uuid := private.current_employee_id();
begin
  if actor_id is null or not private.client_can('clients.manage') then raise insufficient_privilege using message='Client management permission is required.'; end if;
  if length(btrim(coalesce(target_reason,''))) < 5 then raise check_violation using message='Enter a reason for changing the client relationship.'; end if;
  if target_client_id is not null and not exists(select 1 from public.clients where id=target_client_id and archived_at is null) then raise no_data_found using message='Client File was not found.'; end if;
  update public.sites set client_id=target_client_id, updated_at=clock_timestamp() where id=target_site_id;
  if not found then raise no_data_found using message='Site was not found.'; end if;
  update public.patrol_route_stops set client_id=target_client_id where site_id=target_site_id;
  update public.patrol_hits hit set client_id=target_client_id from public.patrol_route_stops stop where stop.id=hit.stop_id and stop.site_id=target_site_id;
  update public.events set client_id=target_client_id where site_id=target_site_id;
  insert into private.audit_events(auth_user_id,employee_id,schema_name,table_name,operation,row_id,new_record) values((select auth.uid()),actor_id,'public','sites','SITE_CLIENT_LINK_CHANGED',target_site_id::text,jsonb_build_object('clientId',target_client_id,'reason',btrim(target_reason)));
end $$;

create or replace function public.update_client_site_location(target_site_id uuid,target_client_id uuid,target_address_line_1 text,target_address_line_2 text,target_city text,target_region text,target_postal_code text,target_time_zone text,target_latitude numeric,target_longitude numeric,target_geofence_radius_meters integer,target_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare actor_id uuid:=private.current_employee_id();
begin
  if actor_id is null or not private.client_can('clients.manage') or not (public.is_admin() or public.has_effective_permission('sites.manage')) then raise insufficient_privilege using message='Client and Site management permissions are required.'; end if;
  if length(btrim(coalesce(target_reason,'')))<5 then raise check_violation using message='Enter a reason for changing this location.'; end if;
  if num_nonnulls(target_latitude,target_longitude) not in (0,2) then raise check_violation using message='Latitude and longitude must be entered together.'; end if;
  update public.sites set client_id=target_client_id,address_line_1=nullif(btrim(coalesce(target_address_line_1,'')),''),address_line_2=nullif(btrim(coalesce(target_address_line_2,'')),''),city=nullif(btrim(coalesce(target_city,'')),''),region=nullif(upper(btrim(coalesce(target_region,''))),''),postal_code=nullif(btrim(coalesce(target_postal_code,'')),''),time_zone=coalesce(nullif(btrim(coalesce(target_time_zone,'')),''),time_zone),latitude=target_latitude,longitude=target_longitude,geofence_radius_meters=target_geofence_radius_meters,updated_at=clock_timestamp() where id=target_site_id and (client_id=target_client_id or client_id is null);
  if not found then raise no_data_found using message='The linked Site was not found.'; end if;
  update public.patrol_route_stops set client_id=target_client_id,address_line_1=coalesce(nullif(btrim(coalesce(target_address_line_1,'')),''),address_line_1),city=coalesce(nullif(btrim(coalesce(target_city,'')),''),city),region=coalesce(nullif(upper(btrim(coalesce(target_region,''))),''),region),postal_code=coalesce(nullif(btrim(coalesce(target_postal_code,'')),''),postal_code),latitude=target_latitude,longitude=target_longitude,geofence_radius_meters=target_geofence_radius_meters where site_id=target_site_id;
  insert into private.audit_events(auth_user_id,employee_id,schema_name,table_name,operation,row_id,new_record) values((select auth.uid()),actor_id,'public','sites','CLIENT_SITE_LOCATION_UPDATED',target_site_id::text,jsonb_build_object('clientId',target_client_id,'reason',btrim(target_reason),'geofenceConfigured',target_latitude is not null and target_geofence_radius_meters is not null));
end $$;

create or replace function public.upsert_client_service_record(target_record jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor_id uuid := private.current_employee_id(); target_id uuid := nullif(target_record->>'id','')::uuid; parent_id uuid := nullif(target_record->>'clientId','')::uuid;
begin
  if actor_id is null or not private.client_can('clients.activity.manage') then raise insufficient_privilege using message='Client activity management permission is required.'; end if;
  if target_id is null then insert into public.client_service_records(client_id,site_id,post_id,shift_id,patrol_hit_id,occurred_at,record_type,title,summary,severity,guard_employee_id,status,created_by,updated_by) values(parent_id,nullif(target_record->>'siteId','')::uuid,nullif(target_record->>'postId','')::uuid,nullif(target_record->>'shiftId','')::uuid,nullif(target_record->>'patrolHitId','')::uuid,coalesce(nullif(target_record->>'occurredAt','')::timestamptz,clock_timestamp()),coalesce(nullif(target_record->>'recordType',''),'other'),btrim(target_record->>'title'),btrim(target_record->>'summary'),coalesce(nullif(target_record->>'severity',''),'routine'),nullif(target_record->>'guardEmployeeId','')::uuid,coalesce(nullif(target_record->>'status',''),'final'),actor_id,actor_id) returning id into target_id;
  else update public.client_service_records set occurred_at=coalesce(nullif(target_record->>'occurredAt','')::timestamptz,occurred_at),record_type=coalesce(nullif(target_record->>'recordType',''),record_type),title=btrim(target_record->>'title'),summary=btrim(target_record->>'summary'),severity=coalesce(nullif(target_record->>'severity',''),severity),status=coalesce(nullif(target_record->>'status',''),status),updated_by=actor_id,updated_at=clock_timestamp() where id=target_id and client_id=parent_id and invalidated_at is null; if not found then raise no_data_found using message='Client service record was not found.'; end if; end if;
  return target_id;
end $$;

create or replace function public.get_client_import_queue(target_page integer default 1, target_page_size integer default 10)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare clean_page integer:=greatest(coalesce(target_page,1),1); clean_size integer:=case when target_page_size in (5,10,20) then target_page_size else 10 end; total_count integer;
begin
  if private.current_employee_id() is null or not private.client_can('clients.import.manage') then raise insufficient_privilege using message='Client import permission is required.'; end if;
  select count(*)::integer into total_count from private.client_import_rows where review_state='needs_review';
  return jsonb_build_object(
    'rows',coalesce((select jsonb_agg(jsonb_build_object('id',row.id,'batchId',row.batch_id,'sourceTab',row.source_tab,'sourceRow',row.source_row,'sourcePayload',row.source_payload,'suggestedStatus',row.suggested_status,'reviewState',row.review_state) order by row.source_tab,row.source_row) from (select * from private.client_import_rows where review_state='needs_review' order by source_tab,source_row limit clean_size offset (clean_page-1)*clean_size) row),'[]'::jsonb),
    'pagination',jsonb_build_object('page',clean_page,'pageSize',clean_size,'totalCount',total_count,'totalPages',case when total_count=0 then 0 else ceil(total_count::numeric/clean_size)::integer end)
  );
end $$;

create or replace function public.resolve_client_import_row(target_row_id uuid,target_action text,target_client_id uuid default null,target_client jsonb default null,target_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor_id uuid:=private.current_employee_id(); resolved_id uuid; import_row private.client_import_rows%rowtype;
begin
  if actor_id is null or not private.client_can('clients.import.manage') then raise insufficient_privilege using message='Client import permission is required.'; end if;
  if length(btrim(coalesce(target_note,'')))<5 then raise check_violation using message='Enter a review note.'; end if;
  select * into import_row from private.client_import_rows where id=target_row_id and review_state='needs_review' for update;
  if not found then raise no_data_found using message='The staged source row is no longer pending review.'; end if;
  if target_action='ignore' then
    update private.client_import_rows set review_state='ignored',reviewed_by=actor_id,reviewed_at=clock_timestamp(),review_note=btrim(target_note) where id=target_row_id;
  elsif target_action='match' then
    if target_client_id is null or not exists(select 1 from public.clients where id=target_client_id and archived_at is null) then raise no_data_found using message='Choose an existing Client File.'; end if;
    resolved_id:=target_client_id;
    update private.client_import_rows set review_state='matched',matched_client_id=resolved_id,reviewed_by=actor_id,reviewed_at=clock_timestamp(),review_note=btrim(target_note) where id=target_row_id;
  elsif target_action='promote' then
    if target_client is null then raise check_violation using message='Client details are required before promotion.'; end if;
    resolved_id:=public.upsert_client(target_client);
    update private.client_import_rows set review_state='promoted',promoted_client_id=resolved_id,reviewed_by=actor_id,reviewed_at=clock_timestamp(),review_note=btrim(target_note) where id=target_row_id;
  else raise check_violation using message='Choose match, promote, or ignore.'; end if;
  insert into private.audit_events(auth_user_id,employee_id,schema_name,table_name,operation,row_id,new_record) values((select auth.uid()),actor_id,'private','client_import_rows','CLIENT_IMPORT_ROW_RESOLVED',target_row_id::text,jsonb_build_object('action',target_action,'clientId',resolved_id,'sourceTab',import_row.source_tab,'sourceRow',import_row.source_row,'note',btrim(target_note)));
  return resolved_id;
end $$;

create or replace function public.export_client_activity(target_client_id uuid,target_from date default null,target_through date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor_id uuid:=private.current_employee_id(); client_name text; rows jsonb;
begin
  if actor_id is null or not private.client_can('clients.reports.export') then raise insufficient_privilege using message='Client report export permission is required.'; end if;
  select display_name into client_name from public.clients where id=target_client_id and archived_at is null;
  if not found then raise no_data_found using message='Client File was not found.'; end if;
  with activity as (
    select shift.id,'shift'::text kind,shift.starts_at occurred_at,site.name||' · '||post.name title,concat(shift.headcount_required,' required · ',count(assignment.id),' assigned') detail,site.name site_name,post.name post_name
    from public.shifts shift join public.posts post on post.id=shift.post_id join public.sites site on site.id=post.site_id left join public.shift_assignments assignment on assignment.shift_id=shift.id and assignment.status<>'canceled'
    where site.client_id=target_client_id group by shift.id,site.id,site.name,post.id,post.name
    union all
    select shift.id,'shift',shift.starts_at,event.name,concat(shift.headcount_required,' required · ',count(assignment.id),' assigned'),site.name,null::text
    from public.shifts shift join public.events event on event.id=shift.event_id left join public.sites site on site.id=event.site_id left join public.shift_assignments assignment on assignment.shift_id=shift.id and assignment.status<>'canceled'
    where event.client_id=target_client_id group by shift.id,event.id,event.name,site.name
    union all
    select hit.id,'patrol_hit',coalesce(hit.submitted_at,hit.created_at),stop.location_label,concat(initcap(hit.classification),' · ',coalesce(hit.outcome,hit.status),' · ',employee.first_name,' ',employee.last_name),site.name,post.name
    from public.patrol_hits hit join public.patrol_route_stops stop on stop.id=hit.stop_id left join public.sites site on site.id=stop.site_id left join public.posts post on post.id=stop.post_id join public.employees employee on employee.id=hit.submitted_by
    where coalesce(hit.client_id,stop.client_id)=target_client_id and hit.invalidated_at is null
    union all
    select record.id,record.record_type,record.occurred_at,record.title,record.summary,site.name,post.name
    from public.client_service_records record left join public.sites site on site.id=record.site_id left join public.posts post on post.id=record.post_id where record.client_id=target_client_id and record.invalidated_at is null
  ) select coalesce(jsonb_agg(jsonb_build_object('recordId',id,'type',kind,'occurredAt',occurred_at,'title',title,'detail',detail,'site',site_name,'post',post_name) order by occurred_at desc,id desc),'[]'::jsonb) into rows from activity where (target_from is null or occurred_at::date>=target_from) and (target_through is null or occurred_at::date<=target_through) limit 10000;
  insert into private.audit_events(auth_user_id,employee_id,schema_name,table_name,operation,row_id,new_record) values((select auth.uid()),actor_id,'public','clients','CLIENT_ACTIVITY_EXPORTED',target_client_id::text,jsonb_build_object('from',target_from,'through',target_through,'rowCount',jsonb_array_length(rows)));
  return jsonb_build_object('clientId',target_client_id,'clientName',client_name,'generatedAt',clock_timestamp(),'rows',rows);
end $$;

create or replace function private.require_recent_client_document_mfa(target_method text, target_verified_at timestamptz)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if target_method not in ('authenticator','totp','security_key','webauthn','recovery_code') or target_verified_at is null or target_verified_at < clock_timestamp()-interval '15 minutes' or target_verified_at > clock_timestamp()+interval '1 minute' then raise insufficient_privilege using message='Recent identity verification is required for client document access.'; end if;
end $$;

create or replace function private.require_service_client_permission(target_actor_id uuid, target_permission text)
returns void language plpgsql stable security definer set search_path = '' as $$
declare permissions text[];
begin
  if target_actor_id is null or not exists(select 1 from public.employees where id=target_actor_id and status in ('onboarding','active','leave')) then raise insufficient_privilege using message='An active employee account is required.'; end if;
  permissions := private.employee_effective_permissions(target_actor_id);
  if not ('clients.manage'=any(coalesce(permissions,array[]::text[])) or target_permission=any(coalesce(permissions,array[]::text[]))) then raise insufficient_privilege using message='Client document permission is required.'; end if;
end $$;

create or replace function public.service_prepare_client_document_upload(target_actor_id uuid,target_client_id uuid,target_upload_request_id uuid,target_category text,target_title text,target_description text,target_access_classification text,target_portal_state text,target_effective_on date,target_expires_on date,target_original_filename text,target_content_type text,target_byte_size bigint,target_sha256_checksum text,target_extension text,target_mfa_method text,target_mfa_verified_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare existing public.client_documents%rowtype; document_id uuid:=gen_random_uuid(); object_path text; permissions text[];
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.require_service_client_permission(target_actor_id,'clients.documents.manage'); perform private.require_recent_client_document_mfa(target_mfa_method,target_mfa_verified_at);
  if not exists(select 1 from public.clients where id=target_client_id and archived_at is null) then raise no_data_found using message='Client File was not found.'; end if;
  permissions:=private.employee_effective_permissions(target_actor_id);
  if target_category in ('proposal','contract','amendment','pricing') and not ('clients.contracts.view'=any(coalesce(permissions,array[]::text[]))) then raise insufficient_privilege using message='Contract and pricing access is required.'; end if;
  if target_upload_request_id is null or btrim(coalesce(target_title,''))='' or target_content_type not in ('application/pdf','image/png','image/jpeg','image/webp','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') or target_byte_size not between 1 and 26214400 or lower(target_sha256_checksum) !~ '^[a-f0-9]{64}$' or lower(target_extension) not in ('pdf','png','jpg','jpeg','webp','txt','docx','xlsx') then raise check_violation using message='Client document metadata is invalid.'; end if;
  select * into existing from public.client_documents where upload_request_id=target_upload_request_id;
  if found then return jsonb_build_object('documentId',existing.id,'bucket',existing.bucket_name,'objectKey',existing.object_key,'state',existing.upload_state); end if;
  object_path:=target_client_id::text||'/'||document_id::text||'.'||lower(target_extension);
  insert into public.client_documents(id,client_id,category,title,description,access_classification,portal_state,object_key,original_filename,mime_type,byte_size,sha256_checksum,upload_request_id,effective_on,expires_on,uploaded_by) values(document_id,target_client_id,target_category,btrim(target_title),nullif(btrim(target_description),''),target_access_classification,target_portal_state,object_path,btrim(target_original_filename),target_content_type,target_byte_size,lower(target_sha256_checksum),target_upload_request_id,target_effective_on,target_expires_on,target_actor_id);
  return jsonb_build_object('documentId',document_id,'bucket','client-documents','objectKey',object_path,'state','pending');
end $$;

create or replace function public.service_complete_client_document_upload(target_actor_id uuid,target_document_id uuid,target_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.require_service_client_permission(target_actor_id,'clients.documents.manage');
  update public.client_documents set upload_state='stored',stored_at=clock_timestamp() where id=target_document_id and uploaded_by=target_actor_id and upload_state='pending';
  if not found then raise no_data_found using message='Pending client document was not found.'; end if;
  insert into private.audit_events(auth_user_id,employee_id,schema_name,table_name,operation,row_id,new_record) values(null,target_actor_id,'public','client_documents','CLIENT_DOCUMENT_STORED',target_document_id::text,jsonb_build_object('requestId',target_request_id));
  return jsonb_build_object('documentId',target_document_id,'state','stored','storedAt',clock_timestamp());
end $$;

create or replace function public.service_fail_client_document_upload(target_actor_id uuid,target_document_id uuid,target_failure_detail text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  update public.client_documents set upload_state='failed',archived_at=clock_timestamp(),archived_by=target_actor_id,archive_reason=left(coalesce(target_failure_detail,'Protected upload failed.'),1000) where id=target_document_id and upload_state='pending';
end $$;

create or replace function public.service_authorize_client_document_access(target_actor_id uuid,target_document_id uuid,target_action text,target_reason text,target_request_id uuid,target_mfa_method text,target_mfa_verified_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare document public.client_documents%rowtype; permissions text[];
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.require_service_client_permission(target_actor_id,'clients.documents.view'); perform private.require_recent_client_document_mfa(target_mfa_method,target_mfa_verified_at);
  if target_action not in ('preview','download') or length(btrim(coalesce(target_reason,'')))<8 then raise check_violation using message='Choose a valid action and enter a business reason.'; end if;
  select * into document from public.client_documents where id=target_document_id and upload_state='stored' and archived_at is null;
  if not found then raise no_data_found using message='Client document was not found.'; end if;
  permissions:=private.employee_effective_permissions(target_actor_id);
  if document.category in ('proposal','contract','amendment','pricing') and not ('clients.contracts.view'=any(coalesce(permissions,array[]::text[]))) then raise insufficient_privilege using message='Contract and pricing access is required.'; end if;
  insert into private.audit_events(auth_user_id,employee_id,schema_name,table_name,operation,row_id,new_record) values(null,target_actor_id,'public','client_documents',case when target_action='download' then 'CLIENT_DOCUMENT_DOWNLOADED' else 'CLIENT_DOCUMENT_VIEWED' end,target_document_id::text,jsonb_build_object('requestId',target_request_id,'reason',btrim(target_reason),'clientId',document.client_id));
  return jsonb_build_object('action',target_action,'bucket',document.bucket_name,'objectKey',document.object_key,'filename',document.original_filename,'mimeType',document.mime_type);
end $$;

revoke all on function public.get_clients_workspace(text,text,integer,integer), public.get_client_file(uuid,integer,integer,integer,integer), public.upsert_client(jsonb), public.upsert_client_contact(jsonb), public.assign_site_to_client(uuid,uuid,text), public.update_client_site_location(uuid,uuid,text,text,text,text,text,text,numeric,numeric,integer,text), public.upsert_client_service_record(jsonb), public.get_client_import_queue(integer,integer), public.resolve_client_import_row(uuid,text,uuid,jsonb,text), public.export_client_activity(uuid,date,date) from public, anon;
grant execute on function public.get_clients_workspace(text,text,integer,integer), public.get_client_file(uuid,integer,integer,integer,integer), public.upsert_client(jsonb), public.upsert_client_contact(jsonb), public.assign_site_to_client(uuid,uuid,text), public.update_client_site_location(uuid,uuid,text,text,text,text,text,text,numeric,numeric,integer,text), public.upsert_client_service_record(jsonb), public.get_client_import_queue(integer,integer), public.resolve_client_import_row(uuid,text,uuid,jsonb,text), public.export_client_activity(uuid,date,date) to authenticated;
revoke all on function public.service_prepare_client_document_upload(uuid,uuid,uuid,text,text,text,text,text,date,date,text,text,bigint,text,text,text,timestamptz), public.service_complete_client_document_upload(uuid,uuid,uuid), public.service_fail_client_document_upload(uuid,uuid,text), public.service_authorize_client_document_access(uuid,uuid,text,text,uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.service_prepare_client_document_upload(uuid,uuid,uuid,text,text,text,text,text,date,date,text,text,bigint,text,text,text,timestamptz), public.service_complete_client_document_upload(uuid,uuid,uuid), public.service_fail_client_document_upload(uuid,uuid,text), public.service_authorize_client_document_access(uuid,uuid,text,text,uuid,text,timestamptz) to service_role;

do $$ declare baseline client_file_release_baseline%rowtype; begin
  select * into strict baseline from client_file_release_baseline;
  if baseline.employee_count<>(select count(*) from public.employees) or baseline.site_count<>(select count(*) from public.sites) or baseline.post_count<>(select count(*) from public.posts) or baseline.shift_count<>(select count(*) from public.shifts) or baseline.assignment_count<>(select count(*) from public.shift_assignments) or baseline.time_event_count<>(select count(*) from public.time_events) or baseline.access_role_count<>(select count(*) from public.employee_access_roles) or baseline.permission_override_count<>(select count(*) from public.employee_permission_overrides) or baseline.patrol_route_count<>(select count(*) from public.patrol_routes) or baseline.patrol_hit_count<>(select count(*) from public.patrol_hits) then raise exception 'Client File release altered protected production record counts.'; end if;
  if exists(select 1 from storage.buckets where id='client-documents' and public) then raise exception 'Client document vault must remain private.'; end if;
end $$;

commit;
