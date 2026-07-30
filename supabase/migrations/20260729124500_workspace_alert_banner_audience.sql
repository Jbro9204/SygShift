begin;

alter table public.announcement_banners
  add column if not exists audience text not null default 'all',
  add column if not exists audience_roles public.app_role[] not null default array[]::public.app_role[];

update public.announcement_banners
set audience = coalesce(nullif(audience, ''), 'all'),
    audience_roles = coalesce(audience_roles, array[]::public.app_role[])
where audience is null
   or audience = ''
   or audience_roles is null;

alter table public.announcement_banners
  drop constraint if exists announcement_banners_audience_check,
  drop constraint if exists announcement_banners_audience_roles_check;

alter table public.announcement_banners
  add constraint announcement_banners_audience_check
    check (audience in ('all', 'supervisors', 'roles')),
  add constraint announcement_banners_audience_roles_check
    check (audience <> 'roles' or cardinality(audience_roles) > 0);

create index if not exists announcement_banners_audience_idx
  on public.announcement_banners(audience, active, starts_at desc, updated_at desc);

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
  if actor_id is null then
    return false;
  end if;

  if not banner.active
    or banner.starts_at > clock_timestamp()
    or (banner.expires_at is not null and banner.expires_at <= clock_timestamp()) then
    return false;
  end if;

  if banner.audience = 'all' then
    return true;
  end if;

  if banner.audience = 'supervisors' then
    return actor_role in ('supervisor', 'admin');
  end if;

  if banner.audience = 'roles' then
    return actor_role = any(coalesce(banner.audience_roles, array[]::public.app_role[]));
  end if;

  return false;
end
$$;

drop policy if exists announcement_banners_active_read on public.announcement_banners;
create policy announcement_banners_active_read on public.announcement_banners
for select to authenticated
using (private.announcement_banner_visible_to_current_user(announcement_banners));

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
    'active', banner.active,
    'startsAt', banner.starts_at,
    'expiresAt', banner.expires_at,
    'createdAt', banner.created_at,
    'updatedAt', banner.updated_at
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
    select coalesce(jsonb_agg(
      private.announcement_banner_record(banner)
      order by
        case banner.tone
          when 'urgent' then 1
          when 'warning' then 2
          when 'info' then 3
          when 'success' then 4
          else 5
        end,
        banner.starts_at desc,
        banner.updated_at desc
    ), '[]'::jsonb)
    from (
      select candidate.*
      from public.announcement_banners candidate
      where private.announcement_banner_visible_to_current_user(candidate)
      order by
        case candidate.tone
          when 'urgent' then 1
          when 'warning' then 2
          when 'info' then 3
          when 'success' then 4
          else 5
        end,
        candidate.starts_at desc,
        candidate.updated_at desc
      limit 10
    ) banner
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
  banner public.announcement_banners%rowtype;
begin
  if private.current_employee_id() is null then
    return null;
  end if;

  select candidate.*
  into banner
  from public.announcement_banners candidate
  where private.announcement_banner_visible_to_current_user(candidate)
  order by
    case candidate.tone
      when 'urgent' then 1
      when 'warning' then 2
      when 'info' then 3
      when 'success' then 4
      else 5
    end,
    candidate.starts_at desc,
    candidate.updated_at desc
  limit 1;

  if not found then
    return null;
  end if;

  return private.announcement_banner_record(banner);
end
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
      where banner.active
        and banner.starts_at <= clock_timestamp()
        and (banner.expires_at is null or banner.expires_at > clock_timestamp())
      order by
        case banner.tone
          when 'urgent' then 1
          when 'warning' then 2
          when 'info' then 3
          when 'success' then 4
          else 5
        end,
        banner.starts_at desc,
        banner.updated_at desc
      limit 1
    ),
    'activeBanners', (
      select coalesce(jsonb_agg(
        private.announcement_banner_record(banner)
        order by
          case banner.tone
            when 'urgent' then 1
            when 'warning' then 2
            when 'info' then 3
            when 'success' then 4
            else 5
          end,
          banner.starts_at desc,
          banner.updated_at desc
      ), '[]'::jsonb)
      from (
        select candidate.*
        from public.announcement_banners candidate
        where candidate.active
          and candidate.starts_at <= clock_timestamp()
          and (candidate.expires_at is null or candidate.expires_at > clock_timestamp())
        order by
          case candidate.tone
            when 'urgent' then 1
            when 'warning' then 2
            when 'info' then 3
            when 'success' then 4
            else 5
          end,
          candidate.starts_at desc,
          candidate.updated_at desc
        limit 10
      ) banner
    ),
    'banners', (
      select coalesce(jsonb_agg(private.announcement_banner_record(banner) order by banner.active desc, banner.starts_at desc, banner.updated_at desc), '[]'::jsonb)
      from (
        select *
        from public.announcement_banners
        order by active desc, starts_at desc, updated_at desc
        limit 20
      ) banner
    )
  );
end
$$;

drop function if exists public.upsert_announcement_banner(uuid, text, text, text, text, text, boolean, timestamptz, timestamptz);
drop function if exists public.upsert_announcement_banner(uuid, text, text, text, text, text, boolean, timestamptz, timestamptz, text, public.app_role[]);

create function public.upsert_announcement_banner(
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
  if clean_title = '' then
    raise check_violation using message = 'Banner title is required.';
  end if;

  if clean_message = '' then
    raise check_violation using message = 'Banner message is required.';
  end if;

  if clean_tone not in ('info', 'success', 'warning', 'urgent') then
    raise check_violation using message = 'Choose a supported banner tone.';
  end if;

  if clean_audience not in ('all', 'supervisors', 'roles') then
    raise check_violation using message = 'Choose a supported banner audience.';
  end if;

  if clean_audience = 'all' then
    clean_audience_roles := array[]::public.app_role[];
  elsif clean_audience = 'supervisors' then
    clean_audience_roles := array['supervisor', 'admin']::public.app_role[];
  else
    select coalesce(array_agg(distinct selected_role order by selected_role), array[]::public.app_role[])
    into clean_audience_roles
    from unnest(clean_audience_roles) selected_role;

    if cardinality(clean_audience_roles) = 0 then
      raise check_violation using message = 'Choose at least one role for this banner audience.';
    end if;
  end if;

  if clean_cta_href is not null and clean_cta_href !~ '^/[A-Za-z0-9/_?=&.#%-]*$' then
    raise check_violation using message = 'Banner action links must stay inside SygShift.';
  end if;

  if clean_cta_href is not null and clean_cta_label is null then
    raise check_violation using message = 'Add a banner action label or remove the action link.';
  end if;

  if target_expires_at is not null and target_expires_at <= clean_starts_at then
    raise check_violation using message = 'Banner expiration must be after the start time.';
  end if;

  if target_banner_id is null then
    insert into public.announcement_banners (
      title,
      message,
      tone,
      cta_label,
      cta_href,
      audience,
      audience_roles,
      active,
      starts_at,
      expires_at,
      created_by,
      updated_by
    ) values (
      clean_title,
      clean_message,
      clean_tone,
      clean_cta_label,
      clean_cta_href,
      clean_audience,
      clean_audience_roles,
      coalesce(target_active, true),
      clean_starts_at,
      target_expires_at,
      actor_id,
      actor_id
    )
    returning * into saved_banner;
  else
    update public.announcement_banners banner
    set
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
      updated_by = actor_id,
      updated_at = clock_timestamp()
    where banner.id = target_banner_id
    returning * into saved_banner;

    if not found then
      raise no_data_found using message = 'Announcement banner was not found.';
    end if;
  end if;

  return public.get_announcement_banner_manager();
end
$$;

create or replace function public.get_announcement_composer()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  can_view boolean := private.has_effective_permission_without_mfa('announcements.view')
    or private.has_effective_permission_without_mfa('announcements.send')
    or private.has_effective_permission_without_mfa('announcements.banner.manage');
  can_send boolean := private.has_effective_permission_without_mfa('announcements.send');
  can_manage_banner boolean := private.has_effective_permission_without_mfa('announcements.banner.manage');
begin
  if private.current_employee_id() is null or not can_view then
    raise insufficient_privilege using message = 'Announcements permission is required.';
  end if;

  return jsonb_build_object(
    'role', public.current_app_role(),
    'hasMfa', public.has_mfa(),
    'canSend', can_send,
    'canManageBanner', can_manage_banner,
    'activeBanner', public.get_active_announcement_banner(),
    'activeBanners', public.get_active_announcement_banners(),
    'templates', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'key', template.template_key,
        'name', template.name,
        'description', template.description,
        'kind', template.kind,
        'requiredFields', template.required_fields,
        'recipientRoles', template.recipient_roles,
        'displayOrder', template.display_order
      ) order by template.display_order, template.name), '[]'::jsonb)
      from public.announcement_templates template
      where template.is_active
        and template.template_key <> 'welcome_to_sygshift'
        and can_send
    ),
    'recentAnnouncements', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', announcement.id,
        'templateKey', announcement.template_key,
        'title', announcement.title,
        'kind', announcement.kind,
        'publishedAt', announcement.published_at,
        'expiresAt', announcement.expires_at,
        'recipientRoles', announcement.recipient_roles,
        'requiresArmed', announcement.requires_armed,
        'createdBy', coalesce(author.preferred_name, author.first_name) || ' ' || author.last_name
      ) order by announcement.created_at desc), '[]'::jsonb)
      from (
        select *
        from public.announcements
        where coalesce(template_key, '') <> 'welcome_to_sygshift'
        order by created_at desc
        limit 12
      ) announcement
      join public.employees author on author.id = announcement.created_by
    )
  );
end
$$;

revoke all on function private.announcement_banner_visible_to_current_user(public.announcement_banners) from public, anon, authenticated;
revoke all on function private.announcement_banner_record(public.announcement_banners) from public, anon, authenticated;
revoke all on function public.get_active_announcement_banner() from public, anon;
revoke all on function public.get_active_announcement_banners() from public, anon;
revoke all on function public.get_announcement_banner_manager() from public, anon;
revoke all on function public.upsert_announcement_banner(uuid, text, text, text, text, text, boolean, timestamptz, timestamptz, text, public.app_role[]) from public, anon;
revoke all on function public.get_announcement_composer() from public, anon;

grant execute on function public.get_active_announcement_banner() to authenticated;
grant execute on function public.get_active_announcement_banners() to authenticated;
grant execute on function public.get_announcement_banner_manager() to authenticated;
grant execute on function public.upsert_announcement_banner(uuid, text, text, text, text, text, boolean, timestamptz, timestamptz, text, public.app_role[]) to authenticated;
grant execute on function public.get_announcement_composer() to authenticated;

commit;
