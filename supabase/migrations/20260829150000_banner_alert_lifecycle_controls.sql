-- Banner alerts use an auditable lifecycle. Expiration is authoritative, while
-- cancellation and removal preserve the operational record.

alter table public.announcement_banners
  add column if not exists canceled_at timestamptz,
  add column if not exists canceled_by uuid references public.employees(id) on delete set null,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.employees(id) on delete set null;

create index if not exists announcement_banners_lifecycle_idx
  on public.announcement_banners (deleted_at, canceled_at, active, starts_at desc, expires_at);

create or replace function private.announcement_banner_visible_to_current_user(banner public.announcement_banners)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  actor_role public.app_role := public.current_app_role();
begin
  if banner.deleted_at is not null
    or banner.canceled_at is not null
    or not banner.active
    or banner.starts_at > clock_timestamp()
    or (banner.expires_at is not null and banner.expires_at <= clock_timestamp()) then
    return false;
  end if;

  if actor_id is null or actor_role is null then
    return false;
  end if;

  return banner.audience = 'all'
    or (banner.audience = 'supervisors' and actor_role in ('supervisor', 'admin'))
    or (banner.audience = 'roles' and actor_role = any(banner.audience_roles));
end
$$;

create or replace function private.announcement_banner_record(banner public.announcement_banners)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', banner.id,
    'title', banner.title,
    'message', banner.message,
    'tone', banner.tone,
    'ctaLabel', banner.cta_label,
    'ctaHref', banner.cta_href,
    'audience', banner.audience,
    'audienceRoles', coalesce(to_jsonb(banner.audience_roles), '[]'::jsonb),
    'active', banner.active
      and banner.deleted_at is null
      and banner.canceled_at is null
      and banner.starts_at <= clock_timestamp()
      and (banner.expires_at is null or banner.expires_at > clock_timestamp()),
    'lifecycleStatus', case
      when banner.deleted_at is not null then 'deleted'
      when banner.canceled_at is not null then 'canceled'
      when banner.expires_at is not null and banner.expires_at <= clock_timestamp() then 'expired'
      when banner.starts_at > clock_timestamp() then 'scheduled'
      when not banner.active then 'inactive'
      else 'active'
    end,
    'startsAt', banner.starts_at,
    'expiresAt', banner.expires_at,
    'canceledAt', banner.canceled_at,
    'createdAt', banner.created_at,
    'updatedAt', banner.updated_at
  )
$$;

create or replace function public.get_announcement_banner_manager()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_announcement_banner_manager();

  return jsonb_build_object(
    'activeBanner', (
      select private.announcement_banner_record(banner)
      from public.announcement_banners banner
      where banner.deleted_at is null
        and banner.canceled_at is null
        and banner.active
        and banner.starts_at <= clock_timestamp()
        and (banner.expires_at is null or banner.expires_at > clock_timestamp())
      order by
        case banner.tone when 'urgent' then 1 when 'warning' then 2 when 'info' then 3 when 'success' then 4 else 5 end,
        banner.starts_at desc,
        banner.updated_at desc
      limit 1
    ),
    'activeBanners', (
      select coalesce(jsonb_agg(private.announcement_banner_record(banner) order by banner.starts_at desc, banner.updated_at desc), '[]'::jsonb)
      from (
        select candidate.*
        from public.announcement_banners candidate
        where candidate.deleted_at is null
          and candidate.canceled_at is null
          and candidate.active
          and candidate.starts_at <= clock_timestamp()
          and (candidate.expires_at is null or candidate.expires_at > clock_timestamp())
        order by candidate.starts_at desc, candidate.updated_at desc
        limit 10
      ) banner
    ),
    'banners', (
      select coalesce(jsonb_agg(private.announcement_banner_record(banner) order by banner.starts_at asc, banner.updated_at desc), '[]'::jsonb)
      from (
        select candidate.*
        from public.announcement_banners candidate
        where candidate.deleted_at is null
          and candidate.canceled_at is null
          and candidate.active
          and (candidate.expires_at is null or candidate.expires_at > clock_timestamp())
        order by candidate.starts_at asc, candidate.updated_at desc
        limit 10
      ) banner
    ),
    'archivedBanners', (
      select coalesce(jsonb_agg(private.announcement_banner_record(banner) order by coalesce(banner.canceled_at, banner.expires_at, banner.updated_at) desc), '[]'::jsonb)
      from (
        select candidate.*
        from public.announcement_banners candidate
        where candidate.deleted_at is null
          and (
            candidate.canceled_at is not null
            or not candidate.active
            or (candidate.expires_at is not null and candidate.expires_at <= clock_timestamp())
          )
        order by coalesce(candidate.canceled_at, candidate.expires_at, candidate.updated_at) desc
        limit 10
      ) banner
    )
  );
end
$$;

create or replace function public.upsert_announcement_banner(
  target_banner_id uuid default null,
  target_title text default null,
  target_message text default null,
  target_tone text default 'info',
  target_cta_label text default null,
  target_cta_href text default null,
  target_active boolean default true,
  target_starts_at timestamptz default null,
  target_expires_at timestamptz default null,
  target_audience text default 'all',
  target_audience_roles public.app_role[] default array[]::public.app_role[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_announcement_banner_manager();
  clean_title text := left(btrim(coalesce(target_title, '')), 120);
  clean_message text := left(btrim(coalesce(target_message, '')), 420);
  clean_tone text := coalesce(nullif(btrim(coalesce(target_tone, '')), ''), 'info');
  clean_cta_label text := nullif(left(btrim(coalesce(target_cta_label, '')), 48), '');
  clean_cta_href text := nullif(btrim(coalesce(target_cta_href, '')), '');
  clean_starts_at timestamptz := coalesce(target_starts_at, clock_timestamp());
  clean_audience text := coalesce(nullif(btrim(coalesce(target_audience, '')), ''), 'all');
  clean_audience_roles public.app_role[] := coalesce(target_audience_roles, array[]::public.app_role[]);
  saved_banner public.announcement_banners%rowtype;
begin
  if clean_title = '' then raise check_violation using message = 'Banner title is required.'; end if;
  if clean_message = '' then raise check_violation using message = 'Banner message is required.'; end if;
  if clean_tone not in ('info', 'success', 'warning', 'urgent') then raise check_violation using message = 'Choose a supported banner tone.'; end if;
  if clean_audience not in ('all', 'supervisors', 'roles') then raise check_violation using message = 'Choose a supported banner audience.'; end if;

  if clean_audience = 'all' then
    clean_audience_roles := array[]::public.app_role[];
  elsif clean_audience = 'supervisors' then
    clean_audience_roles := array['supervisor', 'admin']::public.app_role[];
  else
    select coalesce(array_agg(distinct selected_role order by selected_role), array[]::public.app_role[])
      into clean_audience_roles from unnest(clean_audience_roles) selected_role;
    if cardinality(clean_audience_roles) = 0 then raise check_violation using message = 'Choose at least one role for this banner audience.'; end if;
  end if;

  if clean_cta_href is not null and clean_cta_href !~ '^/[A-Za-z0-9/_?=&.#%-]*$' then raise check_violation using message = 'Banner action links must stay inside SygShift.'; end if;
  if clean_cta_href is not null and clean_cta_label is null then raise check_violation using message = 'Add a banner action label or remove the action link.'; end if;
  if target_expires_at is not null and target_expires_at <= clean_starts_at then raise check_violation using message = 'Banner expiration must be after the start time.'; end if;

  if target_banner_id is null then
    insert into public.announcement_banners (
      title, message, tone, cta_label, cta_href, audience, audience_roles, active,
      starts_at, expires_at, created_by, updated_by
    ) values (
      clean_title, clean_message, clean_tone, clean_cta_label, clean_cta_href,
      clean_audience, clean_audience_roles, coalesce(target_active, true),
      clean_starts_at, target_expires_at, actor_id, actor_id
    ) returning * into saved_banner;
  else
    update public.announcement_banners banner set
      title = clean_title,
      message = clean_message,
      tone = clean_tone,
      cta_label = clean_cta_label,
      cta_href = clean_cta_href,
      audience = clean_audience,
      audience_roles = clean_audience_roles,
      active = coalesce(target_active, true),
      starts_at = clean_starts_at,
      expires_at = target_expires_at,
      canceled_at = null,
      canceled_by = null,
      updated_by = actor_id,
      updated_at = clock_timestamp()
    where banner.id = target_banner_id and banner.deleted_at is null
    returning * into saved_banner;
    if not found then raise no_data_found using message = 'Announcement banner was not found.'; end if;
  end if;

  return public.get_announcement_banner_manager();
end
$$;

create or replace function public.change_announcement_banner_lifecycle(
  target_banner_id uuid,
  target_action text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_announcement_banner_manager();
  clean_action text := lower(btrim(coalesce(target_action, '')));
begin
  if clean_action not in ('cancel', 'delete') then
    raise check_violation using message = 'Choose cancel or delete.';
  end if;

  if clean_action = 'cancel' then
    update public.announcement_banners banner set
      active = false,
      canceled_at = clock_timestamp(),
      canceled_by = actor_id,
      updated_by = actor_id,
      updated_at = clock_timestamp()
    where banner.id = target_banner_id
      and banner.deleted_at is null
      and banner.canceled_at is null;
  else
    update public.announcement_banners banner set
      active = false,
      deleted_at = clock_timestamp(),
      deleted_by = actor_id,
      updated_by = actor_id,
      updated_at = clock_timestamp()
    where banner.id = target_banner_id
      and banner.deleted_at is null;
  end if;

  if not found then
    raise no_data_found using message = 'Announcement banner was not found or has already been updated.';
  end if;

  return public.get_announcement_banner_manager();
end
$$;

drop trigger if exists announcement_banners_audit on public.announcement_banners;
create trigger announcement_banners_audit
after insert or update or delete on public.announcement_banners
for each row execute function private.write_audit_event();

revoke all on function public.change_announcement_banner_lifecycle(uuid, text) from public, anon;
grant execute on function public.change_announcement_banner_lifecycle(uuid, text) to authenticated;

revoke all on function private.announcement_banner_visible_to_current_user(public.announcement_banners) from public, anon, authenticated;
revoke all on function private.announcement_banner_record(public.announcement_banners) from public, anon, authenticated;
