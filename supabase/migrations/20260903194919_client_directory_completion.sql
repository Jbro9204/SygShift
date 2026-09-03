begin;

create sequence if not exists public.client_number_sequence start with 1000;
select setval('public.client_number_sequence', greatest(coalesce((select max(substring(client_number from '[0-9]+')::bigint) from public.clients), 999), 999), true);

create or replace function public.upsert_client(target_client jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  target_id uuid;
  next_number text;
begin
  if actor_id is null or not private.client_can('clients.manage') then
    raise insufficient_privilege using message = 'Client management permission is required.';
  end if;
  target_id := nullif(target_client->>'id', '')::uuid;
  if btrim(coalesce(target_client->>'legalName', '')) = '' or btrim(coalesce(target_client->>'displayName', '')) = '' then
    raise check_violation using message = 'Legal name and display name are required.';
  end if;
  if target_id is null then
    next_number := 'CLI-' || lpad(nextval('public.client_number_sequence')::text, 4, '0');
    insert into public.clients(client_number, legal_name, display_name, dba_name, status, service_tier, industry, account_owner_employee_id, billing_email, billing_phone, website, address_line_1, address_line_2, city, region, postal_code, time_zone, service_started_on, service_ended_on, renewal_on, internal_notes, created_by, updated_by)
    values(next_number, btrim(target_client->>'legalName'), btrim(target_client->>'displayName'), nullif(btrim(target_client->>'dbaName'), ''), coalesce(nullif(target_client->>'status', ''), 'prospect'), nullif(btrim(target_client->>'serviceTier'), ''), nullif(btrim(target_client->>'industry'), ''), nullif(target_client->>'accountOwnerEmployeeId', '')::uuid, nullif(btrim(target_client->>'billingEmail'), ''), nullif(btrim(target_client->>'billingPhone'), ''), nullif(btrim(target_client->>'website'), ''), nullif(btrim(target_client->>'addressLine1'), ''), nullif(btrim(target_client->>'addressLine2'), ''), nullif(btrim(target_client->>'city'), ''), nullif(btrim(target_client->>'region'), ''), nullif(btrim(target_client->>'postalCode'), ''), coalesce(nullif(target_client->>'timeZone', ''), 'America/Denver'), nullif(target_client->>'serviceStartedOn', '')::date, nullif(target_client->>'serviceEndedOn', '')::date, nullif(target_client->>'renewalOn', '')::date, nullif(btrim(target_client->>'internalNotes'), ''), actor_id, actor_id)
    returning id into target_id;
  else
    update public.clients
    set legal_name = btrim(target_client->>'legalName'), display_name = btrim(target_client->>'displayName'), dba_name = nullif(btrim(target_client->>'dbaName'), ''), status = coalesce(nullif(target_client->>'status',''), status), service_tier = nullif(btrim(target_client->>'serviceTier'), ''), industry = nullif(btrim(target_client->>'industry'), ''), account_owner_employee_id = nullif(target_client->>'accountOwnerEmployeeId','')::uuid, billing_email = nullif(btrim(target_client->>'billingEmail'), ''), billing_phone = nullif(btrim(target_client->>'billingPhone'), ''), website = nullif(btrim(target_client->>'website'), ''), address_line_1 = nullif(btrim(target_client->>'addressLine1'), ''), address_line_2 = nullif(btrim(target_client->>'addressLine2'), ''), city = nullif(btrim(target_client->>'city'), ''), region = nullif(btrim(target_client->>'region'), ''), postal_code = nullif(btrim(target_client->>'postalCode'), ''), time_zone = coalesce(nullif(target_client->>'timeZone',''), time_zone), service_started_on = nullif(target_client->>'serviceStartedOn','')::date, service_ended_on = nullif(target_client->>'serviceEndedOn','')::date, renewal_on = nullif(target_client->>'renewalOn','')::date, internal_notes = nullif(btrim(target_client->>'internalNotes'), ''), updated_by = actor_id, updated_at = clock_timestamp()
    where id = target_id and archived_at is null;
    if not found then raise no_data_found using message = 'Client File was not found.'; end if;
  end if;
  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values((select auth.uid()), actor_id, 'public', 'clients', 'CLIENT_FILE_SAVED', target_id::text, jsonb_build_object('clientId', target_id, 'reason', coalesce(target_client->>'changeReason','Client File updated')));
  return target_id;
end
$$;

create or replace function public.get_client_import_source_records(target_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null or not private.client_can('clients.import.manage') then
    raise insufficient_privilege using message = 'Client import permission is required.';
  end if;
  if not exists (select 1 from public.clients where id = target_client_id and archived_at is null) then
    raise no_data_found using message = 'Client File was not found.';
  end if;

  return jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', source.id,
        'sourceTab', source.source_tab,
        'sourceRow', source.source_row,
        'sourcePayload', source.source_payload,
        'reviewState', source.review_state,
        'reviewedAt', source.reviewed_at,
        'reviewNote', source.review_note
      ) order by source.source_tab, source.source_row)
      from private.client_import_rows source
      where coalesce(source.promoted_client_id, source.matched_client_id) = target_client_id
    ), '[]'::jsonb)
  );
end
$$;

create or replace function public.resolve_client_import_row(
  target_row_id uuid,
  target_action text,
  target_client_id uuid default null,
  target_client jsonb default null,
  target_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  resolved_id uuid;
  import_row private.client_import_rows%rowtype;
begin
  if actor_id is null or not private.client_can('clients.import.manage') then
    raise insufficient_privilege using message = 'Client import permission is required.';
  end if;
  if length(btrim(coalesce(target_note, ''))) < 5 then
    raise check_violation using message = 'Enter a review note.';
  end if;

  select * into import_row
  from private.client_import_rows
  where id = target_row_id and review_state = 'needs_review'
  for update;
  if not found then
    raise no_data_found using message = 'The staged source row is no longer pending review.';
  end if;

  if target_action = 'ignore' then
    update private.client_import_rows
    set review_state = 'ignored', reviewed_by = actor_id, reviewed_at = clock_timestamp(), review_note = btrim(target_note)
    where id = target_row_id;
  elsif target_action = 'match' then
    if target_client_id is null or not exists(select 1 from public.clients where id = target_client_id and archived_at is null) then
      raise no_data_found using message = 'Choose an existing Client File.';
    end if;
    resolved_id := target_client_id;
    update private.client_import_rows
    set review_state = 'matched', matched_client_id = resolved_id, reviewed_by = actor_id, reviewed_at = clock_timestamp(), review_note = btrim(target_note)
    where id = target_row_id;
  elsif target_action = 'promote' then
    if target_client is null then
      raise check_violation using message = 'Client details are required before promotion.';
    end if;
    resolved_id := public.upsert_client(target_client);
    update private.client_import_rows
    set review_state = 'promoted', promoted_client_id = resolved_id, reviewed_by = actor_id, reviewed_at = clock_timestamp(), review_note = btrim(target_note)
    where id = target_row_id;
  else
    raise check_violation using message = 'Choose match, promote, or ignore.';
  end if;

  update private.client_import_batches batch
  set status = case
        when exists(select 1 from private.client_import_rows pending where pending.batch_id = batch.id and pending.review_state = 'needs_review') then 'in_review'
        else 'completed'
      end,
      completed_at = case
        when exists(select 1 from private.client_import_rows pending where pending.batch_id = batch.id and pending.review_state = 'needs_review') then null
        else clock_timestamp()
      end
  where batch.id = import_row.batch_id;

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values((select auth.uid()), actor_id, 'private', 'client_import_rows', 'CLIENT_IMPORT_ROW_RESOLVED', target_row_id::text,
    jsonb_build_object('action', target_action, 'clientId', resolved_id, 'sourceTab', import_row.source_tab,
      'sourceRow', import_row.source_row, 'note', btrim(target_note)));
  return resolved_id;
end
$$;

revoke all on function public.get_client_import_source_records(uuid) from public, anon;
revoke all on function public.upsert_client(jsonb) from public, anon;
revoke all on function public.resolve_client_import_row(uuid, text, uuid, jsonb, text) from public, anon;
grant execute on function public.get_client_import_source_records(uuid) to authenticated;
grant execute on function public.upsert_client(jsonb) to authenticated;
grant execute on function public.resolve_client_import_row(uuid, text, uuid, jsonb, text) to authenticated;

commit;
