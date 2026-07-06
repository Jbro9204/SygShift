update public.announcement_templates
set
  body_pattern = replace(body_pattern, 'https://sygshift.sygilant.workers.dev', 'https://app.sygilant.us'),
  description = 'Approved rollout message introducing SygShift, the official site link, testing expectations, and the correct support contact.',
  updated_at = clock_timestamp()
where template_key = 'welcome_to_sygshift';
