-- Transaction body: execute only with the candidate in one outer BEGIN/ROLLBACK.
-- Mixed accepted/failed recipients must retain evidence and expose only leaves.
do $test$
declare
  actor_employee uuid;
  actor_auth uuid;
  accepted_id uuid := gen_random_uuid();
  failed_id uuid := gen_random_uuid();
  aggregate_key uuid := gen_random_uuid();
  child_id uuid;
  grandchild_id uuid;
  accepted_before jsonb;
  failed_before jsonb;
  child_before jsonb;
  result_value jsonb;
  center_value jsonb;
  batch_value jsonb;
begin
  perform set_config('sygshift.push_kicked','yes',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  perform set_config('request.jwt.claim.role','service_role',true);
  select employee.id,account.auth_user_id into actor_employee,actor_auth
  from public.employees employee
  join private.employee_accounts account on account.employee_id=employee.id
  where employee.status='active' and account.disabled_at is null
    and 'notifications.manage'=any(private.employee_effective_permissions(employee.id))
  order by employee.id limit 1;
  assert actor_auth is not null, 'A retained notification manager is required.';
  insert into private.notification_outbox(id,message_type,aggregate_type,aggregate_id,payload,idempotency_key,attempt_count)
  values
    (accepted_id,'schedule_published','retry_generation_review',aggregate_key,'{}','retry-generation-review:'||accepted_id,1),
    (failed_id,'schedule_published','retry_generation_review',aggregate_key,'{}','retry-generation-review:'||failed_id,5);
  perform public.service_mark_notification_result(accepted_id,true,null);
  perform public.service_mark_notification_result(failed_id,false,'Retry generation review');
  select to_jsonb(delivery) into accepted_before from private.notification_outbox delivery where id=accepted_id;
  select to_jsonb(delivery) into failed_before from private.notification_outbox delivery where id=failed_id;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor_auth,'role','authenticated','aal','aal2')::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  result_value := public.retry_notification_job(accepted_id);
  assert (result_value->>'retried')::integer=1, 'Mixed batch retry did not select exactly its failed recipient.';
  select id into child_id from private.notification_outbox where retry_of_notification_id=failed_id;
  assert child_id is not null;
  assert not exists(select 1 from private.notification_outbox where retry_of_notification_id=accepted_id), 'An accepted recipient was queued again.';

  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  perform set_config('request.jwt.claim.role','service_role',true);
  update private.notification_outbox set attempt_count=5 where id=child_id;
  perform public.service_mark_notification_result(child_id,false,'Second generation exhausted');
  select to_jsonb(delivery) into child_before from private.notification_outbox delivery where id=child_id;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor_auth,'role','authenticated','aal','aal2')::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  result_value := public.retry_notification_job(accepted_id);
  assert (result_value->>'retried')::integer=1, 'A failed retry leaf did not create exactly one next generation.';
  select id into grandchild_id from private.notification_outbox where retry_of_notification_id=child_id;
  assert grandchild_id is not null;
  result_value := public.retry_notification_job(accepted_id);
  assert (result_value->>'retried')::integer=0, 'Retrying a batch with an active leaf duplicated a generation.';
  center_value := public.get_notification_center_v2('all','retry_generation_review',null,null,1,20);
  select item into batch_value from jsonb_array_elements(center_value->'batches') item where item->>'aggregateId'=aggregate_key::text;
  assert batch_value->>'status'='queued' and (batch_value->>'recipientCount')::integer=2,
    'Parent failures leaked into the status or recipient count of active leaves.';
  center_value := public.get_notification_center('queued','retry_generation_review',null,null,1,20);
  assert exists(select 1 from jsonb_array_elements(center_value->'batches') item
    where item->>'aggregateId'=aggregate_key::text and item->>'status'='queued' and (item->>'recipientCount')::integer=2),
    'Legacy clients retained superseded failures or inflated retry recipient counts.';

  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.service_mark_notification_result(grandchild_id,true,null);
  assert (select to_jsonb(delivery)=accepted_before from private.notification_outbox delivery where id=accepted_id), 'Accepted evidence changed during retry generation.';
  assert (select to_jsonb(delivery)=failed_before from private.notification_outbox delivery where id=failed_id), 'Original failed evidence changed during retry generation.';
  assert (select to_jsonb(delivery)=child_before from private.notification_outbox delivery where id=child_id), 'Failed child evidence changed during retry generation.';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor_auth,'role','authenticated','aal','aal2')::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  center_value := public.get_notification_center_v2('delivered','retry_generation_review',null,null,1,20);
  assert exists(select 1 from jsonb_array_elements(center_value->'batches') item where item->>'aggregateId'=aggregate_key::text and item->>'status'='delivered'),
    'Completed leaf generations remained failed in delivery history.';
  center_value := public.get_notification_center('delivered','retry_generation_review',null,null,1,20);
  assert exists(select 1 from jsonb_array_elements(center_value->'batches') item
    where item->>'aggregateId'=aggregate_key::text and item->>'status'='delivered' and (item->>'recipientCount')::integer=2),
    'Legacy clients retained an obsolete failed status after acceptance.';
  result_value := public.retry_notification_job(accepted_id);
  assert (result_value->>'retried')::integer=0, 'A completed batch created another retry.';
end;
$test$;
select 'notification_retry_generation_regression_passed' as status;
