begin;

create or replace function public.service_claim_sygsphere_resumable_scan(target_upload_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  item private.sygsphere_resumable_uploads%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise insufficient_privilege;
  end if;

  select *
  into item
  from private.sygsphere_resumable_uploads
  where id = target_upload_id
  for update;

  if item.id is null then
    return jsonb_build_object('terminal', true);
  end if;

  if item.state in ('clean', 'rejected', 'error', 'expired') then
    return jsonb_strip_nulls(jsonb_build_object(
      'terminal', true,
      'state', item.state,
      'objectKey', case when item.state = 'clean' then null else item.object_key end
    ));
  end if;

  if item.state in ('prepared', 'uploading', 'uploaded') and item.expires_at <= clock_timestamp() then
    update private.sygsphere_resumable_uploads
    set state = 'expired', lease_id = null, updated_at = clock_timestamp()
    where id = item.id;

    return jsonb_build_object('terminal', true, 'state', 'expired', 'objectKey', item.object_key);
  end if;

  if item.state = 'scanning' and item.updated_at > clock_timestamp() - interval '8 minutes' then
    return jsonb_build_object('terminal', false, 'deferred', true);
  end if;

  if item.state not in ('uploaded', 'scanning') or item.available_at > clock_timestamp() then
    return jsonb_build_object('terminal', false, 'deferred', true);
  end if;

  if item.attempt_count >= 5 then
    update private.sygsphere_resumable_uploads
    set state = 'error',
        lease_id = null,
        last_error = 'The malware scan could not be completed after five attempts.',
        updated_at = clock_timestamp()
    where id = item.id;

    return jsonb_build_object('terminal', true, 'state', 'error', 'objectKey', item.object_key);
  end if;

  update private.sygsphere_resumable_uploads
  set state = 'scanning',
      lease_id = gen_random_uuid(),
      attempt_count = attempt_count + 1,
      updated_at = clock_timestamp(),
      last_error = null
  where id = item.id
  returning * into item;

  return jsonb_build_object(
    'terminal', false,
    'deferred', false,
    'uploadId', item.id,
    'conversationId', item.conversation_id,
    'authorId', item.author_id,
    'parentId', item.parent_id,
    'bucket', 'sygsphere-files',
    'objectKey', item.object_key,
    'filename', item.filename,
    'mimeType', item.mime_type,
    'sizeBytes', item.size_bytes,
    'leaseId', item.lease_id
  );
end
$$;

create or replace function public.service_defer_sygsphere_resumable_scan(
  target_upload_id uuid,
  target_lease_id uuid,
  target_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  item private.sygsphere_resumable_uploads%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise insufficient_privilege;
  end if;

  update private.sygsphere_resumable_uploads
  set state = case when attempt_count >= 5 then 'error' else 'uploaded' end,
      lease_id = null,
      available_at = clock_timestamp() + interval '30 seconds',
      last_error = left(coalesce(nullif(trim(target_error), ''), 'The malware scan was interrupted.'), 1000),
      updated_at = clock_timestamp()
  where id = target_upload_id
    and state = 'scanning'
    and lease_id = target_lease_id
  returning * into item;

  if item.id is null then
    select *
    into item
    from private.sygsphere_resumable_uploads
    where id = target_upload_id;

    if item.id is null then
      return jsonb_build_object('terminal', true, 'state', 'missing');
    end if;

    if item.state in ('clean', 'rejected', 'error', 'expired') then
      return jsonb_strip_nulls(jsonb_build_object(
        'terminal', true,
        'state', item.state,
        'objectKey', case when item.state in ('rejected', 'error', 'expired') then item.object_key else null end
      ));
    end if;

    return jsonb_build_object('terminal', false, 'stale', true, 'state', item.state);
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'terminal', item.state = 'error',
    'state', item.state,
    'objectKey', case when item.state = 'error' then item.object_key else null end
  ));
end
$$;

revoke all on function public.service_claim_sygsphere_resumable_scan(uuid) from public, anon, authenticated;
revoke all on function public.service_defer_sygsphere_resumable_scan(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.service_claim_sygsphere_resumable_scan(uuid) to service_role;
grant execute on function public.service_defer_sygsphere_resumable_scan(uuid, uuid, text) to service_role;

comment on function public.service_claim_sygsphere_resumable_scan(uuid) is
  'Claims one resumable SygSphere scan lease and never returns a clean file key as deletion material.';
comment on function public.service_defer_sygsphere_resumable_scan(uuid, uuid, text) is
  'Defers a resumable SygSphere scan retry while withholding object keys from clean and nonterminal responses.';

notify pgrst, 'reload schema';

commit;
