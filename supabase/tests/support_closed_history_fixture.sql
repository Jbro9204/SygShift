-- PRE-migration fixture. Run only inside the same rolled-back rehearsal.
insert into public.support_tickets(id,ticket_number,submitted_by,subject,category,subcategory,description,route_permission,status,resolved_at,closed_at,created_at,updated_at)
overriding system value
select 'ffffeeee-0000-4000-8000-000000000001',-99901,id,'Historical closure fixture','technical','Other','A historical record used only inside a rolled-back migration rehearsal.','admin.maintenance.manage','closed','2026-08-02Z'::timestamptz,'2026-08-03Z'::timestamptz,'2026-08-01Z'::timestamptz,'2026-08-03Z'::timestamptz from public.employees where status='active' and role='admin' limit 1;
insert into public.support_ticket_events(ticket_id,actor_id,event_type,detail)
select id,submitted_by,'ticket_updated','{"status":"closed"}' from public.support_tickets where id='ffffeeee-0000-4000-8000-000000000001';
insert into public.support_ticket_messages(ticket_id,author_id,body)
select id,submitted_by,'The original reply must remain unchanged.' from public.support_tickets where id='ffffeeee-0000-4000-8000-000000000001';
