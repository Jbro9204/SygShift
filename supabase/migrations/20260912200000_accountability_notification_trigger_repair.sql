begin;

-- Repair the employee-delivery trigger without changing any accountability,
-- notification, or audit history.  The original local variable was named
-- notification_id, which collided with the delivery table column inside the
-- ON CONFLICT clause and caused the entire manager action to roll back.
create or replace function private.deliver_accountability_writeup_to_employee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict error
declare
  event_record public.attendance_accountability_events%rowtype;
  created_notification_id uuid;
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
        'dismissed', 'voided', 'reopened', 'reclassified'
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
    E'\nDetails: Review the protected notification in SygShift. Sensitive record details are not included in email.',
    E'\n\nOpen your SygShift notifications: https://app.sygilant.us/notifications'
  );

  created_notification_id := private.create_employee_notification(
    event_record.employee_id,
    'accountability_writeup',
    event_record.id,
    'accountability-writeup-action:' || new.id::text || ':employee:' || event_record.employee_id::text,
    message_subject,
    message_body,
    case when new.action = 'confirmed' then 'important' else 'routine' end,
    false,
    '/notifications',
    'Open notification',
    new.actor_id
  );

  if created_notification_id is not null then
    insert into public.employee_notification_email_deliveries (
      notification_id,
      recipient_employee_id,
      subject,
      body
    ) values (
      created_notification_id,
      event_record.employee_id,
      message_subject,
      message_body
    ) on conflict (notification_id) do nothing;

    perform private.signal_employee_update(
      event_record.employee_id,
      jsonb_build_object(
        'kind', 'notification',
        'id', created_notification_id,
        'isNew', true
      )
    );
  end if;

  return new;
end
$$;

revoke all on function private.deliver_accountability_writeup_to_employee()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
