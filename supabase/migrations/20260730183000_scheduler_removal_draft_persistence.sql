begin;

do $$
begin
  if to_regprocedure('private.remove_schedule_draft_shift_unmerged(uuid,text)') is null
    and to_regprocedure('public.remove_schedule_draft_shift(uuid,text)') is not null
  then
    alter function public.remove_schedule_draft_shift(uuid, text) set schema private;
    alter function private.remove_schedule_draft_shift(uuid, text) rename to remove_schedule_draft_shift_unmerged;
  end if;
end;
$$;

create or replace function public.remove_schedule_draft_shift(
  target_shift_id uuid,
  removal_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result jsonb;
  result_schedule_id uuid;
  result_week date;
begin
  result := private.remove_schedule_draft_shift_unmerged(
    target_shift_id,
    removal_note
  );

  if result is null then
    return null;
  end if;

  result_schedule_id := (result->>'id')::uuid;
  result_week := (result->>'week_starts_on')::date;

  perform private.normalize_schedule_duplicate_shift_blocks(result_schedule_id);

  return public.get_weekly_schedule_payload(result_week);
end;
$$;

revoke all on function public.remove_schedule_draft_shift(uuid, text) from public, anon;
grant execute on function public.remove_schedule_draft_shift(uuid, text) to authenticated;

comment on function public.remove_schedule_draft_shift(uuid, text) is
  'Saves shift removals to the active draft, normalizes duplicate/open-state bookkeeping, and returns the refreshed weekly schedule payload.';

notify pgrst, 'reload schema';

commit;
