-- ISOLATED LOCAL GENERIC-WRITER FIXTURE ONLY. The 24 column names/types are
-- copied from the production baseline; business/FK/auth triggers are not present.
-- Actual preserved workflow triggers are tested separately on the full restore.
begin;
do $local_guard$
begin
  if current_database()<>'shift_audit_column_fixture_20261019'
    or inet_server_addr() is distinct from inet '127.0.0.1'
    or inet_server_port() is distinct from 55439 then
    raise exception 'The exact isolated local audit fixture database is required.';
  end if;
end;
$local_guard$;
set local statement_timeout='20s';
set local plpgsql.check_asserts=on;
create schema auth;
create schema private;
create function auth.uid() returns uuid language sql as 'select null::uuid';
create function private.current_employee_id() returns uuid language sql as 'select null::uuid';
create table private.audit_events(id bigint generated always as identity,
  occurred_at timestamptz default clock_timestamp(),auth_user_id uuid,employee_id uuid,
  request_id text,schema_name text,table_name text,operation text,row_id text,old_record jsonb,new_record jsonb);
create table public.shifts(
  "id" pg_catalog."uuid",
  "schedule_id" pg_catalog."uuid",
  "post_id" pg_catalog."uuid",
  "event_id" pg_catalog."uuid",
  "starts_at" pg_catalog."timestamptz",
  "ends_at" pg_catalog."timestamptz",
  "time_zone" pg_catalog."text",
  "headcount_required" pg_catalog."int4",
  "requires_armed" pg_catalog."bool",
  "is_open" pg_catalog."bool",
  "is_overtime" pg_catalog."bool",
  "notes" pg_catalog."text",
  "created_by" pg_catalog."uuid",
  "created_at" pg_catalog."timestamptz",
  "updated_at" pg_catalog."timestamptz",
  "canceled_at" pg_catalog."timestamptz",
  "canceled_by" pg_catalog."uuid",
  "cancellation_reason" pg_catalog."text",
  "work_type" pg_catalog."text",
  "time_zone_source" pg_catalog."text",
  "time_zone_employee_id" pg_catalog."uuid",
  "assignment_type" pg_catalog."text",
  "coverage_source_shift_id" pg_catalog."uuid",
  "payroll_category" pg_catalog."text"
);
CREATE OR REPLACE FUNCTION private.write_audit_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- Only a changed timestamp on public.shifts is non-material. The complete
  -- remaining row comparison includes current and future business columns.
  if tg_op = 'UPDATE' and tg_table_schema = 'public' and tg_table_name = 'shifts'
    and (before_record ? 'updated_at') and (after_record ? 'updated_at')
    and (before_record->'updated_at') is distinct from (after_record->'updated_at')
    and (before_record - 'updated_at') = (after_record - 'updated_at') then
    return new;
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
$function$
;
create trigger shifts_audit after insert or update or delete on public.shifts
  for each row execute function private.write_audit_event();
create temporary table matrix_result(business_columns_tested integer,timestamp_only_suppressed boolean,
  identical_final_row_audited boolean,timestamp_null_transitions_suppressed boolean,
  future_json_column_audited boolean,insert_delete_audited boolean,other_table_untouched boolean);
do $matrix$
declare
  fixture_id uuid:=gen_random_uuid();
  next_id uuid;
  column_record record;
  new_value jsonb;
  before_value jsonb;
  after_value jsonb;
  before_count bigint;
  tested integer:=0;
begin
  insert into public.shifts(id,updated_at) values(fixture_id,clock_timestamp());
  assert (select count(*)=1 from private.audit_events where table_name='shifts' and operation='INSERT');
  update public.shifts set updated_at=updated_at+interval '1 second' where id=fixture_id;
  assert (select count(*)=1 from private.audit_events), 'Timestamp-only write was audited';
  update public.shifts set updated_at=updated_at where id=fixture_id;
  assert (select count(*)=2 from private.audit_events), 'Identical final shift row lost its audit';
  for column_record in select * from jsonb_to_recordset($columns$[{"name":"id","type":"uuid"},{"name":"schedule_id","type":"uuid"},{"name":"post_id","type":"uuid"},{"name":"event_id","type":"uuid"},{"name":"starts_at","type":"timestamptz"},{"name":"ends_at","type":"timestamptz"},{"name":"time_zone","type":"text"},{"name":"headcount_required","type":"int4"},{"name":"requires_armed","type":"bool"},{"name":"is_open","type":"bool"},{"name":"is_overtime","type":"bool"},{"name":"notes","type":"text"},{"name":"created_by","type":"uuid"},{"name":"created_at","type":"timestamptz"},{"name":"canceled_at","type":"timestamptz"},{"name":"canceled_by","type":"uuid"},{"name":"cancellation_reason","type":"text"},{"name":"work_type","type":"text"},{"name":"time_zone_source","type":"text"},{"name":"time_zone_employee_id","type":"uuid"},{"name":"assignment_type","type":"text"},{"name":"coverage_source_shift_id","type":"uuid"},{"name":"payroll_category","type":"text"}]$columns$::jsonb) as column_value(name text,type text)
  loop
    select to_jsonb(s) into before_value from public.shifts s where id=fixture_id;
    select count(*) into before_count from private.audit_events;
    new_value:=case column_record.type
      when 'uuid' then to_jsonb(gen_random_uuid())
      when 'timestamptz' then to_jsonb('2026-10-19T23:00:00Z'::timestamptz)
      when 'int4' then '2'::jsonb
      when 'bool' then 'true'::jsonb
      when 'text' then to_jsonb('changed_'||column_record.name)
      else null end;
    assert new_value is not null, 'Unreviewed column type';
    execute format('update public.shifts set %I=(select %I from jsonb_populate_record(null::public.shifts,$1)),updated_at=clock_timestamp() where id=$2 returning to_jsonb(shifts)',column_record.name,column_record.name)
      using jsonb_build_object(column_record.name,new_value),fixture_id into after_value;
    next_id:=(after_value->>'id')::uuid;
    assert (select count(*)=before_count+1 from private.audit_events), 'A business column change lost its audit';
    assert exists(select 1 from private.audit_events where id=(select max(id) from private.audit_events)
      and old_record=before_value and new_record=after_value and operation='UPDATE' and row_id=next_id::text), 'Business-field old/new audit is incomplete';
    fixture_id:=next_id;
    tested:=tested+1;
  end loop;
  assert tested=23;
  select count(*) into before_count from private.audit_events;
  update public.shifts set updated_at=null where id=fixture_id;
  update public.shifts set updated_at=clock_timestamp() where id=fixture_id;
  assert (select count(*)=before_count from private.audit_events), 'NULL timestamp-only transition was audited';
  update public.shifts set notes=null,updated_at=clock_timestamp() where id=fixture_id;
  assert (select count(*)=before_count+1 from private.audit_events), 'Business-field NULL transition lost audit';
  alter table public.shifts add column future_business_json jsonb default '{"seed":0}'::jsonb;
  update public.shifts set future_business_json='null'::jsonb,updated_at=clock_timestamp() where id=fixture_id;
  update public.shifts set future_business_json='{"future":[1,null]}'::jsonb,updated_at=clock_timestamp() where id=fixture_id;
  assert (select count(*)=before_count+3 from private.audit_events), 'Future JSON business column change lost audit';
  create table public.other_audit_fixture(id uuid,updated_at timestamptz,payload jsonb);
  create trigger other_audit_fixture after insert or update or delete on public.other_audit_fixture for each row execute function private.write_audit_event();
  insert into public.other_audit_fixture values(fixture_id,clock_timestamp(),'null');
  update public.other_audit_fixture set updated_at=clock_timestamp() where id=fixture_id;
  update public.other_audit_fixture set payload='{"a":1}' where id=fixture_id;
  delete from public.other_audit_fixture where id=fixture_id;
  assert (select count(*)=4 from private.audit_events where table_name='other_audit_fixture');
  delete from public.shifts where id=fixture_id;
  assert (select count(*)=1 from private.audit_events where table_name='shifts' and operation='DELETE');
  insert into matrix_result values(tested,true,true,true,true,true,true);
end;
$matrix$;
select * from matrix_result;
rollback;
