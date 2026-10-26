-- Read-only preview evidence. Run after the projection migration on an
-- isolated production-sized branch. Save the JSON plans with the release
-- evidence; do not run EXPLAIN ANALYZE on any mutating statement.
begin read only;

set local statement_timeout = '30s';
set local lock_timeout = '250ms';

-- All-employee effective-time seed. This must use the effective_at-leading
-- projection index rather than reading public.time_events history.
explain (analyze, buffers, wal, settings, format json)
select projection.event_id
from private.timekeeping_effective_event_projection projection
where projection.effective_at >= timestamptz '2026-10-04 06:00:00+00'
  and projection.effective_at < timestamptz '2026-10-18 06:00:00+00';

-- Per-employee close-boundary lookup used to complete an occurrence. Replace
-- the employee subquery only if the preview has no punch in the range.
explain (analyze, buffers, wal, settings, format json)
select projection.effective_at
from private.timekeeping_effective_event_projection projection
where projection.employee_id = (
    select candidate.employee_id
    from private.timekeeping_effective_event_projection candidate
    where candidate.effective_at >= timestamptz '2026-10-04 06:00:00+00'
      and candidate.effective_at < timestamptz '2026-10-18 06:00:00+00'
    order by candidate.effective_at, candidate.event_id
    limit 1
  )
  and not projection.voided
  and projection.effective_kind = 'clock_out'
  and projection.effective_at < timestamptz '2026-10-04 06:00:00+00'
order by projection.effective_at desc, projection.recorded_at desc,
  projection.event_id desc
limit 1;

-- Full bounded resolver. Function Scan hides internal nodes in some Postgres
-- plan displays, so preserve this timing beside the two predicate plans above.
explain (analyze, buffers, wal, settings, format json)
select count(*)
from private.get_effective_time_events_bounded(
  null,
  timestamptz '2026-10-04 06:00:00+00',
  timestamptz '2026-10-18 06:00:00+00'
);

rollback;
