begin;

create table if not exists public.announcement_banners (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  message text not null,
  tone text not null default 'info',
  cta_label text,
  cta_href text,
  active boolean not null default true,
  starts_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz,
  created_by uuid references public.employees(id) on delete set null,
  updated_by uuid references public.employees(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint announcement_banners_title_present check (btrim(title) <> '' and char_length(title) <= 120),
  constraint announcement_banners_message_present check (btrim(message) <> '' and char_length(message) <= 420),
  constraint announcement_banners_tone_check check (tone in ('info', 'success', 'warning', 'urgent')),
  constraint announcement_banners_cta_label_length check (cta_label is null or char_length(cta_label) <= 48),
  constraint announcement_banners_cta_href_internal check (cta_href is null or cta_href ~ '^/[A-Za-z0-9/_?=&.#%-]*$'),
  constraint announcement_banners_date_order check (expires_at is null or expires_at > starts_at)
);

create index if not exists announcement_banners_active_idx
  on public.announcement_banners(active, starts_at desc, updated_at desc);

alter table public.announcement_banners enable row level security;

insert into public.permission_catalog (
  code,
  category,
  name,
  description,
  risk_level,
  requires_mfa,
  locked,
  active
) values
  (
    'announcements.banner.manage',
    'Announcements',
    'Manage announcement banner',
    'Create, edit, activate, and deactivate the in-app announcement banner.',
    'sensitive',
    true,
    true,
    true
  )
on conflict (code) do update set
  category = excluded.category,
  name = excluded.name,
  description = excluded.description,
  risk_level = excluded.risk_level,
  requires_mfa = excluded.requires_mfa,
  locked = excluded.locked,
  active = excluded.active,
  updated_at = now();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select access_role.id, 'announcements.banner.manage', true
from public.access_roles access_role
where access_role.code in ('system_admin', 'system_supervisor')
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = now();

drop policy if exists announcement_banners_active_read on public.announcement_banners;
create policy announcement_banners_active_read on public.announcement_banners
for select to authenticated
using (
  public.current_employee_id() is not null
  and active
  and starts_at <= clock_timestamp()
  and (expires_at is null or expires_at > clock_timestamp())
);

drop policy if exists announcement_banners_manager_write on public.announcement_banners;
create policy announcement_banners_manager_write on public.announcement_banners
for all to authenticated
using (public.has_effective_permission('announcements.banner.manage'))
with check (public.has_effective_permission('announcements.banner.manage'));

grant select on public.announcement_banners to authenticated;
grant insert, update on public.announcement_banners to authenticated;

create or replace function private.has_effective_permission_without_mfa(required_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from unnest(private.employee_effective_permissions(private.current_employee_id())) permission_code
    join public.permission_catalog catalog on catalog.code = permission_code
    where catalog.active
      and permission_code = required_permission
  )
$$;

create or replace function private.require_announcement_banner_manager()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_effective_permission('announcements.banner.manage') then
    raise insufficient_privilege using message = 'Announcement banner management permission is required.';
  end if;

  return actor_id;
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
    'active', banner.active,
    'startsAt', banner.starts_at,
    'expiresAt', banner.expires_at,
    'createdAt', banner.created_at,
    'updatedAt', banner.updated_at
  )
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

  select *
  into banner
  from public.announcement_banners candidate
  where candidate.active
    and candidate.starts_at <= clock_timestamp()
    and (candidate.expires_at is null or candidate.expires_at > clock_timestamp())
  order by candidate.starts_at desc, candidate.updated_at desc
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
    'activeBanner', public.get_active_announcement_banner(),
    'banners', (
      select coalesce(jsonb_agg(private.announcement_banner_record(banner) order by banner.active desc, banner.starts_at desc, banner.updated_at desc), '[]'::jsonb)
      from (
        select *
        from public.announcement_banners
        order by active desc, starts_at desc, updated_at desc
        limit 12
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
  target_expires_at timestamptz default null
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

create or replace function public.preview_announcement_template(
  target_template_key text,
  target_fields jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  template public.announcement_templates%rowtype;
  clean_fields jsonb := coalesce(target_fields, '{}'::jsonb);
  subject text;
  body text;
  armed_required boolean;
begin
  if not private.has_effective_permission_without_mfa('announcements.send') then
    raise insufficient_privilege using message = 'Announcement send permission is required.';
  end if;

  select * into template
  from public.announcement_templates
  where template_key = target_template_key
    and is_active
    and template_key <> 'welcome_to_sygshift';

  if not found then
    raise check_violation using message = 'Choose an approved announcement template.';
  end if;

  perform private.validate_template_fields(template, clean_fields);

  subject := private.render_announcement_template(template.subject_pattern, clean_fields);
  body := private.render_announcement_template(template.body_pattern, clean_fields);
  armed_required := private.template_requires_armed(template, clean_fields);

  return jsonb_build_object(
    'templateKey', template.template_key,
    'title', subject,
    'body', body,
    'kind', template.kind,
    'recipientRoles', template.recipient_roles,
    'requiresArmed', armed_required,
    'recipientCount', private.count_announcement_recipients(template.recipient_roles, armed_required)
  );
end
$$;

create or replace function public.publish_templated_announcement(
  target_template_key text,
  target_fields jsonb,
  target_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  publisher_id uuid := private.current_employee_id();
  template public.announcement_templates%rowtype;
  clean_fields jsonb := coalesce(target_fields, '{}'::jsonb);
  subject text;
  body text;
  armed_required boolean;
  recipient_count integer;
  announcement_id uuid;
begin
  if publisher_id is null or not public.has_effective_permission('announcements.send') then
    raise insufficient_privilege using message = 'Announcement send permission and MFA are required.';
  end if;

  select * into template
  from public.announcement_templates
  where template_key = target_template_key
    and is_active
    and template_key <> 'welcome_to_sygshift';

  if not found then
    raise check_violation using message = 'Choose an approved announcement template.';
  end if;

  perform private.validate_template_fields(template, clean_fields);

  subject := private.render_announcement_template(template.subject_pattern, clean_fields);
  body := private.render_announcement_template(template.body_pattern, clean_fields);
  armed_required := private.template_requires_armed(template, clean_fields);
  recipient_count := private.count_announcement_recipients(template.recipient_roles, armed_required);

  if recipient_count <= 0 then
    raise check_violation using message = 'No eligible email recipients match this announcement.';
  end if;

  if char_length(subject) > 160 then
    raise check_violation using message = 'The generated announcement title is too long.';
  end if;

  if char_length(body) > 4000 then
    raise check_violation using message = 'The generated announcement body is too long.';
  end if;

  insert into public.announcements (
    kind,
    title,
    body,
    published_at,
    expires_at,
    created_by,
    template_key,
    template_fields,
    recipient_roles,
    requires_armed
  ) values (
    template.kind,
    subject,
    body,
    clock_timestamp(),
    target_expires_at,
    publisher_id,
    template.template_key,
    clean_fields,
    template.recipient_roles,
    armed_required
  )
  returning id into announcement_id;

  return jsonb_build_object(
    'id', announcement_id,
    'templateKey', template.template_key,
    'title', subject,
    'body', body,
    'kind', template.kind,
    'recipientRoles', template.recipient_roles,
    'requiresArmed', armed_required,
    'recipientCount', recipient_count
  );
end
$$;

revoke all on table public.announcement_banners from public, anon;
revoke all on function private.has_effective_permission_without_mfa(text) from public, anon, authenticated;
revoke all on function private.require_announcement_banner_manager() from public, anon, authenticated;
revoke all on function private.announcement_banner_record(public.announcement_banners) from public, anon, authenticated;
revoke all on function public.get_active_announcement_banner() from public, anon;
revoke all on function public.get_announcement_banner_manager() from public, anon;
revoke all on function public.upsert_announcement_banner(uuid, text, text, text, text, text, boolean, timestamptz, timestamptz) from public, anon;
revoke all on function public.get_announcement_composer() from public, anon;
revoke all on function public.preview_announcement_template(text, jsonb) from public, anon;
revoke all on function public.publish_templated_announcement(text, jsonb, timestamptz) from public, anon;

grant select on public.announcement_banners to authenticated;
grant insert, update on public.announcement_banners to authenticated;
grant execute on function public.get_active_announcement_banner() to authenticated;
grant execute on function public.get_announcement_banner_manager() to authenticated;
grant execute on function public.upsert_announcement_banner(uuid, text, text, text, text, text, boolean, timestamptz, timestamptz) to authenticated;
grant execute on function public.get_announcement_composer() to authenticated;
grant execute on function public.preview_announcement_template(text, jsonb) to authenticated;
grant execute on function public.publish_templated_announcement(text, jsonb, timestamptz) to authenticated;

commit;
