begin;

alter table public.employee_credentials
  add column if not exists archived_by uuid references public.employees(id) on delete restrict,
  add column if not exists archive_reason_code text,
  add column if not exists archive_reason text;

alter table public.employee_credentials
  drop constraint if exists employee_credentials_archive_metadata_complete;

alter table public.employee_credentials
  add constraint employee_credentials_archive_metadata_complete
  check (
    (
      archived_at is null
      and archived_by is null
      and archive_reason_code is null
      and archive_reason is null
    )
    or (
      archived_at is not null
      and archived_by is not null
      and archive_reason_code in (
        'wrong_employee',
        'duplicate',
        'entered_by_mistake',
        'no_longer_applicable',
        'other'
      )
      and nullif(btrim(coalesce(archive_reason, '')), '') is not null
    )
  );

create unique index if not exists employee_credentials_active_type_unique_idx
  on public.employee_credentials (employee_id, credential_type_id)
  where archived_at is null and credential_type_id is not null;

create unique index if not exists employee_credentials_active_legacy_kind_unique_idx
  on public.employee_credentials (employee_id, kind)
  where archived_at is null and credential_type_id is null;

create or replace function public.get_removed_licensing_credentials()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_licensing_mfa('licensing.view');

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'credentialId', credential.id,
        'employeeId', credential.employee_id,
        'credentialTypeId', resolved_type.id,
        'credentialTypeCode', resolved_type.code,
        'credentialName', coalesce(resolved_type.name, initcap(replace(credential.kind::text, '_', ' '))),
        'category', coalesce(resolved_type.category, 'Other'),
        'status', credential.status::text,
        'credentialNumber', credential.credential_number,
        'issuingAuthority', credential.issuing_authority,
        'issueDate', credential.valid_from,
        'expirationDate', credential.expires_on,
        'archivedAt', credential.archived_at,
        'archivedByName', btrim(coalesce(actor.preferred_name, actor.first_name) || ' ' || actor.last_name),
        'reasonCode', credential.archive_reason_code,
        'reason', credential.archive_reason,
        'documentCount', (
          select count(*)::integer
          from public.employee_credential_documents document
          where document.credential_id = credential.id
            and document.archived_at is null
            and document.upload_state = 'stored'
        )
      )
      order by credential.archived_at desc, credential.id
    )
    from public.employee_credentials credential
    join public.employees actor on actor.id = credential.archived_by
    left join lateral (
      select credential_type.id, credential_type.code, credential_type.name, credential_type.category
      from public.credential_types credential_type
      where credential_type.id = credential.credential_type_id
        or (
          credential.credential_type_id is null
          and credential_type.legacy_kind = credential.kind
        )
      order by (credential_type.id = credential.credential_type_id) desc, credential_type.active desc, credential_type.name
      limit 1
    ) resolved_type on true
    where credential.archived_at is not null
  ), '[]'::jsonb);
end
$$;

create or replace function public.archive_licensing_credential(
  target_employee_id uuid,
  target_credential_id uuid,
  target_reason_code text,
  target_reason_details text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  credential_record public.employee_credentials%rowtype;
  old_record jsonb;
  clean_reason_code text := lower(btrim(coalesce(target_reason_code, '')));
  clean_reason_details text := nullif(btrim(coalesce(target_reason_details, '')), '');
  reason_label text;
begin
  actor_id := private.require_credential_editor_mfa();

  if clean_reason_code not in (
    'wrong_employee',
    'duplicate',
    'entered_by_mistake',
    'no_longer_applicable',
    'other'
  ) then
    raise check_violation using message = 'Choose why this credential is being removed.';
  end if;

  if clean_reason_code = 'other' and length(coalesce(clean_reason_details, '')) < 5 then
    raise check_violation using message = 'Add a short explanation for Other.';
  end if;

  select credential.* into credential_record
  from public.employee_credentials credential
  where credential.id = target_credential_id
    and credential.employee_id = target_employee_id
  for update;

  if not found then
    raise no_data_found using message = 'The credential was not found on this employee profile.';
  end if;

  if credential_record.archived_at is not null then
    raise check_violation using message = 'This credential has already been removed from the profile.';
  end if;

  reason_label := case clean_reason_code
    when 'wrong_employee' then 'Added to the wrong employee'
    when 'duplicate' then 'Duplicate credential'
    when 'entered_by_mistake' then 'Entered by mistake'
    when 'no_longer_applicable' then 'No longer applicable'
    else 'Other'
  end;
  old_record := to_jsonb(credential_record);

  update public.employee_credentials credential
  set
    archived_at = clock_timestamp(),
    archived_by = actor_id,
    archive_reason_code = clean_reason_code,
    archive_reason = reason_label || case when clean_reason_details is null then '' else ': ' || left(clean_reason_details, 500) end,
    updated_at = clock_timestamp()
  where credential.id = credential_record.id
  returning credential.* into credential_record;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'public',
    'employee_credentials',
    'LICENSING_CREDENTIAL_ARCHIVED',
    credential_record.id::text,
    old_record,
    to_jsonb(credential_record)
  );

  return jsonb_build_object(
    'credentialId', credential_record.id,
    'employeeId', credential_record.employee_id,
    'state', 'removed'
  );
end
$$;

create or replace function public.restore_licensing_credential(
  target_employee_id uuid,
  target_credential_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  credential_record public.employee_credentials%rowtype;
  old_record jsonb;
begin
  actor_id := private.require_credential_editor_mfa();

  select credential.* into credential_record
  from public.employee_credentials credential
  where credential.id = target_credential_id
    and credential.employee_id = target_employee_id
  for update;

  if not found then
    raise no_data_found using message = 'The removed credential was not found on this employee profile.';
  end if;

  if credential_record.archived_at is null then
    return jsonb_build_object(
      'credentialId', credential_record.id,
      'employeeId', credential_record.employee_id,
      'state', 'restored'
    );
  end if;

  perform pg_advisory_xact_lock(hashtext(
    'licensing-credential:'
    || credential_record.employee_id::text
    || ':'
    || coalesce(credential_record.credential_type_id::text, 'legacy:' || credential_record.kind::text)
  ));

  if exists (
    select 1
    from public.employee_credentials active_credential
    where active_credential.employee_id = credential_record.employee_id
      and active_credential.archived_at is null
      and active_credential.id <> credential_record.id
      and (
        (
          credential_record.credential_type_id is not null
          and active_credential.credential_type_id = credential_record.credential_type_id
        )
        or (
          credential_record.credential_type_id is null
          and active_credential.credential_type_id is null
          and active_credential.kind = credential_record.kind
        )
        or (
          credential_record.credential_type_id is null
          and exists (
            select 1
            from public.credential_types credential_type
            where credential_type.id = active_credential.credential_type_id
              and credential_type.legacy_kind = credential_record.kind
          )
        )
        or (
          active_credential.credential_type_id is null
          and exists (
            select 1
            from public.credential_types credential_type
            where credential_type.id = credential_record.credential_type_id
              and credential_type.legacy_kind = active_credential.kind
          )
        )
      )
  ) then
    raise unique_violation using message = 'A current credential of this type is already on the employee profile.';
  end if;

  old_record := to_jsonb(credential_record);

  update public.employee_credentials credential
  set
    archived_at = null,
    archived_by = null,
    archive_reason_code = null,
    archive_reason = null,
    updated_at = clock_timestamp()
  where credential.id = credential_record.id
  returning credential.* into credential_record;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'public',
    'employee_credentials',
    'LICENSING_CREDENTIAL_RESTORED',
    credential_record.id::text,
    old_record,
    to_jsonb(credential_record)
  );

  return jsonb_build_object(
    'credentialId', credential_record.id,
    'employeeId', credential_record.employee_id,
    'state', 'restored'
  );
end
$$;

revoke all on function public.get_removed_licensing_credentials() from public, anon, authenticated;
revoke all on function public.archive_licensing_credential(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.restore_licensing_credential(uuid, uuid) from public, anon, authenticated;

grant execute on function public.get_removed_licensing_credentials() to authenticated;
grant execute on function public.archive_licensing_credential(uuid, uuid, text, text) to authenticated;
grant execute on function public.restore_licensing_credential(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
