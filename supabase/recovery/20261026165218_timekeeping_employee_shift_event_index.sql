-- Apply only after 20261026165219 has restored the prior function. Keeping
-- this index until then prevents the repaired occurrence joins from running
-- without their reviewed access path.
drop index concurrently if exists public.time_events_employee_shift_recorded_idx;
