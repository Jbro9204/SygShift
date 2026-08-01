begin;

create or replace function private.announcement_visible_to_current_user(announcement public.announcements)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  actor_role public.app_role := public.current_app_role();
  visible_from timestamptz := coalesce(announcement.published_at, announcement.created_at);
  visible_until timestamptz := coalesce(
    announcement.expires_at,
    coalesce(announcement.published_at, announcement.created_at) + interval '14 days'
  );
  target_roles public.app_role[] := coalesce(announcement.recipient_roles, array[]::public.app_role[]);
begin
  if actor_id is null or announcement.published_at is null then
    return false;
  end if;

  if visible_from > clock_timestamp() or visible_until <= clock_timestamp() then
    return false;
  end if;

  if cardinality(target_roles) > 0 and actor_role <> all(target_roles) then
    return false;
  end if;

  if coalesce(announcement.requires_armed, false)
    and not public.has_valid_credential(actor_id, 'armed_guard', current_date) then
    return false;
  end if;

  return true;
end
$$;

create or replace function private.announcement_workspace_record(announcement public.announcements)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', announcement.id,
    'title', left(btrim(announcement.title), 120),
    'message', left(regexp_replace(btrim(announcement.body), '\s+', ' ', 'g'), 420),
    'tone', case announcement.kind::text
      when 'open_shift' then 'warning'
      when 'overtime' then 'warning'
      when 'event' then 'info'
      else 'info'
    end,
    'ctaLabel', case announcement.kind::text
      when 'open_shift' then 'Open Events & Openings'
      when 'overtime' then 'Open Events & Openings'
      when 'event' then 'Open Events & Openings'
      else 'Open SygShift'
    end,
    'ctaHref', case announcement.kind::text
      when 'open_shift' then '/events'
      when 'overtime' then '/events'
      when 'event' then '/events'
      else '/'
    end,
    'audience', 'roles',
    'audienceRoles', coalesce(to_jsonb(announcement.recipient_roles), '[]'::jsonb),
    'active', true,
    'startsAt', coalesce(announcement.published_at, announcement.created_at),
    'expiresAt', coalesce(
      announcement.expires_at,
      coalesce(announcement.published_at, announcement.created_at) + interval '14 days'
    ),
    'createdAt', announcement.created_at,
    'updatedAt', announcement.updated_at
  )
$$;

create or replace function public.get_active_announcement_banners()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.current_employee_id() is null then
    return '[]'::jsonb;
  end if;

  return (
    with workspace_items as (
      select
        private.announcement_banner_record(candidate) as record,
        candidate.tone as tone,
        candidate.starts_at as starts_at,
        candidate.updated_at as updated_at
      from public.announcement_banners candidate
      where private.announcement_banner_visible_to_current_user(candidate)

      union all

      select
        private.announcement_workspace_record(announcement) as record,
        case announcement.kind::text
          when 'open_shift' then 'warning'
          when 'overtime' then 'warning'
          when 'event' then 'info'
          else 'info'
        end as tone,
        coalesce(announcement.published_at, announcement.created_at) as starts_at,
        announcement.updated_at as updated_at
      from public.announcements announcement
      where private.announcement_visible_to_current_user(announcement)
        and coalesce(announcement.template_key, '') <> 'welcome_to_sygshift'
    )
    select coalesce(jsonb_agg(
      item.record
      order by
        case item.tone
          when 'urgent' then 1
          when 'warning' then 2
          when 'info' then 3
          when 'success' then 4
          else 5
        end,
        item.starts_at desc,
        item.updated_at desc
    ), '[]'::jsonb)
    from (
      select *
      from workspace_items
      order by
        case tone
          when 'urgent' then 1
          when 'warning' then 2
          when 'info' then 3
          when 'success' then 4
          else 5
        end,
        starts_at desc,
        updated_at desc
      limit 10
    ) item
  );
end
$$;

create or replace function public.get_active_announcement_banner()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  active_record jsonb;
begin
  if private.current_employee_id() is null then
    return null;
  end if;

  with workspace_items as (
    select
      private.announcement_banner_record(candidate) as record,
      candidate.tone as tone,
      candidate.starts_at as starts_at,
      candidate.updated_at as updated_at
    from public.announcement_banners candidate
    where private.announcement_banner_visible_to_current_user(candidate)

    union all

    select
      private.announcement_workspace_record(announcement) as record,
      case announcement.kind::text
        when 'open_shift' then 'warning'
        when 'overtime' then 'warning'
        when 'event' then 'info'
        else 'info'
      end as tone,
      coalesce(announcement.published_at, announcement.created_at) as starts_at,
      announcement.updated_at as updated_at
    from public.announcements announcement
    where private.announcement_visible_to_current_user(announcement)
      and coalesce(announcement.template_key, '') <> 'welcome_to_sygshift'
  )
  select item.record
  into active_record
  from workspace_items item
  order by
    case item.tone
      when 'urgent' then 1
      when 'warning' then 2
      when 'info' then 3
      when 'success' then 4
      else 5
    end,
    item.starts_at desc,
    item.updated_at desc
  limit 1;

  return active_record;
end
$$;

revoke all on function private.announcement_visible_to_current_user(public.announcements) from public, anon, authenticated;
revoke all on function private.announcement_workspace_record(public.announcements) from public, anon, authenticated;
revoke all on function public.get_active_announcement_banner() from public, anon;
revoke all on function public.get_active_announcement_banners() from public, anon;

grant execute on function public.get_active_announcement_banner() to authenticated;
grant execute on function public.get_active_announcement_banners() to authenticated;

commit;
