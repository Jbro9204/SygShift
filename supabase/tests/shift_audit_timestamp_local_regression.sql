-- LOCAL RESTORED-DATABASE ONLY. Never update a production shift for this test.
begin;
do $local_guard$
begin
  if current_database() <> 'overnight_recovery_fixture_v2_20261019'
    or inet_server_addr() is distinct from inet '127.0.0.1'
    or inet_server_port() is distinct from 55439 then
    raise exception 'This regression requires the isolated restored local database.';
  end if;
end;
$local_guard$;
set local statement_timeout='20s';
set local lock_timeout='2s';
set local plpgsql.check_asserts=on;
create temporary table shift_audit_regression_result(
  timestamp_only_suppressed boolean, material_update_audited boolean,
  sql_noop_timestamp_only_suppressed boolean, other_table_updates_audited boolean,
  insert_and_delete_audited boolean, null_and_json_changes_audited boolean
) on commit drop;

do $test$
declare
  fixture_shift_id uuid;
  fixture_id uuid := gen_random_uuid();
  before_value jsonb;
  after_value jsonb;
  before_count bigint;
  after_count bigint;
begin
  select shift.id,to_jsonb(shift) into fixture_shift_id,before_value
  from public.shifts shift join public.schedules schedule on schedule.id=shift.schedule_id
  where schedule.status='draft' order by shift.id limit 1;
  assert fixture_shift_id is not null, 'A retained local draft shift is required.';
  select count(*) into before_count from private.audit_events where schema_name='public' and table_name='shifts' and row_id=fixture_shift_id::text;
  update public.shifts set updated_at=updated_at+interval '1 second' where id=fixture_shift_id;
  select to_jsonb(shift) into after_value from public.shifts shift where id=fixture_shift_id;
  assert before_value-'updated_at'=after_value-'updated_at' and before_value->'updated_at' is distinct from after_value->'updated_at';
  select count(*) into after_count from private.audit_events where schema_name='public' and table_name='shifts' and row_id=fixture_shift_id::text;
  assert after_count=before_count, 'A timestamp-only shift update still wrote generic audit history.';

  update public.shifts set notes=coalesce(notes,'')||' Local audit regression',updated_at=updated_at+interval '1 second' where id=fixture_shift_id;
  assert (select count(*)=before_count+1 from private.audit_events where schema_name='public' and table_name='shifts' and row_id=fixture_shift_id::text), 'A material shift change lost its audit record.';
  assert exists(select 1 from private.audit_events where schema_name='public' and table_name='shifts' and row_id=fixture_shift_id::text
    and old_record=after_value and new_record->>'notes'=coalesce(after_value->>'notes','')||' Local audit regression'), 'Material shift audit did not retain complete old/new evidence.';
  update public.shifts set notes=notes where id=fixture_shift_id;
  -- The real BEFORE trigger assigns clock_timestamp even for this SQL no-op.
  -- Its final OLD/NEW records therefore differ only in updated_at.
  assert (select count(*)=before_count+1 from private.audit_events where schema_name='public' and table_name='shifts' and row_id=fixture_shift_id::text), 'A SQL no-op with timestamp-only final changes was not suppressed.';

  create temporary table audit_other_fixture(id uuid,updated_at timestamptz,payload jsonb,note text) on commit drop;
  create trigger audit_other_fixture after insert or update or delete on pg_temp.audit_other_fixture for each row execute function private.write_audit_event();
  insert into pg_temp.audit_other_fixture values(fixture_id,clock_timestamp(),'{"nullable":null}',null);
  update pg_temp.audit_other_fixture set updated_at=updated_at+interval '1 second' where id=fixture_id;
  update pg_temp.audit_other_fixture set payload='{"nullable":"changed"}',note='changed',updated_at=updated_at+interval '1 second' where id=fixture_id;
  update pg_temp.audit_other_fixture set note=note where id=fixture_id;
  delete from pg_temp.audit_other_fixture where id=fixture_id;
  assert (select count(*)=5 from private.audit_events where table_name='audit_other_fixture' and row_id=fixture_id::text), 'Another table lost insert/update/delete, identical-row, or JSON/NULL audit evidence.';
  assert (select count(*)=1 from private.audit_events where table_name='audit_other_fixture' and row_id=fixture_id::text and operation='INSERT');
  assert (select count(*)=1 from private.audit_events where table_name='audit_other_fixture' and row_id=fixture_id::text and operation='DELETE');
  assert exists(select 1 from private.audit_events where table_name='audit_other_fixture' and row_id=fixture_id::text
    and old_record->'payload'='{"nullable":null}'::jsonb and new_record->'payload'='{"nullable":"changed"}'::jsonb
    and old_record->'note'='null'::jsonb and new_record->>'note'='changed');
  insert into pg_temp.shift_audit_regression_result values(true,true,true,true,true,true);
end;
$test$;
select * from pg_temp.shift_audit_regression_result;
rollback;
