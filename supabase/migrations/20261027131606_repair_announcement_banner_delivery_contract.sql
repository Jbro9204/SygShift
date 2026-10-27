begin;

-- Ordinary published announcements share the employee-facing banner feed with
-- dedicated announcement_banners. Keep both producers on the same strict JSON
-- contract so one valid ordinary announcement cannot invalidate the full feed.
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
    'lifecycleStatus', 'active',
    'startsAt', coalesce(announcement.published_at, announcement.created_at),
    'expiresAt', coalesce(
      announcement.expires_at,
      coalesce(announcement.published_at, announcement.created_at) + interval '14 days'
    ),
    'canceledAt', null,
    'createdAt', announcement.created_at,
    'updatedAt', announcement.updated_at
  )
$$;

revoke all on function private.announcement_workspace_record(public.announcements)
  from public, anon, authenticated;

comment on function private.announcement_workspace_record(public.announcements) is
  'Maps active ordinary announcements onto the complete employee-facing banner JSON contract.';

commit;
