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

-- Mirror each signature envelope into the live notification center. The
-- original protected outbox row remains the single authoritative email job so
-- its queued, attempted, delivered, failed, and retry states stay synchronized.
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
    'Document action required',
    'A protected document is ready for your review. Open SygShift to review it securely.',
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

  notification_id := private.create_employee_notification(
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

-- Prevent overlapping cron/manual processors from claiming the same delivery
-- while the first provider request is still in flight. This applies to the
-- legacy outbox and the employee-addressed queue used above.
create or replace function private.enforce_notification_delivery_lease()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.delivered_at is null
     and new.delivered_at is null
     and old.failed_at is null
     and new.failed_at is null
     and new.attempt_count = old.attempt_count + 1
     and new.attempted_at is distinct from old.attempted_at
     and new.available_at <= clock_timestamp() + interval '1 minute' then
    new.available_at := clock_timestamp() + interval '20 minutes';
  end if;
  return new;
end
$$;

drop trigger if exists enforce_notification_delivery_lease
  on private.notification_outbox;
create trigger enforce_notification_delivery_lease
before update on private.notification_outbox
for each row execute function private.enforce_notification_delivery_lease();

drop trigger if exists enforce_employee_notification_delivery_lease
  on public.employee_notification_email_deliveries;
create trigger enforce_employee_notification_delivery_lease
before update on public.employee_notification_email_deliveries
for each row execute function private.enforce_notification_delivery_lease();

-- Keep the protected outbox row as the one email-delivery record. The explicit
-- replacement is idempotent and preserves every existing delivery type while
-- adding a privacy-safe signature branch and an active-recipient recheck.
create or replace function public.service_claim_notification_batch(target_limit integer default 10)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clean_limit integer := least(greatest(coalesce(target_limit, 10), 1), 25);
  claimed jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;

  with pending as (
    select outbox.*
    from private.notification_outbox outbox
    where outbox.delivered_at is null
      and outbox.failed_at is null
      and outbox.available_at <= clock_timestamp()
      and outbox.attempt_count < 5
      and outbox.message_type in (
        'announcement_published',
        'call_off_supervisor_alert',
        'document_signature_required',
        'schedule_published'
      )
    order by outbox.available_at, outbox.created_at
    limit clean_limit
    for update skip locked
  ), touched as (
    update private.notification_outbox outbox
    set
      attempted_at = clock_timestamp(),
      attempt_count = outbox.attempt_count + 1,
      last_error = null
    from pending
    where outbox.id = pending.id
    returning outbox.*
  ), expanded as (
    select
      outbox.id,
      outbox.message_type,
      outbox.aggregate_type,
      outbox.aggregate_id,
      outbox.attempt_count,
      case
        when outbox.message_type = 'document_signature_required' then jsonb_build_object(
          'subject', 'Document action required',
          'text', concat(
            'A protected document is ready for your review.',
            E'\n\nOpen SygShift to review and sign: https://app.sygilant.us/my-documents'
          ),
          'html', concat(
            '<p>A protected document is ready for your review.</p>',
            '<p>Open SygShift to review and sign it securely.</p>'
          )
        )
        when outbox.message_type = 'call_off_supervisor_alert' then (
          select jsonb_build_object(
            'subject', 'Call-off reported',
            'text', concat(
              coalesce(employee.preferred_name, employee.first_name), ' ', employee.last_name,
              ' reported a call-off. Open SygShift Requests to review and publish replacement coverage.'
            ),
            'html', concat(
              '<p><strong>', coalesce(employee.preferred_name, employee.first_name), ' ', employee.last_name,
              '</strong> reported a call-off.</p><p>Open SygShift Requests to review and publish replacement coverage.</p>'
            )
          )
          from public.call_off_reports report
          join public.employees employee on employee.id = report.employee_id
          where report.id = outbox.aggregate_id
        )
        when outbox.message_type = 'announcement_published' then (
          select jsonb_build_object(
            'subject', announcement.title,
            'text', announcement.body,
            'html', concat('<p>', replace(announcement.body, E'\n', '<br>'), '</p>')
          )
          from public.announcements announcement
          where announcement.id = outbox.aggregate_id
        )
        when outbox.message_type = 'schedule_published' then (
          select jsonb_build_object(
            'subject', concat('SygShift schedule updated: ', to_char(schedule.week_starts_on, 'MM/DD/YYYY'), ' week'),
            'text', concat(
              'The SygShift schedule for ',
              to_char(schedule.week_starts_on, 'MM/DD/YYYY'),
              ' through ',
              to_char(schedule.week_starts_on + 6, 'MM/DD/YYYY'),
              ' has been published.',
              E'\n\n',
              'Open SygShift to review your assigned shifts, open coverage, and any changes that affect your week.',
              E'\n\n',
              'Revision: ', schedule.revision,
              E'\n',
              'Assigned shifts: ', (
                select count(*)
                from public.shift_assignments assignment
                join public.shifts shift on shift.id = assignment.shift_id
                where shift.schedule_id = schedule.id
                  and shift.canceled_at is null
                  and assignment.status <> 'canceled'
              ),
              E'\n',
              'Open slots: ', (
                select coalesce(sum(greatest(shift.headcount_required - assignment_counts.active_assignments, 0)), 0)
                from public.shifts shift
                left join lateral (
                  select count(*)::integer as active_assignments
                  from public.shift_assignments assignment
                  where assignment.shift_id = shift.id
                    and assignment.status <> 'canceled'
                ) assignment_counts on true
                where shift.schedule_id = schedule.id
                  and shift.canceled_at is null
              )
            ),
            'html', concat(
              '<p>The SygShift schedule for <strong>',
              to_char(schedule.week_starts_on, 'MM/DD/YYYY'),
              ' through ',
              to_char(schedule.week_starts_on + 6, 'MM/DD/YYYY'),
              '</strong> has been published.</p>',
              '<p>Open SygShift to review your assigned shifts, open coverage, and any changes that affect your week.</p>',
              '<ul>',
              '<li><strong>Revision:</strong> ', schedule.revision, '</li>',
              '<li><strong>Assigned shifts:</strong> ', (
                select count(*)
                from public.shift_assignments assignment
                join public.shifts shift on shift.id = assignment.shift_id
                where shift.schedule_id = schedule.id
                  and shift.canceled_at is null
                  and assignment.status <> 'canceled'
              ), '</li>',
              '<li><strong>Open slots:</strong> ', (
                select coalesce(sum(greatest(shift.headcount_required - assignment_counts.active_assignments, 0)), 0)
                from public.shifts shift
                left join lateral (
                  select count(*)::integer as active_assignments
                  from public.shift_assignments assignment
                  where assignment.shift_id = shift.id
                    and assignment.status <> 'canceled'
                ) assignment_counts on true
                where shift.schedule_id = schedule.id
                  and shift.canceled_at is null
              ), '</li>',
              '</ul>'
            )
          )
          from public.schedules schedule
          where schedule.id = outbox.aggregate_id
        )
        else jsonb_build_object(
          'subject', 'SygShift notification',
          'text', 'Open SygShift for details.',
          'html', '<p>Open SygShift for details.</p>'
        )
      end as message,
      case
        when outbox.message_type = 'document_signature_required' then (
          select coalesce(
            jsonb_agg(distinct private.preferred_delivery_email(contact.personal_email, contact.company_email)),
            '[]'::jsonb
          )
          from public.employees employee
          join private.employee_accounts account
            on account.employee_id = employee.id
           and account.disabled_at is null
          join private.employee_contacts contact on contact.employee_id = employee.id
          where employee.id = outbox.recipient_employee_id
            and employee.status in ('active', 'leave')
            and private.preferred_delivery_email(contact.personal_email, contact.company_email) is not null
        )
        when outbox.message_type = 'call_off_supervisor_alert' then (
          select coalesce(
            jsonb_agg(distinct private.preferred_delivery_email(contact.personal_email, contact.company_email)),
            '[]'::jsonb
          )
          from public.employees employee
          join private.employee_contacts contact on contact.employee_id = employee.id
          where employee.status = 'active'
            and employee.role in ('supervisor', 'admin')
            and private.preferred_delivery_email(contact.personal_email, contact.company_email) is not null
        )
        when outbox.message_type = 'announcement_published' then (
          select coalesce(
            jsonb_agg(distinct private.preferred_delivery_email(contact.personal_email, contact.company_email)),
            '[]'::jsonb
          )
          from public.announcements announcement
          left join public.shifts shift on shift.id = announcement.shift_id
          join public.employees employee on employee.status = 'active'
          join private.employee_contacts contact on contact.employee_id = employee.id
          where announcement.id = outbox.aggregate_id
            and employee.role in ('guard', 'supervisor', 'admin')
            and private.preferred_delivery_email(contact.personal_email, contact.company_email) is not null
            and (
              coalesce(shift.requires_armed, announcement.kind = 'event' and exists (
                select 1 from public.events event where event.id = announcement.event_id and event.requires_armed
              )) is false
              or public.has_valid_credential(employee.id, 'armed_guard', current_date)
            )
        )
        when outbox.message_type = 'schedule_published' then (
          select coalesce(
            jsonb_agg(distinct private.preferred_delivery_email(contact.personal_email, contact.company_email)),
            '[]'::jsonb
          )
          from public.employees employee
          join private.employee_contacts contact on contact.employee_id = employee.id
          where employee.status = 'active'
            and private.preferred_delivery_email(contact.personal_email, contact.company_email) is not null
            and (
              employee.role in ('dispatcher', 'scheduler', 'supervisor', 'admin')
              or exists (
                select 1
                from public.shift_assignments assignment
                join public.shifts shift on shift.id = assignment.shift_id
                where shift.schedule_id = outbox.aggregate_id
                  and shift.canceled_at is null
                  and assignment.employee_id = employee.id
                  and assignment.status <> 'canceled'
              )
            )
        )
        else '[]'::jsonb
      end as recipients
    from touched outbox
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'messageType', message_type,
        'aggregateType', aggregate_type,
        'aggregateId', aggregate_id,
        'attemptCount', attempt_count,
        'recipients', recipients,
        'message', message
      )
      order by id
    ),
    '[]'::jsonb
  )
  into claimed
  from expanded;

  return claimed;
end
$$;

-- Recompile the signature-envelope RPC with an unambiguous recipient variable.
-- The public signature, service-only authorization, idempotency key, audit
-- events, and release/MFA/permission checks are intentionally unchanged.
create or replace function public.service_create_signature_envelope(
  target_actor_id uuid,
  target_document_id uuid,
  target_template_version_id uuid,
  target_policy_id uuid,
  target_title text,
  target_message text,
  target_expires_at timestamptz,
  target_recipients jsonb,
  target_idempotency_key uuid,
  target_mfa_method text,
  target_mfa_verified_at timestamptz,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  effective_permissions text[] := private.document_studio_require_permission(target_actor_id, 'documents.signatures.request');
  document_record private.hr_documents%rowtype;
  version_record private.hr_document_versions%rowtype;
  policy_record private.document_policies%rowtype;
  template_record private.document_template_versions%rowtype;
  created_envelope_id uuid;
  recipient_value jsonb;
  recipient_employee_id uuid;
  external_email text;
  initial_status text;
begin
  perform private.document_studio_require_recent_mfa(target_mfa_method, target_mfa_verified_at);
  if not exists (
    select 1
    from private.document_studio_release_gate release_gate
    where release_gate.gate = 'signatures'
      and release_gate.enabled
  ) then
    raise insufficient_privilege using message = 'Signature workflows have not been released.';
  end if;
  if not private.document_studio_can_view_document(target_actor_id, target_document_id, effective_permissions) then
    raise insufficient_privilege using message = 'The document is unavailable.';
  end if;

  select document.*
  into document_record
  from private.hr_documents document
  where document.id = target_document_id
    and document.archived_at is null
  for update;

  select version.*
  into version_record
  from private.hr_document_versions version
  where version.id = document_record.current_version_id;

  if version_record.id is null
     or private.hr_document_latest_scan_state(version_record.id) <> 'clean' then
    raise insufficient_privilege using message = 'Only the current security-reviewed document version can be sent.';
  end if;

  select policy.*
  into policy_record
  from private.document_policies policy
  where policy.id = target_policy_id
    and policy.active;

  if policy_record.id is null then
    raise check_violation using message = 'Choose an active document policy.';
  end if;
  if policy_record.regulated
     and not exists (
       select 1
       from private.document_studio_release_gate release_gate
       where release_gate.gate = 'regulated_documents'
         and release_gate.enabled
     ) then
    raise insufficient_privilege using message = 'This regulated-document policy has not completed compliance release.';
  end if;

  if policy_record.execution_method in ('external', 'paper', 'not_eligible') then
    initial_status := 'external_process_required';
  else
    initial_status := 'draft';
  end if;

  if target_template_version_id is not null then
    select template.*
    into template_record
    from private.document_template_versions template
    where template.id = target_template_version_id
      and template.status = 'published';

    if template_record.id is null
       or template_record.source_document_id <> document_record.id
       or template_record.source_version_id <> version_record.id
       or template_record.policy_id <> policy_record.id then
      raise check_violation using message = 'The published template does not match this document version and policy.';
    end if;
  end if;

  if jsonb_typeof(target_recipients) <> 'array'
     or jsonb_array_length(target_recipients) < 1
     or jsonb_array_length(target_recipients) > 25 then
    raise check_violation using message = 'Add between one and 25 recipients.';
  end if;

  select envelope.id
  into created_envelope_id
  from private.signature_envelopes envelope
  where envelope.idempotency_key = target_idempotency_key;

  if created_envelope_id is not null then
    return jsonb_build_object(
      'id', created_envelope_id,
      'status', (
        select envelope.status
        from private.signature_envelopes envelope
        where envelope.id = created_envelope_id
      )
    );
  end if;

  insert into private.signature_envelopes(
    document_id,
    document_version_id,
    template_version_id,
    policy_id,
    title,
    status,
    routing_mode,
    message,
    expires_at,
    created_by,
    idempotency_key
  ) values (
    document_record.id,
    version_record.id,
    target_template_version_id,
    policy_record.id,
    btrim(target_title),
    initial_status,
    policy_record.routing_mode,
    nullif(btrim(target_message), ''),
    coalesce(
      target_expires_at,
      case
        when policy_record.expiration_days is null then null
        else clock_timestamp() + make_interval(days => policy_record.expiration_days)
      end
    ),
    target_actor_id,
    target_idempotency_key
  )
  returning id into created_envelope_id;

  for recipient_value in
    select recipient.value
    from jsonb_array_elements(target_recipients) recipient(value)
  loop
    recipient_employee_id := nullif(recipient_value ->> 'employeeId', '')::uuid;
    external_email := nullif(lower(btrim(recipient_value ->> 'externalEmail')), '');
    if num_nonnulls(recipient_employee_id, external_email) <> 1 then
      raise check_violation using message = 'Each recipient must identify one employee or approved external signer.';
    end if;

    if external_email is not null then
      if not policy_record.allows_external_signers
         or not exists (
           select 1
           from private.document_studio_release_gate release_gate
           where release_gate.gate = 'external_signers'
             and release_gate.enabled
         ) then
        raise insufficient_privilege using message = 'External signing has not been approved for this policy.';
      end if;
    elsif not exists (
      select 1
      from public.employees employee
      join private.employee_accounts account
        on account.employee_id = employee.id
      where employee.id = recipient_employee_id
        and employee.status in ('active', 'leave')
        and account.disabled_at is null
    ) then
      raise check_violation using message = 'Choose an active employee recipient.';
    end if;

    insert into private.signature_recipients(
      envelope_id,
      employee_id,
      external_email,
      external_name,
      recipient_role,
      required_action,
      routing_order,
      authentication_tier,
      status
    ) values (
      created_envelope_id,
      recipient_employee_id,
      external_email,
      nullif(btrim(recipient_value ->> 'externalName'), ''),
      btrim(recipient_value ->> 'recipientRole'),
      coalesce(nullif(recipient_value ->> 'requiredAction', ''), 'sign'),
      coalesce((recipient_value ->> 'routingOrder')::integer, 1),
      coalesce(nullif(recipient_value ->> 'authenticationTier', ''), policy_record.authentication_tier),
      case when initial_status = 'external_process_required' then 'blocked' else 'pending' end
    );
  end loop;

  insert into private.signature_events(
    envelope_id,
    document_id,
    document_version_id,
    actor_employee_id,
    event_type,
    event_reason,
    source_checksum,
    request_id,
    metadata
  ) values (
    created_envelope_id,
    document_record.id,
    version_record.id,
    target_actor_id,
    'created',
    'Signature envelope prepared.',
    version_record.sha256_checksum,
    nullif(btrim(target_request_id), ''),
    jsonb_build_object(
      'recipientCount', jsonb_array_length(target_recipients),
      'routingMode', policy_record.routing_mode
    )
  );

  insert into private.signature_events(
    envelope_id,
    recipient_id,
    document_id,
    document_version_id,
    actor_employee_id,
    event_type,
    event_reason,
    source_checksum,
    request_id,
    metadata
  )
  select
    created_envelope_id,
    recipient.id,
    document_record.id,
    version_record.id,
    target_actor_id,
    'recipient_assigned',
    'Recipient assigned to protected envelope.',
    version_record.sha256_checksum,
    nullif(btrim(target_request_id), ''),
    jsonb_build_object(
      'recipientRole', recipient.recipient_role,
      'routingOrder', recipient.routing_order,
      'requiredAction', recipient.required_action
    )
  from private.signature_recipients recipient
  where recipient.envelope_id = created_envelope_id;

  update private.hr_documents document
  set
    lifecycle_state = case
      when initial_status = 'external_process_required' then document.lifecycle_state
      else 'draft'
    end,
    document_policy_id = policy_record.id,
    template_version_id = target_template_version_id
  where document.id = document_record.id;

  return jsonb_build_object(
    'id', created_envelope_id,
    'status', initial_status,
    'recipientCount', jsonb_array_length(target_recipients)
  );
end
$$;

-- Recompile the signature-action RPC with pgcrypto resolved explicitly from
-- the extensions schema while retaining its empty search path and full audit,
-- consent, routing, finalization, and idempotent-completion behavior.
create or replace function public.service_record_signature_action(
  target_actor_id uuid,
  target_recipient_id uuid,
  target_action text,
  target_field_values jsonb,
  target_consent_version text,
  target_consent_shown_at timestamptz,
  target_signature_method text,
  target_signature_style text,
  target_display_name text,
  target_appearance_bucket text,
  target_appearance_object_key text,
  target_appearance_checksum text,
  target_save_adoption boolean,
  target_reason text,
  target_mfa_method text,
  target_mfa_verified_at timestamptz,
  target_session_reference_hash text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  effective_permissions text[] := private.document_studio_require_actor(target_actor_id);
  recipient_record private.signature_recipients%rowtype;
  envelope_record private.signature_envelopes%rowtype;
  policy_record private.document_policies%rowtype;
  version_record private.hr_document_versions%rowtype;
  legal_name text;
  auth_evidence_id uuid;
  consent_id uuid;
  event_id uuid;
  event_type text;
  remaining_count integer;
  field_value record;
  fields_checksum text;
  needs_signature_appearance boolean;
begin
  if not ('documents.signatures.sign_own' = any(effective_permissions)) then
    raise insufficient_privilege using message = 'Document-signing access is required.';
  end if;
  if not exists (
    select 1
    from private.hr_document_release_gate release_gate
    where release_gate.singleton
      and release_gate.enabled
  ) or not exists (
    select 1
    from private.document_studio_release_gate release_gate
    where release_gate.gate = 'signatures'
      and release_gate.enabled
  ) then
    raise insufficient_privilege using message = 'Signature workflows have not been released.';
  end if;

  select recipient.*
  into recipient_record
  from private.signature_recipients recipient
  where recipient.id = target_recipient_id
    and recipient.employee_id = target_actor_id
  for update;

  if recipient_record.id is null then
    raise no_data_found using message = 'The assigned signature action was not found.';
  end if;

  select envelope.*
  into envelope_record
  from private.signature_envelopes envelope
  where envelope.id = recipient_record.envelope_id
  for update;

  select policy.*
  into policy_record
  from private.document_policies policy
  where policy.id = envelope_record.policy_id;

  select version.*
  into version_record
  from private.hr_document_versions version
  where version.id = envelope_record.document_version_id;

  if recipient_record.status = 'completed' then
    return jsonb_build_object(
      'recipientId', recipient_record.id,
      'envelopeId', envelope_record.id,
      'status', envelope_record.status,
      'idempotent', true,
      'finalizationRequired', envelope_record.status = 'finalizing'
    );
  end if;

  if recipient_record.status not in ('pending', 'delivered', 'viewed', 'in_progress')
     or envelope_record.status not in ('sent', 'delivered', 'viewed', 'in_progress', 'waiting') then
    raise check_violation using message = 'This document action is no longer available.';
  end if;

  if envelope_record.expires_at is not null
     and envelope_record.expires_at <= clock_timestamp() then
    update private.signature_envelopes envelope
    set status = 'expired'
    where envelope.id = envelope_record.id;

    update private.signature_recipients recipient
    set status = 'expired'
    where recipient.envelope_id = envelope_record.id
      and recipient.status not in ('completed', 'declined', 'correction_requested', 'voided', 'reassigned');

    raise check_violation using message = 'This signature request has expired.';
  end if;

  if envelope_record.routing_mode = 'sequential'
     and exists (
       select 1
       from private.signature_recipients prior
       where prior.envelope_id = envelope_record.id
         and prior.routing_order < recipient_record.routing_order
         and prior.status <> 'completed'
     ) then
    raise check_violation using message = 'This document is waiting for an earlier signer.';
  end if;

  if target_action = 'decline' then
    if not policy_record.allows_decline then
      raise insufficient_privilege using message = 'This document policy does not allow decline.';
    end if;
    if btrim(coalesce(target_reason, '')) = '' then
      raise check_violation using message = 'A decline reason is required.';
    end if;

    update private.signature_recipients recipient
    set
      status = 'declined',
      acted_at = clock_timestamp(),
      decline_reason = btrim(target_reason)
    where recipient.id = recipient_record.id;

    update private.signature_envelopes envelope
    set
      status = 'declined',
      declined_at = clock_timestamp()
    where envelope.id = envelope_record.id;
    event_type := 'declined';
  elsif target_action = 'request_correction' then
    if not policy_record.allows_correction_request then
      raise insufficient_privilege using message = 'This document policy does not allow correction requests.';
    end if;
    if btrim(coalesce(target_reason, '')) = '' then
      raise check_violation using message = 'Explain the correction that is needed.';
    end if;

    update private.signature_recipients recipient
    set
      status = 'correction_requested',
      acted_at = clock_timestamp(),
      correction_reason = btrim(target_reason)
    where recipient.id = recipient_record.id;

    update private.signature_envelopes envelope
    set status = 'correction_requested'
    where envelope.id = envelope_record.id;
    event_type := 'correction_requested';
  else
    if target_action <> recipient_record.required_action then
      raise check_violation using message = 'The submitted action does not match the assigned action.';
    end if;
    if target_consent_version is distinct from policy_record.consent_version then
      raise check_violation using message = 'The consent statement changed. Review the current statement before continuing.';
    end if;
    if target_consent_shown_at is null
       or target_consent_shown_at > clock_timestamp() + interval '1 minute'
       or target_consent_shown_at < clock_timestamp() - interval '2 hours' then
      raise check_violation using message = 'Reopen the document and review the consent statement before continuing.';
    end if;

    if recipient_record.authentication_tier in ('elevated', 'specialized') then
      perform private.document_studio_require_recent_mfa(
        target_mfa_method,
        target_mfa_verified_at,
        interval '10 minutes'
      );
    elsif target_mfa_method in ('authenticator', 'security_key') then
      perform private.document_studio_require_recent_mfa(
        target_mfa_method,
        target_mfa_verified_at,
        interval '15 minutes'
      );
    end if;

    if recipient_record.authentication_tier = 'specialized' then
      raise insufficient_privilege using message = 'This document requires an approved specialized execution process.';
    end if;

    needs_signature_appearance := target_action in ('sign', 'initial', 'countersign', 'witness');
    if needs_signature_appearance and (
      target_signature_method not in ('typed', 'drawn', 'uploaded', 'saved')
      or target_appearance_bucket <> 'signature-appearances'
      or btrim(coalesce(target_appearance_object_key, '')) = ''
      or target_appearance_checksum !~ '^[a-f0-9]{64}$'
      or btrim(coalesce(target_display_name, '')) = ''
    ) then
      raise check_violation using message = 'Choose and confirm a valid signature appearance.';
    end if;

    if envelope_record.template_version_id is not null
       and exists (
         select 1
         from private.document_field_definitions field
         where field.template_version_id = envelope_record.template_version_id
           and (field.signer_role_code is null or field.signer_role_code = recipient_record.recipient_role)
           and field.required
           and field.field_type not in ('signature', 'initials', 'signer_date', 'system_value')
           and not (coalesce(target_field_values, '{}'::jsonb) ? field.field_key)
       ) then
      raise check_violation using message = 'Complete every required assigned field before submitting.';
    end if;

    select btrim(concat_ws(' ', employee.first_name, employee.middle_name, employee.last_name))
    into legal_name
    from public.employees employee
    where employee.id = target_actor_id;

    insert into private.signature_authentication_evidence(
      envelope_id,
      recipient_id,
      employee_id,
      authentication_tier,
      authentication_method,
      verified_at,
      session_reference_hash,
      request_id
    ) values (
      envelope_record.id,
      recipient_record.id,
      target_actor_id,
      recipient_record.authentication_tier,
      case
        when target_mfa_method in ('authenticator', 'security_key') then target_mfa_method
        else 'session'
      end,
      coalesce(target_mfa_verified_at, clock_timestamp()),
      nullif(target_session_reference_hash, ''),
      nullif(btrim(target_request_id), '')
    )
    returning id into auth_evidence_id;

    insert into private.signature_consent_records(
      envelope_id,
      recipient_id,
      consent_text,
      consent_version,
      shown_at,
      accepted_at,
      confirmation_action,
      document_version_id,
      request_id
    ) values (
      envelope_record.id,
      recipient_record.id,
      policy_record.consent_text,
      policy_record.consent_version,
      target_consent_shown_at,
      clock_timestamp(),
      'Adopt & Sign',
      envelope_record.document_version_id,
      nullif(btrim(target_request_id), '')
    )
    returning id into consent_id;

    if jsonb_typeof(coalesce(target_field_values, '{}'::jsonb)) <> 'object' then
      raise check_violation using message = 'Document field values are invalid.';
    end if;

    for field_value in
      select field_entry.key, field_entry.value
      from jsonb_each(coalesce(target_field_values, '{}'::jsonb)) field_entry(key, value)
    loop
      if envelope_record.template_version_id is null
         or not exists (
           select 1
           from private.document_field_definitions field
           where field.template_version_id = envelope_record.template_version_id
             and field.field_key = field_value.key
             and (field.signer_role_code is null or field.signer_role_code = recipient_record.recipient_role)
             and not field.read_only
         ) then
        raise insufficient_privilege using message = 'A submitted document field is not assigned to you.';
      end if;

      insert into private.signature_field_values(
        envelope_id,
        recipient_id,
        field_definition_id,
        field_key,
        value_text,
        value_json,
        authoritative_source
      )
      select
        envelope_record.id,
        recipient_record.id,
        field.id,
        field.field_key,
        case when jsonb_typeof(field_value.value) = 'string' then field_value.value #>> '{}' else null end,
        case when jsonb_typeof(field_value.value) <> 'string' then field_value.value else null end,
        null
      from private.document_field_definitions field
      where field.template_version_id = envelope_record.template_version_id
        and field.field_key = field_value.key;
    end loop;

    fields_checksum := encode(
      extensions.digest(
        convert_to(coalesce(target_field_values, '{}'::jsonb)::text, 'UTF8'),
        'sha256'
      ),
      'hex'
    );
    event_type := case target_action
      when 'sign' then 'signed'
      when 'initial' then 'initialed'
      when 'acknowledge' then 'acknowledged'
      when 'approve' then 'approved'
      when 'certify' then 'certified'
      when 'countersign' then 'signed'
      when 'witness' then 'signed'
      else 'field_completed'
    end;

    insert into private.signature_events(
      envelope_id,
      recipient_id,
      document_id,
      document_version_id,
      actor_employee_id,
      event_type,
      event_reason,
      authentication_evidence_id,
      consent_record_id,
      signature_method,
      signature_style,
      display_name,
      appearance_bucket,
      appearance_object_key,
      appearance_checksum,
      source_checksum,
      field_values_checksum,
      request_id,
      metadata
    ) values (
      envelope_record.id,
      recipient_record.id,
      envelope_record.document_id,
      envelope_record.document_version_id,
      target_actor_id,
      event_type,
      'Assigned document action completed.',
      auth_evidence_id,
      consent_id,
      case when needs_signature_appearance then target_signature_method else null end,
      case when needs_signature_appearance then nullif(target_signature_style, '') else null end,
      case when needs_signature_appearance then btrim(target_display_name) else null end,
      case when needs_signature_appearance then target_appearance_bucket else null end,
      case when needs_signature_appearance then target_appearance_object_key else null end,
      case when needs_signature_appearance then target_appearance_checksum else null end,
      version_record.sha256_checksum,
      fields_checksum,
      nullif(btrim(target_request_id), ''),
      jsonb_build_object(
        'verifiedLegalName', legal_name,
        'employeeId', target_actor_id,
        'recipientRole', recipient_record.recipient_role,
        'authenticationTier', recipient_record.authentication_tier
      )
    )
    returning id into event_id;

    update private.signature_recipients recipient
    set
      status = 'completed',
      acted_at = clock_timestamp()
    where recipient.id = recipient_record.id;

    if target_save_adoption
       and needs_signature_appearance
       and target_signature_method <> 'saved' then
      update private.signature_adoptions adoption
      set
        active = false,
        replaced_at = clock_timestamp()
      where adoption.employee_id = target_actor_id
        and adoption.active;

      insert into private.signature_adoptions(
        employee_id,
        method,
        style_code,
        display_name,
        appearance_bucket,
        appearance_object_key,
        appearance_checksum,
        verified_at,
        authentication_method
      ) values (
        target_actor_id,
        case when target_signature_method = 'saved' then 'typed' else target_signature_method end,
        case
          when target_signature_method in ('typed', 'saved') then coalesce(nullif(target_signature_style, ''), 'simple')
          else null
        end,
        btrim(target_display_name),
        case when target_signature_method in ('typed', 'saved') then null else target_appearance_bucket end,
        case when target_signature_method in ('typed', 'saved') then null else target_appearance_object_key end,
        case when target_signature_method in ('typed', 'saved') then null else target_appearance_checksum end,
        coalesce(target_mfa_verified_at, clock_timestamp()),
        case
          when target_mfa_method in ('authenticator', 'security_key') then target_mfa_method
          else 'authenticator'
        end
      );
    end if;

    select count(*)
    into remaining_count
    from private.signature_recipients recipient
    where recipient.envelope_id = envelope_record.id
      and recipient.status not in ('completed', 'voided', 'reassigned');

    if remaining_count = 0 then
      update private.signature_envelopes envelope
      set status = 'finalizing'
      where envelope.id = envelope_record.id;

      insert into private.document_processing_jobs(
        document_id,
        version_id,
        envelope_id,
        job_type,
        status,
        idempotency_key
      ) values (
        envelope_record.document_id,
        envelope_record.document_version_id,
        envelope_record.id,
        'finalize_signature',
        'queued',
        'finalize-signature:' || envelope_record.id::text
      )
      on conflict (idempotency_key) do nothing;

      insert into private.signature_events(
        envelope_id,
        document_id,
        document_version_id,
        actor_employee_id,
        event_type,
        event_reason,
        source_checksum,
        request_id,
        metadata
      ) values (
        envelope_record.id,
        envelope_record.document_id,
        envelope_record.document_version_id,
        target_actor_id,
        'finalization_started',
        'All required recipient actions are complete.',
        version_record.sha256_checksum,
        nullif(btrim(target_request_id), ''),
        '{}'::jsonb
      );
    else
      update private.signature_envelopes envelope
      set status = 'waiting'
      where envelope.id = envelope_record.id;

      if envelope_record.routing_mode = 'sequential' then
        insert into private.notification_outbox(
          message_type,
          aggregate_type,
          aggregate_id,
          recipient_employee_id,
          payload,
          idempotency_key
        )
        select
          'document_signature_required',
          'signature_envelope',
          envelope_record.id,
          next_recipient.employee_id,
          jsonb_build_object(
            'subject', 'Document action required',
            'message', envelope_record.title,
            'envelopeId', envelope_record.id,
            'path', '/my-documents',
            'expiresAt', envelope_record.expires_at
          ),
          'signature-envelope-advanced:' || envelope_record.id::text || ':' || next_recipient.id::text
        from private.signature_recipients next_recipient
        where next_recipient.envelope_id = envelope_record.id
          and next_recipient.status = 'pending'
          and next_recipient.employee_id is not null
        order by next_recipient.routing_order
        limit 1
        on conflict (idempotency_key) do nothing;
      end if;
    end if;
  end if;

  if event_type in ('declined', 'correction_requested') then
    insert into private.signature_events(
      envelope_id,
      recipient_id,
      document_id,
      document_version_id,
      actor_employee_id,
      event_type,
      event_reason,
      source_checksum,
      request_id,
      metadata
    ) values (
      envelope_record.id,
      recipient_record.id,
      envelope_record.document_id,
      envelope_record.document_version_id,
      target_actor_id,
      event_type,
      btrim(target_reason),
      version_record.sha256_checksum,
      nullif(btrim(target_request_id), ''),
      '{}'::jsonb
    )
    returning id into event_id;
  end if;

  return jsonb_build_object(
    'recipientId', recipient_record.id,
    'envelopeId', envelope_record.id,
    'eventId', event_id,
    'status', (
      select envelope.status
      from private.signature_envelopes envelope
      where envelope.id = envelope_record.id
    ),
    'finalizationRequired', remaining_count = 0
      and event_type not in ('declined', 'correction_requested')
  );
end
$$;

revoke all on function public.service_create_signature_envelope(
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  text,
  timestamptz,
  jsonb,
  uuid,
  text,
  timestamptz,
  text
) from public, anon, authenticated;
grant execute on function public.service_create_signature_envelope(
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  text,
  timestamptz,
  jsonb,
  uuid,
  text,
  timestamptz,
  text
) to service_role;

revoke all on function public.service_record_signature_action(
  uuid,
  uuid,
  text,
  jsonb,
  text,
  timestamptz,
  text,
  text,
  text,
  text,
  text,
  text,
  boolean,
  text,
  text,
  timestamptz,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.service_record_signature_action(
  uuid,
  uuid,
  text,
  jsonb,
  text,
  timestamptz,
  text,
  text,
  text,
  text,
  text,
  text,
  boolean,
  text,
  text,
  timestamptz,
  text,
  text
) to service_role;

revoke all on function private.mirror_signature_request_notification()
  from public, anon, authenticated;
revoke all on function private.deliver_accountability_writeup_to_employee()
  from public, anon, authenticated;
revoke all on function private.enforce_notification_delivery_lease()
  from public, anon, authenticated;
revoke all on function public.service_claim_notification_batch(integer)
  from public, anon, authenticated;
grant execute on function public.service_claim_notification_batch(integer)
  to service_role;

notify pgrst, 'reload schema';

commit;
