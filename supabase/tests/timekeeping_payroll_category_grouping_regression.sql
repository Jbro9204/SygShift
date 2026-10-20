-- Matching semantics only; no employee records or database functions are changed.
begin;
set local statement_timeout='8s';
create temp table category_grouping_fixture(case_name text primary key,rows jsonb,category_map jsonb,expected_ids jsonb) on commit drop;
insert into category_grouping_fixture values
('priority',$rows$[{"employeeId":"employee-a","payrollOccurrenceKey":"exact","eventTimeline":[{"id":"event-a"}]}]$rows$::jsonb,$map$[{"id":"fallback","employeeId":"employee-a","payrollOccurrenceKey":"other","eventIds":["event-a"]},{"id":"exact","employeeId":"employee-a","payrollOccurrenceKey":"exact","eventIds":[]}]$map$::jsonb,$expected$["exact"]$expected$::jsonb),
('fallback',$rows$[{"employeeId":"employee-a","payrollOccurrenceKey":"missing","eventTimeline":[{"id":"event-a"}]}]$rows$::jsonb,$map$[{"id":"fallback","employeeId":"employee-a","payrollOccurrenceKey":"other","eventIds":["event-a"]}]$map$::jsonb,$expected$["fallback"]$expected$::jsonb),
('employee_boundary',$rows$[{"employeeId":"employee-a","payrollOccurrenceKey":"exact","eventTimeline":[{"id":"event-a"}]}]$rows$::jsonb,$map$[{"id":"other-employee","employeeId":"employee-b","payrollOccurrenceKey":"exact","eventIds":["event-a"]}]$map$::jsonb,$expected$[null]$expected$::jsonb),
('missing_keys',$rows$[{"employeeId":"employee-a","eventTimeline":[]}]$rows$::jsonb,$map$[{"id":"not-matched","employeeId":"employee-a","eventIds":[]}]$map$::jsonb,$expected$[null]$expected$::jsonb),
('null_event_id',$rows$[{"employeeId":"employee-a","eventTimeline":[{}]}]$rows$::jsonb,$map$[{"id":"null-id-match","employeeId":"employee-a","eventIds":[null]}]$map$::jsonb,$expected$["null-id-match"]$expected$::jsonb),
('empty_map',$rows$[{"employeeId":"employee-a","payrollOccurrenceKey":"exact"}]$rows$::jsonb,$map$[]$map$::jsonb,$expected$[null]$expected$::jsonb),
('null_map',$rows$[{"employeeId":"employee-a","payrollOccurrenceKey":"exact"}]$rows$::jsonb,null,$expected$[null]$expected$::jsonb),
('same_priority_order',$rows$[{"employeeId":"employee-a","payrollOccurrenceKey":"exact"}]$rows$::jsonb,$map$[{"id":"first","employeeId":"employee-a","payrollOccurrenceKey":"exact"},{"id":"second","employeeId":"employee-a","payrollOccurrenceKey":"exact"}]$map$::jsonb,$expected$["first"]$expected$::jsonb),
('empty_key',$rows$[{"employeeId":"employee-a","payrollOccurrenceKey":"","eventTimeline":[{"id":"event-a"}]}]$rows$::jsonb,$map$[{"id":"invalid-empty-key","employeeId":"employee-a","payrollOccurrenceKey":"","eventIds":[]},{"id":"event-fallback","employeeId":"employee-a","payrollOccurrenceKey":"fallback","eventIds":["event-a"]}]$map$::jsonb,$expected$["event-fallback"]$expected$::jsonb),
('row_order',$rows$[{"employeeId":"employee-b","payrollOccurrenceKey":"b"},{"employeeId":"employee-a","payrollOccurrenceKey":"a"},{"employeeId":"employee-c","payrollOccurrenceKey":"c"}]$rows$::jsonb,$map$[{"id":"a","employeeId":"employee-a","payrollOccurrenceKey":"a"},{"id":"b","employeeId":"employee-b","payrollOccurrenceKey":"b"}]$map$::jsonb,$expected$["b","a",null]$expected$::jsonb);
create temp table category_grouping_proof on commit drop as
with employee_category_map as materialized (
  select fixture.case_name,map_item.value ->> 'employeeId' as employee_id,
    jsonb_agg(map_item.value order by map_item.ordinality) as items
  from category_grouping_fixture fixture
  cross join lateral jsonb_array_elements(fixture.category_map) with ordinality map_item(value,ordinality)
  group by fixture.case_name,map_item.value ->> 'employeeId'
), original as (
  select fixture.case_name,jsonb_agg(jsonb_build_object('row',row_item.ordinality,'picked',category_item.value) order by row_item.ordinality) as payload,
    jsonb_agg(category_item.value -> 'id' order by row_item.ordinality) as picked_ids
  from category_grouping_fixture fixture
  cross join lateral jsonb_array_elements(fixture.rows) with ordinality row_item(value,ordinality)
  left join lateral (select map_item.value from jsonb_array_elements(fixture.category_map) map_item(value)
    where map_item.value ->> 'employeeId' = row_item.value ->> 'employeeId'
      and ((nullif(row_item.value ->> 'payrollOccurrenceKey','') is not null
        and map_item.value ->> 'payrollOccurrenceKey' = row_item.value ->> 'payrollOccurrenceKey')
      or exists(select 1 from jsonb_array_elements(coalesce(row_item.value -> 'eventTimeline','[]'::jsonb)) timeline(event)
        where coalesce(map_item.value -> 'eventIds','[]'::jsonb) @> jsonb_build_array(timeline.event ->> 'id')))
    order by case when map_item.value ->> 'payrollOccurrenceKey' = row_item.value ->> 'payrollOccurrenceKey' then 0 else 1 end limit 1) category_item on true
  group by fixture.case_name
), candidate as (
  select fixture.case_name,jsonb_agg(jsonb_build_object('row',row_item.ordinality,'picked',category_item.value) order by row_item.ordinality) as payload
  from category_grouping_fixture fixture
  cross join lateral jsonb_array_elements(fixture.rows) with ordinality row_item(value,ordinality)
  left join employee_category_map employee_map on employee_map.case_name=fixture.case_name and employee_map.employee_id=row_item.value ->> 'employeeId'
  left join lateral (select map_item.value from jsonb_array_elements(employee_map.items) map_item(value)
    where map_item.value ->> 'employeeId' = row_item.value ->> 'employeeId'
      and ((nullif(row_item.value ->> 'payrollOccurrenceKey','') is not null
        and map_item.value ->> 'payrollOccurrenceKey' = row_item.value ->> 'payrollOccurrenceKey')
      or exists(select 1 from jsonb_array_elements(coalesce(row_item.value -> 'eventTimeline','[]'::jsonb)) timeline(event)
        where coalesce(map_item.value -> 'eventIds','[]'::jsonb) @> jsonb_build_array(timeline.event ->> 'id')))
    order by case when map_item.value ->> 'payrollOccurrenceKey' = row_item.value ->> 'payrollOccurrenceKey' then 0 else 1 end limit 1) category_item on true
  group by fixture.case_name
)
select fixture.case_name,original.payload=candidate.payload as equal,
  original.picked_ids=fixture.expected_ids as expected
from category_grouping_fixture fixture join original using(case_name) join candidate using(case_name);
do $assert$ begin if (select count(*) from category_grouping_proof)<>10 or exists(select 1 from category_grouping_proof where equal is distinct from true or expected is distinct from true) then raise exception 'Category grouping changed matching, priority or ordered row output';end if;end $assert$;
select * from category_grouping_proof order by case_name;
rollback;
