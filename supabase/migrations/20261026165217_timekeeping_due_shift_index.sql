-- The minute automation begins from shifts whose scheduled end is inside a
-- seven-day due window. The existing timekeeping cover index is ID-leading,
-- so Postgres must scan every active shift before applying the end-time range.
-- Build the range-leading index online; the following migration refuses to
-- install the bounded function unless this exact index is present.
create index concurrently if not exists shifts_timekeeping_due_end_idx
  on public.shifts (ends_at, id)
  include (starts_at, schedule_id)
  where canceled_at is null;
