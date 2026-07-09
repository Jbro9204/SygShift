set search_path = '';

alter type public.app_role add value if not exists 'scheduler' after 'dispatcher';
