set session_replication_role = replica;

update public.shifts
set notes = replace(notes, 'Assignment import skipped by system guardrail: resolved to Directory employee', 'Assignment import cleanup result: resolved to Directory employee')
where notes like '%System cleanup:%'
  and notes like '%Assignment import skipped by system guardrail: resolved to Directory employee%';

update public.shifts
set notes = replace(notes, 'Assignment import skipped by system guardrail: label is an operational note, not an employee name.', 'Assignment import cleanup result: label is an operational note, not an employee name.')
where notes like '%System cleanup:%'
  and notes like '%Assignment import skipped by system guardrail: label is an operational note%';

update public.shifts
set notes = replace(notes, 'Assignment import skipped by system guardrail: archived after the shift ended; no active staffing action remains.', 'Assignment import cleanup result: archived after the shift ended; no active staffing action remains.')
where notes like '%System cleanup:%'
  and notes like '%Assignment import skipped by system guardrail: archived after the shift ended%';

set session_replication_role = origin;
