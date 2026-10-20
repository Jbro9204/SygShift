import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Intentionally limited to the isolated restored local fixture. No hosted CLI,
// provider, production credential, or transaction commit is supported here.
const root = process.cwd()
const output = resolve(root, 'tmp/notification-compat')
const database = process.env.NOTIFICATION_FIXTURE_DATABASE ?? 'overnight_recovery_fixture_v2_20261019'
if (!/^overnight_recovery_fixture_[a-z0-9_]+$/.test(database)) throw new Error('An isolated fixture database name is required.')
const psql = process.env.NOTIFICATION_FIXTURE_PSQL ?? 'C:/Program Files/PostgreSQL/18/bin/psql.exe'
const read = (file) => readFileSync(resolve(root, file), 'utf8')
const body = (sql) => sql.replace(/^\s*begin;/i, '').replace(/commit;\s*$/i, '')
const localOwnership = (sql) => sql.replaceAll('postgres=X/postgres', 'codex_task=X/codex_task')
  .replaceAll('=X/postgres', '=X/codex_task').replaceAll('owner to postgres', 'owner to codex_task')
  .replaceAll("pg_get_userbyid(procedure.proowner)='postgres'", "pg_get_userbyid(procedure.proowner)='codex_task'")
const candidate = localOwnership(body(read('supabase/migrations/20261020001825_notification_terminal_state_compatibility.sql')))
const recovery = localOwnership(body(read('supabase/recovery/20261020001855_notification_reader_compatibility_fallback.sql')))
const snapshot = `select jsonb_build_object('queue_snapshot',jsonb_build_object(
  'outbox',(select jsonb_build_object('count',count(*),'hash',md5(string_agg(to_jsonb(row)::text,'|' order by id))) from private.notification_outbox row),
  'support',(select jsonb_build_object('count',count(*),'hash',md5(string_agg(to_jsonb(row)::text,'|' order by id))) from public.support_ticket_notifications row),
  'employee',(select jsonb_build_object('count',count(*),'hash',md5(string_agg(to_jsonb(row)::text,'|' order by id))) from public.employee_notification_email_deliveries row),
  'audit',(select count(*) from private.audit_events), 'email_audit',(select count(*) from private.email_delivery_audit),
  'retry_events',(select count(*) from private.notification_retry_events), 'employee_notifications',(select count(*) from public.employee_notifications),
  'ledger',(select count(*) from supabase_migrations.schema_migrations)));`
const handoff = `create temporary table notification_handoff_fixture(id uuid,accepted_row jsonb);
do $handoff$
declare fixture_id uuid:=gen_random_uuid(); before_row jsonb;
begin
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  perform set_config('sygshift.push_kicked','yes',true);
  insert into private.notification_outbox(id,message_type,aggregate_type,aggregate_id,payload,idempotency_key,attempted_at,attempt_count)
  values(fixture_id,'schedule_published','handoff_fifth_attempt',gen_random_uuid(),'{}','handoff-fifth:'||fixture_id,clock_timestamp(),5);
  select to_jsonb(delivery) into before_row from private.notification_outbox delivery where id=fixture_id;
  begin
    execute $candidate$${candidate}$candidate$;
    raise exception using errcode='ZX001',message='Candidate accepted an unresolved fifth provider attempt.';
  exception when sqlstate '55000' then
    if sqlerrm not like 'Notification handoff blocked:%' then raise; end if;
  end;
  assert not exists(select 1 from pg_attribute where attrelid='private.notification_outbox'::regclass and attname='terminal_outcome' and not attisdropped);
  assert (select to_jsonb(delivery)=before_row from private.notification_outbox delivery where id=fixture_id);
  perform public.service_mark_notification_result(fixture_id,true,null);
  assert (select delivered_at is not null and failed_at is null from private.notification_outbox where id=fixture_id),
    'A rejected migration fenced out a legitimate late acceptance.';
  insert into notification_handoff_fixture select fixture_id,to_jsonb(delivery) from private.notification_outbox delivery where id=fixture_id;
end;
$handoff$;
select 'notification_inflight_fifth_attempt_rejection_and_acceptance_passed' as status;
-- Positive rehearsal ONLY: mark unresolved restored rows as synthetic completed
-- outcomes through the OLD service APIs, all under this rollback transaction.
-- This supplies no evidence about the real provider outcome in production.
do $fixture_completion$
declare queue record; delivery_id uuid;
begin
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  for queue in select * from (values
    ('private.notification_outbox','service_mark_notification_result'),
    ('public.support_ticket_notifications','service_mark_support_ticket_notification_result'),
    ('public.employee_notification_email_deliveries','service_mark_employee_notification_result')
  ) as queues(relation,marker) loop
    for delivery_id in execute format('select id from %s where delivered_at is null and failed_at is null
      and (attempt_count>0 or attempted_at is not null)',queue.relation) loop
      execute format('select public.%I($1,false,$2)',queue.marker)
        using delivery_id,'Rollback-only fixture completion; not production provider evidence.';
      -- A lower attempt can remain pending after the old failure marker. This
      -- is still an unknown handoff; complete it synthetically only in the clone.
      execute format('select public.%I($1,true,null) where exists(select 1 from %s where id=$1 and delivered_at is null and failed_at is null)',queue.marker,queue.relation)
        using delivery_id;
    end loop;
  end loop;
end;
$fixture_completion$;
create temporary table notification_handoff_other_fixtures(relation text,id uuid,accepted_row jsonb);
do $other_handoffs$
declare queue record; fixture_id uuid; notification_id uuid; employee_id uuid; ticket_id uuid; captured jsonb; observed jsonb;
begin
  select employee.id into employee_id from public.employees employee order by employee.id limit 1;
  select ticket.id into ticket_id from public.support_tickets ticket order by ticket.id limit 1;
  for queue in select * from (values
    ('public.support_ticket_notifications','service_mark_support_ticket_notification_result'),
    ('public.employee_notification_email_deliveries','service_mark_employee_notification_result'),
    ('private.notification_outbox','service_mark_notification_result')
  ) as queues(relation,marker) loop
    fixture_id:=gen_random_uuid();
    if queue.relation='private.notification_outbox' then
      insert into private.notification_outbox(id,message_type,aggregate_type,aggregate_id,payload,idempotency_key,attempted_at,attempt_count,last_error)
      values(fixture_id,'schedule_published','handoff_possible_overlap',gen_random_uuid(),'{}','handoff-overlap:'||fixture_id,
        clock_timestamp(),1,'One callback failed; another overlapping provider attempt may remain.');
    elsif queue.relation='public.support_ticket_notifications' then
      insert into public.support_ticket_notifications(id,ticket_id,recipient_employee_id,message_type,subject,body,idempotency_key,attempted_at,attempt_count)
      values(fixture_id,ticket_id,employee_id,'handoff_fifth_attempt','Rollback handoff','Rollback-only handoff. No provider call.',
        'handoff-fifth:'||fixture_id,clock_timestamp(),5);
    else
      notification_id:=gen_random_uuid();
      insert into public.employee_notifications(id,recipient_employee_id,source_type,source_key,title,body)
      values(notification_id,employee_id,'handoff_fifth_attempt','handoff-fifth:'||fixture_id,'Rollback handoff','Rollback-only handoff. No provider call.');
      insert into public.employee_notification_email_deliveries(id,notification_id,recipient_employee_id,subject,body,attempted_at,attempt_count)
      values(fixture_id,notification_id,employee_id,'Rollback handoff','Rollback-only handoff. No provider call.',clock_timestamp(),5);
    end if;
    execute format('select to_jsonb(delivery) from %s delivery where id=$1',queue.relation) into captured using fixture_id;
    begin
      execute $candidate$${candidate}$candidate$;
      raise exception using errcode='ZX001',message='Candidate accepted an unresolved fifth provider attempt.';
    exception when sqlstate '55000' then
      if sqlerrm not like 'Notification handoff blocked: '||queue.relation||'%' then raise; end if;
    end;
    execute format('select to_jsonb(delivery) from %s delivery where id=$1',queue.relation) into observed using fixture_id;
    assert observed=captured, 'Rejected installation changed an in-flight delivery.';
    execute format('select public.%I($1,true,null)',queue.marker) using fixture_id;
    execute format('select to_jsonb(delivery) from %s delivery where id=$1',queue.relation) into observed using fixture_id;
    assert observed->>'delivered_at' is not null and observed->>'failed_at' is null;
    insert into notification_handoff_other_fixtures values(queue.relation,fixture_id,observed);
  end loop;
end;
$other_handoffs$;
select 'notification_all_three_queue_handoff_guards_and_acceptances_passed' as status;
`
const recoveryNegative = `do $negative$
begin
  begin
    execute $recovery$${recovery}$recovery$;
    raise exception using errcode='ZX001',message='Recovery accepted an absent repair ledger.';
  exception when raise_exception then
    if sqlerrm not like 'The exact notification repair must be installed%' then raise; end if;
  end;
end;
$negative$;
insert into supabase_migrations.schema_migrations(version,name,statements)
values('20261020001825','notification_terminal_state_compatibility',array['Local rollback-only repair ledger fixture']);
do $negative$
declare drift_kind text;
begin
  foreach drift_kind in array array['legacy_definition','v2_acl','v2_config'] loop
    begin
      if drift_kind='legacy_definition' then
        alter function public.get_notification_center(text,text,date,date,integer,integer) set search_path='pg_catalog';
      elsif drift_kind='v2_acl' then
        grant execute on function public.get_notification_center_v2(text,text,date,date,integer,integer) to anon;
      else
        alter function public.get_notification_center_v2(text,text,date,date,integer,integer) set search_path='pg_catalog';
      end if;
      execute $recovery$${recovery}$recovery$;
      raise exception using errcode='ZX001',message='Recovery accepted reader drift.';
    exception when raise_exception then
      if sqlerrm not like 'Notification forward recovery rejected reader drift:%' then raise; end if;
    end;
  end loop;
end;
$negative$;
select 'notification_recovery_negative_guards_passed' as status;
create temporary table notification_before_reader_fallback as ${snapshot.slice(0, -1)} as snapshot;
`
const tests = ['notification_reader_baseline_parity_regression', 'notification_terminal_state_regression',
  'notification_retry_generation_regression', 'notification_reader_compatibility_regression'].map((name) => read(`supabase/tests/${name}.sql`)).join('\n')
const fallbackTests = read('supabase/tests/notification_reader_fallback_regression.sql')
const sql = `set timezone='UTC';\n${snapshot}\nbegin;
create temporary table notification_reader_pre_candidate as
select pg_get_functiondef('public.get_notification_center(text,text,date,date,integer,integer)'::regprocedure) as definition;
${handoff}\n${candidate}\n${tests}\n${recoveryNegative}\n${recovery}\n${fallbackTests}\nrollback;\n${snapshot}`
if ((sql.match(/^\s*begin;/gim) ?? []).length !== 1 || (sql.match(/^\s*commit;/gim) ?? []).length !== 0
  || (sql.match(/^\s*rollback;/gim) ?? []).length !== 1) throw new Error('Expected one outer BEGIN, no COMMIT, one final ROLLBACK.')
mkdirSync(output, { recursive: true })
const sqlPath = resolve(output, 'local-rehearsal.sql')
writeFileSync(sqlPath, sql)
const result = spawnSync(psql, ['-h', '127.0.0.1', '-p', '55439', '-U', 'codex_task', '-d', database,
  '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', sqlPath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
writeFileSync(resolve(output, 'local-rehearsal-result.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`)
if (result.status !== 0) throw new Error(`Local rollback rehearsal failed: ${result.stderr?.slice(-1800) ?? result.error}`)
const rows = result.stdout.split(/\r?\n/).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
const snapshots = rows.filter((row) => row.queue_snapshot)
if (snapshots.length !== 2 || JSON.stringify(snapshots[0]) !== JSON.stringify(snapshots[1])) throw new Error('Before/after queue hashes or related counts differ.')
const contracts = rows.find((row) => row.contracts)
if (!contracts || contracts.contracts.length < 5) throw new Error('Bounded reader contract evidence is missing.')
writeFileSync(resolve(output, 'reader-contracts.json'), JSON.stringify(contracts, null, 2))
const fallback = rows.find((row) => row.fallback_contract)
if (!fallback) throw new Error('Bounded forward-recovery contract evidence is missing.')
writeFileSync(resolve(output, 'fallback-contract.json'), JSON.stringify(fallback.fallback_contract, null, 2))
console.log(result.stdout.split(/\r?\n/).filter((line) => line.includes('_passed')).join('\n'))
console.log('One BEGIN / no COMMIT / final ROLLBACK; all queue row hashes and related counts restored exactly.')
