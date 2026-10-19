import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Generates inactive, exact-baseline candidates and rollback-only rehearsals.
// It never connects to a database or activates an applied migration.
const root = resolve(import.meta.dirname, '..')
const staged = resolve(root, 'docs/work-orders/2026-10-19-overnight/staged')
const evidence = resolve(root, 'tmp/overnight-2026-10-19')
mkdirSync(staged, { recursive: true })
mkdirSync(evidence, { recursive: true })
const catalog = JSON.parse(readFileSync(resolve(root, 'backups/overnight-2026-10-19/catalog-before.json'), 'utf8'))
const original = catalog.rows.find(({ kind }) => kind === 'functions').snapshot.find(({ identity }) => identity === 'private.write_audit_event()')
const md5 = (value) => createHash('md5').update(value).digest('hex')
if (md5(original.definition) !== original.hash || original.hash !== 'b71cc8d34713424231da43820bc94c1e') throw new Error('Unexpected audit baseline')
const marker = '  insert into private.audit_events ('
const guarded = `  -- Only a changed timestamp on public.shifts is non-material. The complete
  -- remaining row comparison includes current and future business columns.
  if tg_op = 'UPDATE' and tg_table_schema = 'public' and tg_table_name = 'shifts'
    and (before_record ? 'updated_at') and (after_record ? 'updated_at')
    and (before_record->'updated_at') is distinct from (after_record->'updated_at')
    and (before_record - 'updated_at') = (after_record - 'updated_at') then
    return new;
  end if;

  insert into private.audit_events (`
if (original.definition.split(marker).length !== 2) throw new Error('Non-unique insertion marker')
const repaired = original.definition.replace(marker, guarded)
const attachments = catalog.rows.find(({ kind }) => kind === 'triggers').snapshot.filter(({ definition }) => definition.includes('EXECUTE FUNCTION private.write_audit_event()'))
const attachmentHash = md5(attachments.map(({ definition, enabled }) => `${definition}:${enabled}`).sort().join('\n'))
if (attachments.length !== 104) throw new Error('Unexpected audit trigger count')
const matrixHashSQL = `select md5(string_agg(pg_get_triggerdef(oid)||':'||tgenabled::text,E'\\n' order by pg_get_triggerdef(oid) collate "C")) from pg_trigger where tgfoid='private.write_audit_event()'::regprocedure and not tgisinternal`

function patchBody(from, to, before, after) {
  return `do $repair$
declare
  function_identity constant regprocedure := 'private.write_audit_event()'::regprocedure;
  prior_definition text;
  new_definition text;
  prior_owner oid;
  prior_acl aclitem[];
  prior_configuration text[];
  prior_definer boolean;
  old_marker constant text := $old$${from}$old$;
  new_marker constant text := $new$${to}$new$;
begin
  select pg_get_functiondef(p.oid),p.proowner,p.proacl,p.proconfig,p.prosecdef
  into strict prior_definition,prior_owner,prior_acl,prior_configuration,prior_definer
  from pg_proc p where p.oid=function_identity::oid;
  if md5(prior_definition) <> '${before}'
    or pg_get_userbyid(prior_owner) <> 'postgres'
    or prior_acl::text is distinct from '{postgres=X/postgres,service_role=X/postgres}'
    or prior_configuration is distinct from array['search_path=""']::text[]
    or not prior_definer then
    raise exception 'The exact reviewed audit-writer or security baseline differs; candidate refused.';
  end if;
  if (${matrixHashSQL}) is distinct from '${attachmentHash}'
    or (select count(*) from pg_trigger where tgfoid=function_identity::oid and not tgisinternal) <> 104
    or (select count(*) from pg_trigger t where t.tgfoid=function_identity::oid
      and t.tgrelid='public.shifts'::regclass and t.tgtype=29 and t.tgenabled='O') <> 1 then
    raise exception 'The exact reviewed 104-trigger attachment matrix differs; candidate refused.';
  end if;
  if (length(prior_definition)-length(replace(prior_definition,old_marker,''))) <> length(old_marker) then
    raise exception 'The reviewed replacement marker is missing or duplicated.';
  end if;
  new_definition := replace(prior_definition,old_marker,new_marker);
  if md5(new_definition) <> '${after}' then raise exception 'The replacement fingerprint differs.'; end if;
  execute new_definition;
  if pg_get_functiondef(function_identity::oid) is distinct from new_definition
    or exists(select 1 from pg_proc p where p.oid=function_identity::oid and (
      p.proowner is distinct from prior_owner or p.proacl is distinct from prior_acl
      or p.proconfig is distinct from prior_configuration or p.prosecdef is distinct from prior_definer
    )) then
    raise exception 'The replacement or security preservation check failed.';
  end if;
end;
$repair$;`
}
const apply = patchBody(marker, guarded, original.hash, md5(repaired))
const recovery = patchBody(guarded, marker, md5(repaired), original.hash)
const settings = `set local lock_timeout='2s';\nset local statement_timeout='30s';\n`
const header = '-- INACTIVE candidate. No production audit history is deleted or rewritten.\n-- Activate only after exact release-batch review; ordinary bulk migration push remains blocked.\n'
writeFileSync(resolve(staged, '20261019232727_suppress_shift_timestamp_only_audit.sql'), `${header}begin;\n${settings}${apply}\ncommit;\n`)
writeFileSync(resolve(staged, '20261019233511_recover_shift_timestamp_audit_writer.sql'), `${header}-- Forward recovery restores the exact original writer, preserving existing audit history.\nbegin;\n${settings}${recovery}\ncommit;\n`)
writeFileSync(resolve(evidence, 'shift-audit-original-definition.sql'), original.definition)
writeFileSync(resolve(evidence, 'shift-audit-repaired-definition.sql'), repaired)

const lint = `create extension if not exists plpgsql_check with schema extensions;
do $lint$
begin
  if exists(select 1 from extensions.plpgsql_check_function_tb('private.write_audit_event()'::regprocedure,'public.shifts'::regclass,fatal_errors:=false) where level='error') then
    raise exception 'Repaired audit writer failed contextual trigger lint.';
  end if;
end;
$lint$;`
writeFileSync(resolve(evidence, 'shift-audit-hosted-rehearsal.sql'), `begin;\n${settings}${apply}\n${lint}\n${recovery}\nselect md5(pg_get_functiondef('private.write_audit_event()'::regprocedure))='${original.hash}' as original_definition_restored,
  (${matrixHashSQL})='${attachmentHash}' as exact_104_attachments_preserved,
  pg_get_userbyid(p.proowner)='postgres' and p.proacl::text='{postgres=X/postgres,service_role=X/postgres}'
    and p.proconfig=array['search_path=""']::text[] and p.prosecdef as security_preserved,
  true as rollback_only_no_shift_write_or_history_dml
from pg_proc p where p.oid='private.write_audit_event()'::regprocedure;
rollback;\n`)
writeFileSync(resolve(evidence, 'shift-audit-hosted-refusal-rehearsal.sql'), `begin;
${settings}
set local plpgsql.check_asserts=on;
do $refusals$
declare source text; refused boolean;
begin
  select pg_get_functiondef('private.write_audit_event()'::regprocedure) into source;
  if md5(source)<>'${original.hash}' then raise exception 'Unexpected baseline before refusal tests'; end if;
  execute replace(source,E'AS $function$\\n',E'AS $function$\\n-- intentional rollback-only drift fixture\\n');
  refused:=false;
  begin
    execute $candidate$${apply}$candidate$;
  exception when others then
    if sqlerrm <> 'The exact reviewed audit-writer or security baseline differs; candidate refused.' then raise; end if;
    refused:=true;
  end;
  assert refused, 'Changed writer definition was accepted';
  execute source;
  revoke execute on function private.write_audit_event() from service_role;
  refused:=false;
  begin
    execute $candidate$${apply}$candidate$;
  exception when others then
    if sqlerrm <> 'The exact reviewed audit-writer or security baseline differs; candidate refused.' then raise; end if;
    refused:=true;
  end;
  assert refused, 'Changed writer ACL was accepted';
  grant execute on function private.write_audit_event() to service_role;
  create temporary table audit_attachment_refusal_fixture(id uuid);
  create trigger audit_attachment_refusal_fixture after insert on pg_temp.audit_attachment_refusal_fixture for each row execute function private.write_audit_event();
  refused:=false;
  begin
    execute $candidate$${apply}$candidate$;
  exception when others then
    if sqlerrm <> 'The exact reviewed 104-trigger attachment matrix differs; candidate refused.' then raise; end if;
    refused:=true;
  end;
  assert refused, 'Changed audit attachment matrix was accepted';
  drop trigger audit_attachment_refusal_fixture on pg_temp.audit_attachment_refusal_fixture;
  if md5(pg_get_functiondef('private.write_audit_event()'::regprocedure))<>'${original.hash}' then raise exception 'Writer not restored after refusal fixtures'; end if;
end;
$refusals$;
select true as changed_definition_refused,true as changed_acl_refused,true as changed_attachment_matrix_refused;
rollback;
`)
writeFileSync(resolve(evidence, 'shift-audit-current-baseline.sql'), `select md5(pg_get_functiondef(p.oid)) as writer_hash, pg_get_userbyid(p.proowner) as owner,
  p.proacl::text as acl,p.proconfig,p.prosecdef,
  (${matrixHashSQL}) as attachment_hash,
  (select count(*) from pg_trigger where tgfoid=p.oid and not tgisinternal) as attachment_count,
  (select count(*) from private.audit_events) as historical_audit_count,
  (select count(*) from public.shifts) as shift_count
from pg_proc p where p.oid='private.write_audit_event()'::regprocedure;\n`)

const restoredTest = readFileSync(resolve(root, 'supabase/tests/shift_audit_timestamp_local_regression.sql'), 'utf8')
// Install the exact same definition, retaining local owner/grantor metadata. Hosted
// owner/ACL proof comes from the separate exact production-gated rehearsal.
writeFileSync(resolve(evidence, 'shift-audit-restored-rehearsal.sql'), restoredTest.replace("set local statement_timeout='20s';", `${repaired};\nset local statement_timeout='20s';`))
const columns = catalog.rows.find(({ kind }) => kind === 'columns').snapshot
  .filter(({ table_schema, table_name }) => table_schema === 'public' && table_name === 'shifts')
  .sort((a, b) => a.ordinal_position - b.ordinal_position)
if (columns.length !== 24 || columns.some(({ udt_schema }) => udt_schema !== 'pg_catalog')) throw new Error('Review the changed shift column shape')
const quoted = (name) => `"${name.replaceAll('"', '""')}"`
const fixtureDDL = columns.map(({ column_name, udt_name }) => `${quoted(column_name)} pg_catalog.${quoted(udt_name)}`).join(',\n  ')
const businessColumns = columns.filter(({ column_name }) => column_name !== 'updated_at')
const matrixTest = `-- ISOLATED LOCAL GENERIC-WRITER FIXTURE ONLY. The 24 column names/types are
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
  ${fixtureDDL}
);
${repaired};
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
  for column_record in select * from jsonb_to_recordset($columns$${JSON.stringify(businessColumns.map(({ column_name, udt_name }) => ({ name: column_name, type: udt_name })))}$columns$::jsonb) as column_value(name text,type text)
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
`
writeFileSync(resolve(root, 'supabase/tests/shift_audit_timestamp_column_matrix_local_regression.sql'), matrixTest)
console.log(JSON.stringify({ before: original.hash, after: md5(repaired), attachmentHash, attachments: attachments.length, activeMigrationWritten: false }))
