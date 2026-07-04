create or replace function public.get_imported_schedule_preview(target_week_starts_on date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.get_bible_schedule_preview(target_week_starts_on)
$$;

revoke all on function public.get_imported_schedule_preview(date) from public, anon;
grant execute on function public.get_imported_schedule_preview(date) to authenticated;
