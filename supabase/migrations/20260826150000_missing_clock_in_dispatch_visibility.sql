-- A missed scheduled start and an unusually long active clock-in are separate
-- attendance risks. Missing starts must reach dispatch while the shift can still
-- be covered; active clock-ins retain the independent fourteen-hour UI guardrail.
insert into private.system_settings (
  setting_key,
  setting_value,
  description,
  updated_at
)
values (
  'timekeeping.missing_clock_in_grace_minutes',
  '15'::jsonb,
  'Minutes after a published scheduled shift starts before an unresolved missing clock-in exception is created for dispatch review.',
  clock_timestamp()
)
on conflict (setting_key) do update
set
  setting_value = excluded.setting_value,
  description = excluded.description,
  updated_at = excluded.updated_at;
