begin;

set local lock_timeout = '2s';
set local statement_timeout = '8s';

-- Enrich only the exact occurrences already returned by the authoritative
-- review. The legacy work-type endpoint scans the time-event history and then
-- tries to reconstruct occurrence identity from employee/shift/date. That is
-- both expensive and less precise than the canonical event timeline already
-- present on each review row.
create or replace function private.enrich_timekeeping_review_work_types(
  source_payload jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with row_source as materialized (
    select
      row_item.ordinality::integer as row_number,
      row_item.value as row_value
    from jsonb_array_elements(coalesce(source_payload -> 'rows', '[]'::jsonb))
      with ordinality as row_item(value, ordinality)
  ), requested_events as materialized (
    select
      source.row_number,
      event.id as time_event_id,
      coalesce(correction.work_type, event.work_type, 'post') as work_type
    from row_source source
    cross join lateral jsonb_array_elements(
      coalesce(source.row_value -> 'eventTimeline', '[]'::jsonb)
    ) timeline(event_value)
    join public.time_events event
      on event.id = nullif(timeline.event_value ->> 'id', '')::uuid
    left join lateral (
      select item.work_type
      from public.time_event_work_type_corrections item
      where item.time_event_id = event.id
      order by item.corrected_at desc, item.id desc
      limit 1
    ) correction on true
    where source.row_value ->> 'rowKind' = 'time_event'
  ), row_classification as materialized (
    select
      requested.row_number,
      case
        when count(distinct requested.work_type) = 1 then min(requested.work_type)
        else 'post'
      end as work_type,
      count(distinct requested.work_type) > 1 as mixed_work_types
    from requested_events requested
    group by requested.row_number
  ), rebuilt_rows as (
    select
      source.row_number,
      case
        when source.row_value ->> 'rowKind' <> 'time_event' then source.row_value
        else source.row_value || jsonb_build_object(
          'workType', coalesce(classification.work_type, 'post'),
          'workTypeLabel', coalesce(pay_code.label, 'Worked Time'),
          'payCode', coalesce(pay_code.pay_code, 'REG'),
          'workTypePaid', coalesce(pay_code.paid, true),
          'workTypeOvertimeEligible', coalesce(pay_code.overtime_eligible, true),
          'workTypeRateSource', coalesce(pay_code.rate_source, 'employee_base_rate'),
          'mixedWorkTypes', coalesce(classification.mixed_work_types, false)
        )
      end as row_value
    from row_source source
    left join row_classification classification
      on classification.row_number = source.row_number
    left join private.payroll_pay_codes pay_code
      on pay_code.work_type = coalesce(classification.work_type, 'post')
  )
  select source_payload || jsonb_build_object(
    'rows', coalesce(
      (select jsonb_agg(rebuilt.row_value order by rebuilt.row_number)
       from rebuilt_rows rebuilt),
      '[]'::jsonb
    ),
    'reviewContractVersion', 'timekeeping-review-v2'
  )
$$;

revoke all on function private.enrich_timekeeping_review_work_types(jsonb)
  from public, anon, authenticated;

-- One browser request now produces the complete review contract. The mature
-- public review remains the only calculator for punches, breaks, corrections,
-- payroll-week slicing, overtime and payroll categories. This wrapper adds
-- work classifications by the exact event IDs in that result; it does not
-- perform a second history scan or create a competing calculation path.
create or replace function public.get_timekeeping_review_v2(
  target_from_date date,
  target_through_date date
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.has_mfa() then
    raise insufficient_privilege using message =
      'MFA verification is required to load payroll review details.';
  end if;

  return private.enrich_timekeeping_review_work_types(
    public.get_timekeeping_review(target_from_date, target_through_date)
  );
end
$$;

revoke all on function public.get_timekeeping_review_v2(date, date)
  from public, anon;
grant execute on function public.get_timekeeping_review_v2(date, date)
  to authenticated;

comment on function private.enrich_timekeeping_review_work_types(jsonb) is
  'Adds work classifications by the exact canonical review event IDs without scanning unrelated punch history.';
comment on function public.get_timekeeping_review_v2(date, date) is
  'Returns the complete authoritative payroll review, category and work-type contract through one MFA-verified bounded request.';

notify pgrst, 'reload schema';

commit;
