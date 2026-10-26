create index concurrently schedule_assignment_overrides_shift_employee_created_idx
  on public.schedule_assignment_overrides (shift_id, employee_id, created_at desc);
