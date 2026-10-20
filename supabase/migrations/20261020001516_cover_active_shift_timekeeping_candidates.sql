-- Reserved by Supabase CLI; staged candidate pending independent release review.
-- Execute this single statement outside any explicit or implicit transaction block.
-- The reviewed release protocol enforces lock_timeout=2s and statement_timeout=30s
-- using native connection startup settings before this file is executed.
-- This 30s DDL budget does not change the authenticated review RPC timeout (8s).
CREATE INDEX CONCURRENTLY shifts_timekeeping_candidate_cover_idx
ON public.shifts (id) INCLUDE (starts_at, ends_at, schedule_id)
WHERE canceled_at IS NULL;
