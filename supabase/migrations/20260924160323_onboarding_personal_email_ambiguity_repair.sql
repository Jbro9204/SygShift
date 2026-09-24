begin;
set local lock_timeout = '5s';

create temporary table onboarding_email_repair_baseline on commit drop as
select
  (select count(*) from public.employees) employee_count,
  (select count(*) from private.employee_accounts) account_count,
  (select count(*) from private.hr_onboarding_cases) case_count,
  (select count(*) from private.hr_onboarding_tasks) task_count;

do $repair$
declare
  function_definition text;
  repaired_definition text;
begin
  select pg_get_functiondef('public.service_hr_onboarding_create_prehire(uuid,jsonb,text)'::regprocedure)
  into function_definition;

  repaired_definition := function_definition;
  repaired_definition := replace(repaired_definition, 'personal_email text := lower', 'personal_email_value text := lower');
  repaired_definition := replace(repaired_definition, 'if personal_email = ''''', 'if personal_email_value = ''''');
  repaired_definition := replace(repaired_definition, ' or personal_email !~', ' or personal_email_value !~');
  repaired_definition := replace(repaired_definition, 'if personal_email ~*', 'if personal_email_value ~*');
  repaired_definition := replace(repaired_definition, '=personal_email) then', '=personal_email_value) then');
  repaired_definition := replace(repaired_definition, 'values(created_employee_id,personal_email,mobile_phone);', 'values(created_employee_id,personal_email_value,mobile_phone);');

  if repaired_definition = function_definition
    or position('personal_email_value text := lower' in repaired_definition) = 0
    or position('lower(contact.personal_email)=personal_email_value' in repaired_definition) = 0
    or position('values(created_employee_id,personal_email_value,mobile_phone)' in repaired_definition) = 0 then
    raise exception 'The onboarding personal-email ambiguity could not be repaired safely.';
  end if;

  execute repaired_definition;
end
$repair$;

do $$
declare baseline onboarding_email_repair_baseline%rowtype;
begin
  select * into strict baseline from onboarding_email_repair_baseline;
  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.account_count <> (select count(*) from private.employee_accounts)
    or baseline.case_count <> (select count(*) from private.hr_onboarding_cases)
    or baseline.task_count <> (select count(*) from private.hr_onboarding_tasks) then
    raise exception 'The onboarding function repair changed production employee or onboarding data.';
  end if;
end
$$;

notify pgrst, 'reload schema';
commit;
