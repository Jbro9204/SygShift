import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const correctionPermissionMigration = '20261031224853_time_correction_effective_permission_repair.sql'
export const correctionPermissionSignature = 'public.supervisor_correct_time_event_details(uuid,timestamp with time zone,public.time_event_kind,boolean,text)'

export function sourceFunction(root, file, name) {
  const source = readFileSync(resolve(root, 'supabase/migrations', file), 'utf8')
  const escapedName = name.replaceAll('.', '\\.')
  const match = source.match(new RegExp(`create(?: or replace)? function ${escapedName}\\([^]*?\\$\\$;`, 'iu'))
  assert(match, `Reviewed function ${name} missing from ${file}`)
  return match[0]
}

export function timeCorrectionPermissionFixture(root) {
  const foundation = '202607030001_foundation.sql'
  const access = '20260727203000_access_control_center.sql'
  const auditedTypes = '20260819170000_audited_punch_type_corrections.sql'
  const currentDetails = sourceFunction(root, '20260910060000_unify_time_correction_workflow.sql', 'public.supervisor_correct_time_event_details')
  // All permission/identity/correction implementations below are extracted from
  // their latest reviewed source, not reimplemented as a JavaScript model.
  // Alternate MFA proofs and action checkpoints are explicitly absent in this
  // fixture; this suite exercises native AAL1/AAL2, not those separate systems.
  const schema = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create schema private;
revoke all on schema private from public;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt()->>'sub','')::uuid $$;
create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
create type public.app_role as enum ('guard','recruiting_licensing','dispatcher','scheduler','supervisor','admin');
create type public.employee_status as enum ('active','inactive');
create type public.employment_type as enum ('hourly','salary');
create type public.time_event_kind as enum ('clock_in','clock_out','break_start','break_end');
create type public.time_event_source as enum ('web','supervisor');
create table auth.users(id uuid primary key,email text);
create table auth.sessions(id uuid primary key,user_id uuid references auth.users,not_after timestamptz,created_at timestamptz default clock_timestamp());
create table public.employees(id uuid primary key,username text unique,first_name text,last_name text,role public.app_role,employment_type public.employment_type,status public.employee_status);
create table private.employee_accounts(employee_id uuid primary key references public.employees,auth_user_id uuid references auth.users,disabled_at timestamptz,activated_at timestamptz,auth_tokens_invalid_before_epoch bigint default 0);
create table private.emergency_revoked_auth_sessions(auth_session_id uuid,auth_user_id uuid);
create table public.permission_catalog(code text primary key,active boolean default true,requires_mfa boolean default true);
create table public.access_roles(id uuid primary key default gen_random_uuid(),code text unique,base_app_role public.app_role,system_role boolean default false,active boolean default true);
create table public.access_role_permissions(role_id uuid references public.access_roles,permission_code text references public.permission_catalog,enabled boolean default true);
create table public.employee_access_roles(employee_id uuid references public.employees,role_id uuid references public.access_roles);
create table public.employee_permission_overrides(employee_id uuid references public.employees,permission_code text references public.permission_catalog,effect text,reason text,active boolean default true);
create function private.employee_required_action_checkpoint_enrolled(uuid) returns boolean language sql stable as $$ select false $$;
create function private.employee_has_blocking_required_actions(uuid) returns boolean language sql stable as $$ select false $$;
create function private.employee_requires_mfa(uuid) returns boolean language sql stable as $$ select true $$;
create function public.has_trusted_device() returns boolean language sql stable as $$ select false $$;
create function public.has_security_key_session() returns boolean language sql stable as $$ select false $$;
create function private.has_high_assurance_shared_identity_session(text) returns boolean language sql stable as $$ select false $$;
create table public.time_events(id uuid primary key default gen_random_uuid(),employee_id uuid references public.employees,shift_id uuid,kind public.time_event_kind,recorded_at timestamptz,source public.time_event_source,idempotency_key text unique,created_by uuid references public.employees,created_at timestamptz default clock_timestamp());
create table public.time_event_corrections(id uuid primary key default gen_random_uuid(),time_event_id uuid references public.time_events,replacement_time timestamptz,replacement_kind public.time_event_kind,voided boolean default false,reason text,requested_by uuid references public.employees,approved_by uuid references public.employees,approved_at timestamptz,declined_by uuid references public.employees,declined_at timestamptz,decision_note text,created_at timestamptz default clock_timestamp(),check(voided or replacement_time is not null or replacement_kind is not null));
create table public.time_event_maintenance_notes(id uuid primary key default gen_random_uuid(),time_event_id uuid references public.time_events,action text,note text,created_by uuid references public.employees,created_at timestamptz default clock_timestamp());
create table private.audit_events(id bigint generated always as identity,occurred_at timestamptz default clock_timestamp(),auth_user_id uuid,employee_id uuid,request_id text,schema_name text,table_name text,operation text,row_id text,old_record jsonb,new_record jsonb);
insert into public.permission_catalog(code) values('time.manage'),('time.manual_entry.edit');
insert into public.access_roles(code,base_app_role,system_role) values('system_admin','admin',true);
insert into public.access_role_permissions(role_id,permission_code) select role.id,permission.code from public.access_roles role cross join public.permission_catalog permission;
`
  const functions = [
    sourceFunction(root, '20261029225323_emergency_access_revocation_control_plane.sql', 'private.current_employee_id'),
    sourceFunction(root, foundation, 'public.current_employee_id'),
    sourceFunction(root, foundation, 'public.current_app_role'),
    sourceFunction(root, '20260717110000_critical_production_hardening.sql', 'public.is_supervisor_or_admin'),
    sourceFunction(root, '20260706022000_trusted_device_mfa_remember.sql', 'private.has_aal2'),
    sourceFunction(root, '20260912010000_universal_sygilant_launch_access.sql', 'public.has_mfa'),
    sourceFunction(root, '20260921153502_sygsphere_communications_checkpoint_inbound_access.sql', 'private.employee_effective_permissions'),
    sourceFunction(root, '20260912040000_universal_sygshift_return_access.sql', 'public.get_effective_permissions'),
    sourceFunction(root, access, 'public.has_effective_permission'),
    sourceFunction(root, '20260821203000_permission_enforcement_integrity.sql', 'public.has_any_effective_permission'),
    sourceFunction(root, '20260818120000_timekeeping_operations_expansion.sql', 'private.current_effective_time_event'),
    sourceFunction(root, auditedTypes, 'private.current_effective_time_event_kind'),
    sourceFunction(root, auditedTypes, 'private.protect_time_event_correction_review'),
    sourceFunction(root, foundation, 'private.prevent_append_only_change'),
    sourceFunction(root, foundation, 'private.write_audit_event'),
    currentDetails,
  ].join('\n')
  const protection = `
revoke all on function ${correctionPermissionSignature} from public,anon;
grant execute on function ${correctionPermissionSignature} to authenticated,service_role;
grant usage on schema auth to authenticated;
grant execute on all functions in schema auth to authenticated;
create trigger time_events_append_only before update or delete on public.time_events for each row execute function private.prevent_append_only_change();
create trigger correction_review_immutable before update or delete on public.time_event_corrections for each row execute function private.protect_time_event_correction_review();
create trigger notes_append_only before update or delete on public.time_event_maintenance_notes for each row execute function private.prevent_append_only_change();
create trigger correction_audit after insert or update on public.time_event_corrections for each row execute function private.write_audit_event();
create trigger note_audit after insert on public.time_event_maintenance_notes for each row execute function private.write_audit_event();
set sygshift.test_fixture = 'time_correction_permission_isolated';
`
  return { schema, functions, protection, currentDetails }
}
