-- Run after 20260910163434_sygsphere_human_name_mentions.sql inside a transaction.
-- The generated message is rolled back with the surrounding transaction.
do $$
declare
  cid uuid;
  actor_id uuid;
  actor_auth uuid;
  recipient_id uuid;
  legal_label text;
  selected_label text;
  result jsonb;
  message_id uuid;
begin
  select mine.conversation_id,mine.employee_id,mine_account.auth_user_id,recipient.employee_id,
    trim(recipient_employee.first_name||' '||recipient_employee.last_name)
    into cid,actor_id,actor_auth,recipient_id,legal_label
  from private.sygsphere_members mine
  join private.sygsphere_conversations conversation on conversation.id=mine.conversation_id and not conversation.archived
  join private.employee_accounts mine_account on mine_account.employee_id=mine.employee_id and mine_account.disabled_at is null
  join public.employees mine_employee on mine_employee.id=mine.employee_id and mine_employee.status='active'
  join private.sygsphere_members recipient on recipient.conversation_id=mine.conversation_id
    and recipient.employee_id<>mine.employee_id and recipient.removed_at is null
  join private.employee_accounts recipient_account on recipient_account.employee_id=recipient.employee_id and recipient_account.disabled_at is null
  join public.employees recipient_employee on recipient_employee.id=recipient.employee_id and recipient_employee.status='active'
  where mine.removed_at is null and trim(recipient_employee.first_name||' '||recipient_employee.last_name)
    = any(private.sygsphere_mention_aliases(mine.conversation_id,recipient.employee_id))
  order by mine.conversation_id,mine.employee_id,recipient.employee_id
  limit 1;
  assert actor_auth is not null, 'An active two-person SygSphere conversation is required';
  selected_label := legal_label;
  assert selected_label is not null, 'A unique human-name mention alias is required';
  assert private.sygsphere_body_has_mention('Please review @'||selected_label||'.',selected_label), 'Human-name token recognition failed';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor_auth,'role','authenticated','aal','aal1')::text,true);
  result := public.sygsphere_request('send',jsonb_build_object(
    'conversationId',cid,'parentId',null,'clientId',gen_random_uuid(),
    'body','Please review @'||selected_label||'.','mentionIds',jsonb_build_array(recipient_id)
  ));
  message_id := (result->>'id')::uuid;
  assert result->'mentions'->0->>'id'=recipient_id::text, 'Mention did not preserve the selected employee identity';
  assert result->'mentions'->0->>'label'=selected_label, 'Message response did not preserve the human-name label';
  assert exists(select 1 from private.sygsphere_mentions where message_id=message_id and employee_id=recipient_id and label=selected_label),
    'Stored mention did not preserve employee ID and human-name label';
  assert not has_function_privilege('authenticated','private.sygsphere_mention_aliases(uuid,uuid)','EXECUTE'),
    'Authenticated users must not execute the private alias resolver';
  assert not has_function_privilege('anon','private.sygsphere_body_has_mention(text,text)','EXECUTE'),
    'Anonymous users must not execute the private token matcher';
end
$$;
