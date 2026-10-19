-- Rollback-only proof for the forward recovery checkpoint
-- 20261019130406_sygsphere_message_acknowledgment_recovery.sql.
--
-- Run this in the same outer rehearsal transaction after the acknowledgment
-- regression and the recovery SQL. The acknowledgment regression deliberately
-- leaves one channel acknowledgment and its audit event in that transaction so
-- this test can prove recovery retained evidence instead of merely proving that
-- the table still exists.
begin;

do $$
declare
  retained_acknowledgment_count bigint;
  retained_audit_count bigint;
begin
  assert md5(pg_get_functiondef(
    'private.sygsphere_message_json(private.sygsphere_messages,uuid)'::regprocedure
  )) = 'aea9db6d4c107fd46a8a6490a5a6830e',
    'Recovery did not restore the reviewed message JSON baseline';

  assert md5(pg_get_functiondef(
    'public.sygsphere_request(text,jsonb)'::regprocedure
  )) = '12bada3cec92d74c18a2cd4d60d95e02',
    'Recovery did not restore the reviewed public request baseline';

  assert to_regprocedure('private.sygsphere_acknowledge_message(uuid,jsonb)') is null,
    'Recovery left the acknowledgment mutation helper callable';

  assert to_regclass('private.sygsphere_acknowledgments') is not null,
    'Recovery deleted the acknowledgment evidence relation';

  assert (
    select relation.relrowsecurity and relation.relforcerowsecurity
    from pg_class relation
    where relation.oid = 'private.sygsphere_acknowledgments'::regclass
  ), 'Recovery weakened acknowledgment row-level security';

  assert not has_table_privilege(
    'authenticated',
    'private.sygsphere_acknowledgments',
    'SELECT'
  ), 'Recovery exposed retained acknowledgment identities to authenticated SQL';

  assert not has_table_privilege(
    'anon',
    'private.sygsphere_acknowledgments',
    'SELECT'
  ), 'Recovery exposed retained acknowledgment identities to anonymous SQL';

  assert not has_function_privilege(
    'anon',
    'public.sygsphere_request(text,jsonb)',
    'EXECUTE'
  ), 'Recovery exposed SygSphere actions to anonymous users';

  assert has_function_privilege(
    'authenticated',
    'public.sygsphere_request(text,jsonb)',
    'EXECUTE'
  ), 'Recovery removed the existing authenticated SygSphere API grant';

  select count(*)
  into retained_acknowledgment_count
  from private.sygsphere_acknowledgments;

  select count(*)
  into retained_audit_count
  from private.audit_events audit
  join private.sygsphere_acknowledgments acknowledgment
    on audit.row_id = acknowledgment.message_id::text
   and audit.employee_id = acknowledgment.employee_id
  where audit.schema_name = 'private'
    and audit.table_name = 'sygsphere_acknowledgments'
    and audit.operation = 'ACKNOWLEDGE';

  assert retained_acknowledgment_count > 0,
    'Recovery rehearsal has no pre-recovery acknowledgment evidence to verify';
  assert retained_audit_count = retained_acknowledgment_count,
    'Recovery did not retain acknowledgment rows and their audit evidence together';

  assert obj_description(
    'private.sygsphere_acknowledgments'::regclass,
    'pg_class'
  ) = 'Retained inactive acknowledgment evidence after recovery. Do not delete; later forward repair may reuse it.',
    'Recovery did not mark retained acknowledgment evidence inactive';
end
$$;

select 'sygsphere_message_acknowledgment_recovery_regression: PASS' as result;

rollback;
