-- Inactive recovery template. Recovery must be released as a new forward
-- migration after the normal quality and database rehearsal gates.
begin;

set local lock_timeout = '2s';
set local statement_timeout = '8s';

drop function if exists public.get_timekeeping_review_v2(date, date);
drop function if exists private.enrich_timekeeping_review_work_types(jsonb);

notify pgrst, 'reload schema';

commit;
