-- Apply only after 20261026165219 has restored the prior function. This
-- removes the online performance index without touching data.
drop index concurrently if exists public.shifts_timekeeping_due_end_idx;
