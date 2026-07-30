begin;

create or replace function private.apply_permission_fragment_repair(
  target_function regprocedure,
  old_fragment text,
  new_fragment text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_definition text;
begin
  select pg_get_functiondef(target_function) into source_definition;

  if source_definition is null then
    raise undefined_function using message = 'Target function for permission repair was not found.';
  end if;

  if position(old_fragment in source_definition) = 0 then
    raise check_violation using message = 'Expected permission repair fragment was not found in ' || target_function::text || '.';
  end if;

  execute replace(source_definition, old_fragment, new_fragment);
end
$$;

select private.apply_permission_fragment_repair(
  'public.get_availability_workspace(date, date)'::regprocedure,
  $old$  privileged boolean := viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin');$old$,
  $new$  privileged boolean := viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin')
    or public.has_effective_permission('availability.manage');$new$
);

select private.apply_permission_fragment_repair(
  'public.get_availability_workspace(date, date)'::regprocedure,
  $old$    'hasMfa', public.has_mfa(),$old$,
  $new$    'hasMfa', public.has_mfa(),
    'permissions', jsonb_build_object(
      'canManage', privileged
    ),$new$
);

select private.apply_permission_fragment_repair(
  'public.get_availability_workspace(date, date)'::regprocedure,
  $old$and employee.role in ('guard', 'dispatcher', 'scheduler', 'supervisor', 'admin')$old$,
  $new$and employee.role in ('guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin')$new$
);

select private.apply_permission_fragment_repair(
  'public.submit_availability_request(uuid, date, date, integer, time, time, text, text)'::regprocedure,
  $old$  direct_approved boolean := actor_role in ('dispatcher', 'scheduler', 'supervisor', 'admin') and public.has_mfa();$old$,
  $new$  direct_approved boolean := public.has_mfa()
    and (
      actor_role in ('dispatcher', 'scheduler', 'supervisor', 'admin')
      or public.has_effective_permission('availability.manage')
    );$new$
);

select private.apply_permission_fragment_repair(
  'public.decide_availability_request(uuid, public.request_status, text)'::regprocedure,
  $old$  if reviewer_id is null or not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to decide availability.';
  end if;$old$,
  $new$  if reviewer_id is null
    or not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('availability.manage')
    ) then
    raise insufficient_privilege using message = 'Availability management permission with MFA is required to decide availability.';
  end if;$new$
);

select private.apply_permission_fragment_repair(
  'public.get_open_opportunities_payload()'::regprocedure,
  $old$  privileged boolean := viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin');$old$,
  $new$  privileged boolean := viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin')
    or public.has_effective_permission('events.manage')
    or public.has_effective_permission('shift_pool.manage')
    or public.has_effective_permission('requests.manage');$new$
);

select private.apply_permission_fragment_repair(
  'public.get_operations_report()'::regprocedure,
  $old$  if not public.is_supervisor_or_admin() then
    raise insufficient_privilege using message = 'Supervisor or Admin access is required to view operations reports.';
  end if;$old$,
  $new$  if not (
    public.is_supervisor_or_admin()
    or public.has_effective_permission('reports.view')
    or public.has_effective_permission('reports.export')
  ) then
    raise insufficient_privilege using message = 'Reports permission is required to view operations reports.';
  end if;$new$
);

select private.apply_permission_fragment_repair(
  'public.get_notification_center()'::regprocedure,
  $old$  if not public.is_supervisor_or_admin() then
    raise insufficient_privilege using message = 'Supervisor or Admin access is required to view notification delivery.';
  end if;$old$,
  $new$  if not (
    public.is_supervisor_or_admin()
    or public.has_effective_permission('notifications.view')
    or public.has_effective_permission('notifications.manage')
    or public.has_effective_permission('announcements.send')
  ) then
    raise insufficient_privilege using message = 'Notification permission is required to view notification delivery.';
  end if;$new$
);

select private.apply_permission_fragment_repair(
  'public.get_notification_center()'::regprocedure,
  $old$    'recent', recent_records$old$,
  $new$    'recent', recent_records,
    'permissions', jsonb_build_object(
      'canManage',
      public.current_app_role() in ('dispatcher', 'scheduler', 'supervisor', 'admin')
      or public.has_effective_permission('notifications.manage')
      or public.has_effective_permission('announcements.send')
    )$new$
);

select private.apply_permission_fragment_repair(
  'public.get_patrol_coverage()'::regprocedure,
  $old$        viewer_role in ('dispatcher', 'supervisor', 'admin')$old$,
  $new$        viewer_role in ('dispatcher', 'supervisor', 'admin')
        or public.has_effective_permission('patrol.manage')$new$
);

select private.apply_permission_fragment_repair(
  'public.get_request_center_payload()'::regprocedure,
  $old$  privileged boolean := viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin');$old$,
  $new$  privileged boolean := viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin')
    or public.has_effective_permission('requests.manage');$new$
);

select private.apply_permission_fragment_repair(
  'public.get_request_center_payload()'::regprocedure,
  $old$    'role', viewer_role,$old$,
  $new$    'role', viewer_role,
    'permissions', jsonb_build_object(
      'canManage', privileged
    ),$new$
);

select private.apply_permission_fragment_repair(
  'public.decide_time_off_request(uuid, public.request_status, text)'::regprocedure,
  $old$  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to decide time off.';
  end if;$old$,
  $new$  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('requests.manage')
    ) then
    raise insufficient_privilege using message = 'Request management permission with MFA is required to decide time off.';
  end if;$new$
);

select private.apply_permission_fragment_repair(
  'public.decide_shift_request(uuid, public.request_status, text)'::regprocedure,
  $old$LANGUAGE plpgsql
 SET search_path TO ''$old$,
  $new$LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''$new$
);

select private.apply_permission_fragment_repair(
  'public.decide_shift_request(uuid, public.request_status, text)'::regprocedure,
  $old$begin
  if target_decision not in ('approved', 'declined') then$old$,
  $new$begin
  if reviewer_id is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to decide shift requests.';
  end if;

  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('requests.manage')
      or public.has_effective_permission('shift_pool.manage')
    ) then
    raise insufficient_privilege using message = 'Request management permission with MFA is required to decide shift requests.';
  end if;

  if target_decision not in ('approved', 'declined') then$new$
);

select private.apply_permission_fragment_repair(
  'public.publish_call_off_opening(uuid, text, text)'::regprocedure,
  $old$LANGUAGE plpgsql
 SET search_path TO ''$old$,
  $new$LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''$new$
);

select private.apply_permission_fragment_repair(
  'public.publish_call_off_opening(uuid, text, text)'::regprocedure,
  $old$begin
  if btrim(coalesce(announcement_title, '')) = '' or char_length(announcement_title) > 160 then$old$,
  $new$begin
  if reviewer_id is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to publish call-off openings.';
  end if;

  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('requests.manage')
      or public.has_effective_permission('shift_pool.manage')
      or public.has_effective_permission('announcements.send')
    ) then
    raise insufficient_privilege using message = 'Request or announcement permission with MFA is required to publish call-off openings.';
  end if;

  if btrim(coalesce(announcement_title, '')) = '' or char_length(announcement_title) > 160 then$new$
);

select private.apply_permission_fragment_repair(
  'public.get_payroll_rules()'::regprocedure,
  $old$  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Operations access with MFA is required for payroll rules.';
  end if;$old$,
  $new$  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('time.view')
      or public.has_effective_permission('time.manage')
      or public.has_effective_permission('time.export_payroll')
    ) then
    raise insufficient_privilege using message = 'Time permission with MFA is required for payroll rules.';
  end if;$new$
);

select private.apply_permission_fragment_repair(
  'public.get_timekeeping_review(date, date)'::regprocedure,
  $old$  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Supervisor or Admin access with MFA is required for time review.';
  end if;$old$,
  $new$  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('time.view')
      or public.has_effective_permission('time.manage')
      or public.has_effective_permission('time.export_payroll')
    ) then
    raise insufficient_privilege using message = 'Time review permission with MFA is required.';
  end if;$new$
);

select private.apply_permission_fragment_repair(
  'public.get_payroll_export_history(integer)'::regprocedure,
  $old$  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Supervisor or Admin access with MFA is required to view payroll export history.';
  end if;$old$,
  $new$  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('time.view')
      or public.has_effective_permission('time.manage')
      or public.has_effective_permission('time.export_payroll')
    ) then
    raise insufficient_privilege using message = 'Time permission with MFA is required to view payroll export history.';
  end if;$new$
);

select private.apply_permission_fragment_repair(
  'public.get_time_maintenance(date, date, uuid)'::regprocedure,
  $old$  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Operations access with MFA is required for time maintenance.';
  end if;$old$,
  $new$  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('time.manage')
    ) then
    raise insufficient_privilege using message = 'Time management permission with MFA is required for time maintenance.';
  end if;$new$
);

select private.apply_permission_fragment_repair(
  'public.supervisor_record_time_event(uuid, public.time_event_kind, timestamptz, uuid, text, text)'::regprocedure,
  $old$  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Operations access with MFA is required to maintain employee time.';
  end if;$old$,
  $new$  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('time.manage')
    ) then
    raise insufficient_privilege using message = 'Time management permission with MFA is required to maintain employee time.';
  end if;$new$
);

select private.apply_permission_fragment_repair(
  'public.supervisor_correct_time_event(uuid, timestamptz, boolean, text)'::regprocedure,
  $old$  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Operations access with MFA is required to maintain employee time.';
  end if;$old$,
  $new$  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('time.manage')
    ) then
    raise insufficient_privilege using message = 'Time management permission with MFA is required to maintain employee time.';
  end if;$new$
);

select private.apply_permission_fragment_repair(
  'public.review_time_event_correction(uuid, boolean, text)'::regprocedure,
  $old$  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Supervisor or Admin access with MFA is required for correction review.';
  end if;$old$,
  $new$  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('time.manage')
    ) then
    raise insufficient_privilege using message = 'Time management permission with MFA is required for correction review.';
  end if;$new$
);

select private.apply_permission_fragment_repair(
  'public.create_payroll_export_batch(date, date, text)'::regprocedure,
  $old$  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Supervisor or Admin access with MFA is required to lock payroll exports.';
  end if;$old$,
  $new$  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('time.export_payroll')
    ) then
    raise insufficient_privilege using message = 'Payroll export permission with MFA is required to lock payroll exports.';
  end if;$new$
);

drop function private.apply_permission_fragment_repair(regprocedure, text, text);

notify pgrst, 'reload schema';

commit;
