-- Inactive forward-recovery template. Reserve a fresh migration version and
-- verify the installed migration source, index owner, key order, validity, and
-- usage evidence before activating this standalone online DDL.
drop index concurrently public.schedule_assignment_overrides_shift_employee_created_idx;
