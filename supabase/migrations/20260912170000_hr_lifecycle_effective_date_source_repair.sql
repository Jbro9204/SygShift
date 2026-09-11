begin;

-- Guided separations write their approved effective date to the same immutable
-- authorization history as the earlier HRIS workflow. The guided workflow uses
-- an explicit source name so the record remains truthful and auditable.
alter table private.hr_stage2_effective_date_authorizations
  drop constraint if exists hr_stage2_effective_dates_source;

alter table private.hr_stage2_effective_date_authorizations
  add constraint hr_stage2_effective_dates_source check (
    source_type in (
      'hr_export',
      'employee_file',
      'verified_hr_record',
      'verified_manual',
      'offboarding_case'
    )
  ) not valid;

alter table private.hr_stage2_effective_date_authorizations
  validate constraint hr_stage2_effective_dates_source;

commit;
