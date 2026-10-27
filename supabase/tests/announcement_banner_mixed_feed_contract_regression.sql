begin;

do $$
declare
  actor_auth_user_id uuid;
  actor_employee_id uuid;
  actor_role public.app_role;
  banner_id uuid := gen_random_uuid();
  announcement_id uuid := gen_random_uuid();
  feed jsonb;
  ordinary_record jsonb;
begin
  select account.auth_user_id, employee.id, employee.role
  into actor_auth_user_id, actor_employee_id, actor_role
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and account.auth_user_id is not null
    and account.disabled_at is null
  order by employee.created_at
  limit 1;

  if actor_auth_user_id is null then
    raise exception 'A linked active employee account is required for the rollback-only banner contract regression.';
  end if;

  perform set_config('request.jwt.claim.sub', actor_auth_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_auth_user_id, 'role', 'authenticated', 'aal', 'aal1')::text,
    true
  );

  insert into public.announcement_banners (
    id, title, message, tone, active, starts_at, expires_at, audience
  ) values (
    banner_id,
    'Rollback-only banner contract fixture',
    'Dedicated urgent banner fixture.',
    'urgent',
    true,
    clock_timestamp() - interval '1 minute',
    clock_timestamp() + interval '1 day',
    'all'
  );

  insert into public.announcements (
    id,
    kind,
    title,
    body,
    published_at,
    expires_at,
    created_by,
    recipient_roles,
    root_announcement_id,
    content_digest,
    delivery_channels
  ) values (
    announcement_id,
    'general',
    'Rollback-only ordinary announcement fixture',
    'Ordinary employee-home announcement fixture.',
    clock_timestamp() - interval '1 minute',
    clock_timestamp() + interval '1 day',
    actor_employee_id,
    array[actor_role]::public.app_role[],
    announcement_id,
    repeat('a', 64),
    array['employee_home', 'workspace_alert']::text[]
  );

  select private.announcement_workspace_record(announcement)
  into ordinary_record
  from public.announcements announcement
  where announcement.id = announcement_id;

  if not (ordinary_record ? 'lifecycleStatus')
    or ordinary_record ->> 'lifecycleStatus' <> 'active'
    or not (ordinary_record ? 'canceledAt')
    or ordinary_record -> 'canceledAt' <> 'null'::jsonb then
    raise exception 'The ordinary announcement mapper does not satisfy the complete banner lifecycle contract.';
  end if;

  feed := public.get_active_announcement_banners();

  if not exists (
    select 1
    from jsonb_array_elements(feed) item
    where item ->> 'id' = banner_id::text
      and item ->> 'lifecycleStatus' = 'active'
      and item ? 'canceledAt'
  ) then
    raise exception 'The dedicated banner fixture was not returned with the complete lifecycle contract.';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(feed) item
    where item ->> 'id' = announcement_id::text
      and item ->> 'lifecycleStatus' = 'active'
      and item -> 'canceledAt' = 'null'::jsonb
  ) then
    raise exception 'The ordinary announcement fixture was not returned with the complete lifecycle contract.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(feed) item
    where item ->> 'id' in (banner_id::text, announcement_id::text)
      and (
        not (item ? 'lifecycleStatus')
        or not (item ? 'canceledAt')
      )
  ) then
    raise exception 'A mixed employee-facing banner feed item is missing lifecycle fields.';
  end if;
end
$$;

rollback;
