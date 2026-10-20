-- Inactive forward recovery reserved by CLI; activate only after review/gates.
-- Standalone online DDL; the exact guarded recovery protocol checks the installed
-- original ledger/source and owned index before dropping only this index.
DROP INDEX CONCURRENTLY public.shifts_timekeeping_candidate_cover_idx;
