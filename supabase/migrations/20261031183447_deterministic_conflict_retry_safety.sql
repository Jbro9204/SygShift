-- SygShift: reviewed deterministic application conflicts must not trigger PostgREST transaction retries.
-- Live catalog capture: 2026-10-31T18:33:18.271Z. 7 functions / 19 reviewed clauses.
-- Exact definition AND all non-body pg_proc metadata must match before any change.
-- No employee, payroll, punch, schedule, client, permission or audit record changes.
-- Forward-only; prior migrations remain immutable. See docs/reliability/postgres-retry-safety.json.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
do $repair$
declare
  target record;
  function_oid oid;
  current_definition text;
  metadata_digest text;
  change jsonb;
begin
  for target in select * from (values
    ('public.manage_sygtasks_recurring_series(uuid, text, jsonb, uuid, integer)', '1c92fa57b175b4fedb83eb437058aae6', '5c78be3714981065869e626445fca519', 'ee859418df687efd4baf32c140742f6e', '[{"position":3210,"length":21,"text":"sqlstate ''PT409''"}]'::jsonb),
    ('public.mutate_sygtasks(text, jsonb, uuid, integer)', '44e0a461d57c07091530c3919449e53d', '7360c0b8ec973c52ef71411f63205e59', 'dc2ec0459b61a33b0836e0e0337099e6', '[{"position":49708,"length":21,"text":"sqlstate ''PT409''"},{"position":44283,"length":21,"text":"sqlstate ''PT409''"},{"position":36323,"length":21,"text":"sqlstate ''PT409''"},{"position":23048,"length":21,"text":"sqlstate ''PT409''"},{"position":10298,"length":21,"text":"sqlstate ''PT409''"}]'::jsonb),
    ('public.revise_templated_announcement(uuid, jsonb, timestamp with time zone, boolean, timestamp with time zone)', 'da2f8a5b3bd0e3f63386ec3433828887', '7bf00c0c554cfcb7cbfd5b118325d98b', 'c3a5c4e9efb15a4220ce8b2645794067', '[{"position":1986,"length":21,"text":"sqlstate ''PT409''"}]'::jsonb),
    ('public.scheduler_create_coverage_plan_batch_v1(date, uuid, text, text, uuid, text, date[], time without time zone, time without time zone, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text, text, text, boolean, boolean, text)', '6042ce76dc2a11efdd7a539d7bf38035', 'ea09cd0746132e4e17a45dfed9df6e6f', '63bb99023f125cadfd0fe0f2e70e6d2f', '[{"position":4048,"length":21,"text":"sqlstate ''PT409''"}]'::jsonb),
    ('public.scheduler_materialize_and_update_shift_v1(uuid, text, date, time without time zone, time without time zone, integer, boolean, boolean, text, text, uuid, text, text, text, text, text)', '09fbdbe870c1f39418f4afddde6f391f', '6929e16105d0d222af3ca72294b7fd9a', '71bf307ebba59f2dc9ef5be1fc9e109a', '[{"position":5980,"length":21,"text":"sqlstate ''PT409''"},{"position":5232,"length":21,"text":"sqlstate ''PT409''"},{"position":4771,"length":21,"text":"sqlstate ''PT409''"},{"position":4108,"length":21,"text":"sqlstate ''PT409''"},{"position":3584,"length":21,"text":"sqlstate ''PT409''"},{"position":3299,"length":21,"text":"sqlstate ''PT409''"},{"position":3038,"length":21,"text":"sqlstate ''PT409''"}]'::jsonb),
    ('public.service_adopt_hr_library_source(uuid, uuid, timestamp with time zone, text, text, text)', '365a5ed1334f35cad03afbf0516027d2', '90cecd126f41b07a03555c09a2c7c46f', '979975fe747fb53703c1b6acf887283e', '[{"position":4194,"length":21,"text":"sqlstate ''PT409''"},{"position":3344,"length":21,"text":"sqlstate ''PT409''"}]'::jsonb),
    ('public.service_retire_hr_library_source(uuid, uuid, timestamp with time zone, text, text, text)', '95ff4a3051de65d770cc1edb6ca4720b', 'cc02a3cb2ba1ecf2c6e30f45d358b6ce', '501b731556e94553298a6f81f824d1ff', '[{"position":4056,"length":21,"text":"sqlstate ''PT409''"},{"position":3314,"length":21,"text":"sqlstate ''PT409''"}]'::jsonb)
  ) as reviewed(identity, before_md5, after_md5, metadata_md5, replacements)
  loop
    function_oid := to_regprocedure(target.identity);
    if function_oid is null then
      raise exception 'Retry-safety target is missing: %', target.identity;
    end if;
    select pg_get_functiondef(p.oid), md5((to_jsonb(p) - 'prosrc')::text)
      into current_definition, metadata_digest from pg_proc p where p.oid = function_oid;
    if metadata_digest is distinct from target.metadata_md5 then
      raise exception 'Retry-safety metadata drift: %', target.identity;
    end if;
    if md5(current_definition) = target.after_md5 then continue; end if;
    if md5(current_definition) is distinct from target.before_md5 then
      raise exception 'Retry-safety definition drift: %', target.identity;
    end if;
    -- Offsets are Unicode character offsets, applied descending to preserve positions.
    for change in select value from jsonb_array_elements(target.replacements) loop
      current_definition := overlay(current_definition placing change->>'text'
        from (change->>'position')::integer for (change->>'length')::integer);
    end loop;
    if md5(current_definition) is distinct from target.after_md5 then
      raise exception 'Retry-safety reviewed rewrite mismatch: %', target.identity;
    end if;
    execute current_definition;
    select pg_get_functiondef(p.oid), md5((to_jsonb(p) - 'prosrc')::text)
      into current_definition, metadata_digest from pg_proc p where p.oid = function_oid;
    if md5(current_definition) is distinct from target.after_md5
      or metadata_digest is distinct from target.metadata_md5 then
      raise exception 'Retry-safety postcondition failed: %', target.identity;
    end if;
  end loop;
end;
$repair$;
commit;
