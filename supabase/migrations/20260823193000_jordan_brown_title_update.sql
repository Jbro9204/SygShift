begin;

update public.employees
set job_title = 'IT and Business Development Engineer'
where lower(username) = 'jbrown'
   or (lower(first_name) = 'jordan' and lower(last_name) = 'brown');

update public.announcement_templates
set body_pattern = replace(
      body_pattern,
      'Chief Systems and Automation Officer',
      'IT and Business Development Engineer'
    ),
    updated_at = clock_timestamp()
where body_pattern like '%Chief Systems and Automation Officer%';

notify pgrst, 'reload schema';

commit;
