-- Revision-aware clock-in detection is keyed by both employee and immutable
-- shift ID. Existing indexes lead with either employee+time or shift+time,
-- forcing repeated employee-history scans when checking equivalent schedule
-- revisions. This index supports an exact employee+occurrence join while the
-- effective correction function remains authoritative for kind/void state.
create index concurrently if not exists time_events_employee_shift_recorded_idx
  on public.time_events (employee_id, shift_id, recorded_at desc, id)
  where shift_id is not null;
