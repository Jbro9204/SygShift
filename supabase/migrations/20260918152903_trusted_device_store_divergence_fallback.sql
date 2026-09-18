create or replace function public.has_trusted_device()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  primary_token text := private.request_header('x-sygshift-trusted-device');
  fallback_token text := private.request_header('x-sygshift-trusted-device-fallback');
  primary_hash text;
  fallback_hash text;
begin
  if actor_id is null then
    return false;
  end if;

  if primary_token is not null and length(primary_token) between 48 and 160 then
    primary_hash := encode(extensions.digest(primary_token, 'sha256'), 'hex');
  end if;
  if fallback_token is not null and length(fallback_token) between 48 and 160 then
    fallback_hash := encode(extensions.digest(fallback_token, 'sha256'), 'hex');
  end if;

  if primary_hash is null and fallback_hash is null then
    return false;
  end if;

  return exists (
    select 1
    from private.trusted_devices trusted_device
    where trusted_device.employee_id = actor_id
      and trusted_device.token_hash in (primary_hash, fallback_hash)
      and trusted_device.revoked_at is null
      and trusted_device.expires_at > now()
  );
end
$$;

create or replace function public.get_current_trusted_devices()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  primary_token text := private.request_header('x-sygshift-trusted-device');
  fallback_token text := private.request_header('x-sygshift-trusted-device-fallback');
  primary_hash text;
  fallback_hash text;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if primary_token is not null and length(primary_token) between 48 and 160 then
    primary_hash := encode(extensions.digest(primary_token, 'sha256'), 'hex');
  end if;
  if fallback_token is not null and length(fallback_token) between 48 and 160 then
    fallback_hash := encode(extensions.digest(fallback_token, 'sha256'), 'hex');
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', trusted_device.id,
      'deviceLabel', trusted_device.device_label,
      'createdAt', trusted_device.created_at,
      'expiresAt', trusted_device.expires_at,
      'lastSeenAt', trusted_device.last_seen_at,
      'isCurrentDevice', trusted_device.token_hash in (primary_hash, fallback_hash)
    ) order by trusted_device.expires_at desc)
    from private.trusted_devices trusted_device
    where trusted_device.employee_id = actor_id
      and trusted_device.revoked_at is null
      and trusted_device.expires_at > now()
  ), '[]'::jsonb);
end
$$;

comment on function public.has_trusted_device() is
'Validates an active 14-day remembered-device proof, including the cookie fallback used when browser storage is stale.';

comment on function public.get_current_trusted_devices() is
'Lists active remembered devices and recognizes either synchronized browser proof as the current device.';
