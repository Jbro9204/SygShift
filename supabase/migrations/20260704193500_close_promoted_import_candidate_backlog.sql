-- Close the raw import candidate backlog after operational promotion.
-- Current promoted 2026 schedule candidates are accepted; historical parser rows
-- and raw site variants are superseded by the canonical production records.

update private.import_candidates candidate
set
  review_status = case
    when candidate.kind = 'weekly_schedule'
      and (candidate.payload ->> 'weekStartsOn')::date between date '2026-06-28' and date '2026-08-09'
      then 'accepted'
    when candidate.kind = 'shift'
      and (candidate.payload ->> 'localDate')::date between date '2026-06-28' and date '2026-08-15'
      then 'accepted'
    else 'superseded'
  end,
  reviewed_by = coalesce(
    candidate.reviewed_by,
    (select employee.id from public.employees employee where employee.username = 'jbrown' limit 1)
  ),
  reviewed_at = coalesce(candidate.reviewed_at, clock_timestamp()),
  review_note = coalesce(
    candidate.review_note,
    case
      when candidate.kind in ('weekly_schedule', 'shift')
        and coalesce((candidate.payload ->> 'localDate')::date, (candidate.payload ->> 'weekStartsOn')::date)
          between date '2026-06-28' and date '2026-08-15'
        then 'Accepted by SygShift data-quality cleanup: promoted into the current operational schedule.'
      else 'Superseded by SygShift data-quality cleanup: historical or raw parser candidate not needed after canonical operational records were created.'
    end
  ),
  updated_at = clock_timestamp()
where candidate.review_status = 'pending'
  and candidate.kind in ('weekly_schedule', 'shift', 'site')
  and exists (
    select 1
    from public.schedules schedule
    where schedule.status = 'published'
  );
