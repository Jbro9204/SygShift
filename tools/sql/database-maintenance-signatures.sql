-- Read-only, aggregate-only maintenance monitor. No addresses, messages, or employee IDs leave the database.
begin read only;
set local application_name='overnight_maintenance_signature_monitor';
set local statement_timeout='8s';
set local lock_timeout='250ms';
with classified as (
 select started_at as observed_at,
  case when error_text like '%temporarily read-only for scheduled maintenance.%' then 'expected_maintenance_write_block'
    when error_text like '%statement timeout%' then 'timekeeping_statement_timeout'
    when status='failed' then 'timekeeping_other_failure'
    else 'timekeeping_'||status end as signature,
  case when error_text like '%temporarily read-only for scheduled maintenance.%' then false else status='failed' end as actionable
 from private.timekeeping_job_runs where started_at>=clock_timestamp()-interval '24 hours'
 union all
 select attempted_at,
  case when delivery_status='suppressed_blocked_domain' then 'suppressed_blocked_domain'
    when delivery_status='suppressed_provider_recipient' or starts_with(failure_detail,'E_RECIPIENT_SUPPRESSED:') then 'suppressed_provider_recipient'
    when delivery_status='failed' then 'legacy_or_unclassified_email_failure'
    else 'email_'||delivery_status end,
  delivery_status='failed' and not coalesce(starts_with(failure_detail,'E_RECIPIENT_SUPPRESSED:'),false)
 from private.email_delivery_audit where attempted_at>=clock_timestamp()-interval '24 hours'
)
select signature,actionable,count(*) as occurrences,min(observed_at) as first_seen,max(observed_at) as last_seen
from classified group by signature,actionable order by actionable desc,occurrences desc,signature;
rollback;
