-- Read-only observation. This does not pause, activate, drain, replay, or send.
-- changed_at must be the operator's finite legacy-pause start. Recent claims
-- stay in this cohort until terminal even after the lease duration elapses.
-- HTTP/manual callers are not duration-bounded: independently confirm that no
-- old manual processor remains in flight. Do not infer this from lease expiry.
begin read only;
set local statement_timeout='5s';
set local lock_timeout='1s';
select guarded_enabled,legacy_pause_until,changed_at from private.operational_email_delivery_control;
with jobs as (
  select case when message_type='automatic_clock_out_employee' then 'timekeeping' when message_type='time_off_decision' then 'time_off' else 'general' end lane,
    attempted_at,attempt_count,delivered_at,failed_at,interval '20 minutes' lease
  from private.notification_outbox where message_type in('automatic_clock_out_employee','time_off_decision','announcement_published','call_off_supervisor_alert','document_signature_required','schedule_published')
  union all select 'support',attempted_at,attempt_count,delivered_at,failed_at,interval '15 minutes' from public.support_ticket_notifications
  union all select 'employee',attempted_at,attempt_count,delivered_at,failed_at,interval '20 minutes' from public.employee_notification_email_deliveries
)
select lane,
  count(*) filter(where attempted_at is not null and attempt_count between 1 and 4 and delivered_at is null and failed_at is null) as unfinished_attempted_reclaimable_all_ages,
  count(*) filter(where attempt_count=0 and delivered_at is null and failed_at is null) as unclaimed_pending,
  count(*) filter(where attempted_at>=control.changed_at-lease and delivered_at is null and failed_at is null) as unfinished_pause_window_claims,
  count(*) filter(where attempted_at>=control.changed_at) as claims_since_pause,
  count(*) filter(where attempted_at<control.changed_at-lease and attempt_count>=5 and delivered_at is null and failed_at is null) as historical_exhausted_unfinished,
  max(attempted_at) as latest_attempt_at
from jobs cross join private.operational_email_delivery_control control
group by lane order by lane;
rollback;
