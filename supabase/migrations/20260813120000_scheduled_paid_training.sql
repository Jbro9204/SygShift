begin;

-- Ordinary scheduled work remains the default internal classification. The
-- employee-facing distinction is now limited to shifts explicitly marked as
-- paid training by a scheduler.
update private.payroll_pay_codes
set label = case work_type
      when 'post' then 'Worked Time'
      when 'training' then 'Paid Training'
    end,
    updated_at = clock_timestamp()
where work_type in ('post', 'training');

-- Pay-code confirmation was a global payroll setup step. Classification now
-- comes from each scheduled shift, so authenticated clients must not alter the
-- company-wide mapping from the payroll workflow.
revoke execute on function public.get_work_type_configuration() from authenticated;
revoke execute on function public.confirm_work_type_configuration(text, text) from authenticated;

comment on table private.payroll_pay_codes is
  'Internal payroll classification metadata. Ordinary worked time is the default; paid training is selected on an individual scheduled shift.';

comment on column public.shifts.work_type is
  'Scheduling-owned time category. post is the compatibility value for ordinary worked time; training is paid training explicitly selected by a scheduler.';

comment on column public.time_events.work_type is
  'Original time category inherited from the scheduled shift when the punch is created. Ordinary worked time is the default; paid training requires an explicitly marked schedule block.';

comment on function private.enrich_payroll_export_work_type() is
  'Enriches immutable payroll export rows with the schedule-derived time category and rejects conflicting worked/training classifications at the database boundary.';

notify pgrst, 'reload schema';

commit;
