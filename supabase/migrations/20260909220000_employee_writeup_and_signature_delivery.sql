begin;

-- Signature requesters need the active execution policies even when they are
-- not policy administrators. The policy remains immutable and all mutations
-- continue through the existing MFA-protected Document Studio service calls.
create or replace function public.service_get_signature_policy_options(target_actor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  effective_permissions text[] := private.document_studio_require_actor(target_actor_id);
begin
  if not (
    'documents.signatures.request' = any(effective_permissions)
    or 'documents.policies.manage' = any(effective_permissions)
  ) then
    raise insufficient_privilege using message = 'Signature-request permission is required.';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', policy.id,
      'code', policy.policy_code,
      'versionNumber', policy.version_number,
      'name', policy.name,
      'category', policy.document_category,
      'jurisdiction', policy.jurisdiction,
      'executionMethod', policy.execution_method,
      'authenticationTier', policy.authentication_tier,
      'routingMode', policy.routing_mode,
      'regulated', policy.regulated,
      'active', policy.active,
      'publishedAt', policy.published_at
    ) order by policy.name, policy.version_number desc)
    from private.document_policies policy
    where policy.active
      and policy.execution_method = 'electronic'
      and policy.electronic_signature_permitted
      and not policy.regulated
  ), '[]'::jsonb);
end
$$;

comment on function public.service_get_signature_policy_options(uuid) is
  'Returns bounded active electronic-signature policy choices to an authorized signature requester without granting policy administration.';

revoke all on function public.service_get_signature_policy_options(uuid)
  from public, anon, authenticated;
grant execute on function public.service_get_signature_policy_options(uuid)
  to service_role;

-- A signature envelope already owns the transactional email in the protected
-- outbox. Mirror it once into the live notification center without creating a
-- second email delivery.
create or replace function private.mirror_signature_request_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  notification_id uuid;
begin
  if new.message_type <> 'document_signature_required'
     or new.recipient_employee_id is null then
    return new;
  end if;

  notification_id := private.create_employee_notification(
    new.recipient_employee_id,
    'document_signature',
    new.aggregate_id,
    'document-signature-outbox:' || new.id::text,
    coalesce(nullif(btrim(new.payload ->> 'subject'), ''), 'Document action required'),
    coalesce(nullif(btrim(new.payload ->> 'message'), ''), 'A protected document is ready for your review.'),
    'important',
    false,
    '/my-documents',
    'Review document'
  );

  if notification_id is not null then
    perform private.signal_employee_update(
      new.recipient_employee_id,
      jsonb_build_object('kind', 'notification', 'id', notification_id, 'isNew', true)
    );
  end if;
  return new;
end
$$;

drop trigger if exists mirror_signature_request_to_notification_center
  on private.notification_outbox;
create trigger mirror_signature_request_to_notification_center
after insert on private.notification_outbox
for each row
when (new.message_type = 'document_signature_required')
execute function private.mirror_signature_request_notification();

-- Attendance-accountability records are the current employee write-up record.
-- Notify and email the affected employee once for each append-only action.
create or replace function private.deliver_accountability_writeup_to_employee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_record public.attendance_accountability_events%rowtype;
  notification_id uuid;
  action_label text;
  message_body text;
  message_subject text;
begin
  select * into event_record
  from public.attendance_accountability_events event
  where event.id = new.event_id;

  if event_record.id is null
     or event_record.employee_id = new.actor_id
     or new.action not in (
       'created', 'confirmed', 'excused_protected', 'corrected',
       'dismissed', 'voided', 'reopened'
     ) then
    return new;
  end if;

  action_label := initcap(replace(new.action, '_', ' '));
  message_subject := case
    when new.action = 'created' then '[SygShift] Attendance record documented'
    else '[SygShift] Attendance record updated'
  end;
  message_body := concat(
    case
      when new.action = 'created' then 'An attendance or accountability record was documented for you.'
      else 'Your attendance or accountability record was updated.'
    end,
    E'\n\nDate: ', to_char(event_record.operational_date, 'MM/DD/YYYY'),
    E'\nType: ', initcap(replace(event_record.event_type, '_', ' ')),
    E'\nStatus: ', action_label,
    E'\nDetails: ', coalesce(nullif(btrim(new.reason), ''), nullif(btrim(event_record.note), ''), 'Review the record in SygShift.'),
    E'\n\nOpen SygShift to review the full record: https://app.sygilant.us/time/accountability'
  );

  notification_id := private.create_employee_notification(
    event_record.employee_id,
    'accountability_writeup',
    event_record.id,
    'accountability-writeup-action:' || new.id::text || ':employee:' || event_record.employee_id::text,
    message_subject,
    message_body,
    case when new.action = 'confirmed' then 'important' else 'routine' end,
    false,
    '/time/accountability',
    'Review record',
    new.actor_id
  );

  if notification_id is not null then
    insert into public.employee_notification_email_deliveries (
      notification_id,
      recipient_employee_id,
      subject,
      body
    ) values (
      notification_id,
      event_record.employee_id,
      message_subject,
      message_body
    ) on conflict (notification_id) do nothing;

    perform private.signal_employee_update(
      event_record.employee_id,
      jsonb_build_object('kind', 'notification', 'id', notification_id, 'isNew', true)
    );
  end if;
  return new;
end
$$;

drop trigger if exists deliver_accountability_writeup_to_employee
  on public.attendance_accountability_event_actions;
create trigger deliver_accountability_writeup_to_employee
after insert on public.attendance_accountability_event_actions
for each row execute function private.deliver_accountability_writeup_to_employee();

revoke all on function private.mirror_signature_request_notification()
  from public, anon, authenticated;
revoke all on function private.deliver_accountability_writeup_to_employee()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
