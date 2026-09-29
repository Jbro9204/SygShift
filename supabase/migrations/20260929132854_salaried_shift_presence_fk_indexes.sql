begin;

-- Cover the remaining foreign-key paths used by employee retention checks and
-- administrative audit lookups. The assignment and event-employee paths are
-- already covered by indexes in the foundation migration.
create index salaried_shift_presence_requests_employee_idx
  on private.salaried_shift_presence_requests(employee_id);

create index salaried_shift_presence_requests_actor_idx
  on private.salaried_shift_presence_requests(actor_employee_id);

create index salaried_shift_presence_events_actor_idx
  on private.salaried_shift_presence_events(actor_employee_id);

commit;
