begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $migration$
declare
  function_signature constant regprocedure :=
    'public.mutate_sygtasks(text,jsonb,uuid,integer)'::regprocedure;
  function_definition text;
  repaired_definition text;
  expected_occurrences integer;
  actual_occurrences integer;
  scope_patch record;
begin
  select pg_get_functiondef(function_signature)
  into function_definition;

  if function_definition is null then
    raise undefined_function using
      message = 'The SygTasks mutation function is unavailable.';
  end if;

  actual_occurrences :=
    (length(function_definition) - length(replace(
      function_definition,
      '#variable_conflict use_column',
      ''
    ))) / length('#variable_conflict use_column');

  if actual_occurrences <> 1 then
    raise check_violation using
      message = 'The SygTasks mutation conflict directive did not match the expected release.';
  end if;

  repaired_definition := function_definition;

  for scope_patch in
    select *
    from (
      values
        (
          'membership.board_id = board_id',
          'membership.board_id = sygtasks_mutation.board_id',
          3
        ),
        (
          'task.board_id = board_id',
          'task.board_id = sygtasks_mutation.board_id',
          1
        ),
        (
          'assignee.task_id = task_id',
          'assignee.task_id = sygtasks_mutation.task_id',
          4
        ),
        (
          'watcher.task_id = task_id',
          'watcher.task_id = sygtasks_mutation.task_id',
          4
        ),
        (
          'assignee.task_id=task_id',
          'assignee.task_id=sygtasks_mutation.task_id',
          1
        ),
        (
          'watcher.task_id=task_id',
          'watcher.task_id=sygtasks_mutation.task_id',
          1
        ),
        (
          'label.board_id=board_id',
          'label.board_id=sygtasks_mutation.board_id',
          1
        ),
        (
          'task_label.task_id=task_id',
          'task_label.task_id=sygtasks_mutation.task_id',
          1
        ),
        (
          'task_label.label_id=label_id',
          'task_label.label_id=sygtasks_mutation.label_id',
          1
        ),
        (
          'item.task_id=task_id',
          'item.task_id=sygtasks_mutation.task_id',
          1
        ),
        (
          'comment.task_id=task_id',
          'comment.task_id=sygtasks_mutation.task_id',
          1
        ),
        (
          'dependency_task.board_id=board_id',
          'dependency_task.board_id=sygtasks_mutation.board_id',
          1
        ),
        (
          'dependency.task_id=task_id',
          'dependency.task_id=sygtasks_mutation.task_id',
          3
        )
    ) as patch(search_text, replacement_text, occurrence_count)
  loop
    expected_occurrences := scope_patch.occurrence_count;
    actual_occurrences :=
      (length(repaired_definition) - length(replace(
        repaired_definition,
        scope_patch.search_text,
        ''
      ))) / length(scope_patch.search_text);

    if actual_occurrences <> expected_occurrences then
      raise check_violation using
        message = format(
          'The SygTasks parent-scope repair expected %s occurrence(s) of %s but found %s.',
          expected_occurrences,
          scope_patch.search_text,
          actual_occurrences
        );
    end if;

    repaired_definition := replace(
      repaired_definition,
      scope_patch.search_text,
      scope_patch.replacement_text
    );
  end loop;

  repaired_definition := replace(
    repaired_definition,
    '#variable_conflict use_column',
    E'#variable_conflict error\n<<sygtasks_mutation>>'
  );

  execute repaired_definition;

  select pg_get_functiondef(function_signature)
  into repaired_definition;

  if position('#variable_conflict use_column' in repaired_definition) > 0
     or position('#variable_conflict error' in repaired_definition) = 0
     or position('<<sygtasks_mutation>>' in repaired_definition) = 0
  then
    raise check_violation using
      message = 'The SygTasks mutation function did not retain the explicit parent-scope guard.';
  end if;
end
$migration$;

revoke all on function public.mutate_sygtasks(text,jsonb,uuid,integer)
  from public, anon;
grant execute on function public.mutate_sygtasks(text,jsonb,uuid,integer)
  to authenticated;

comment on function public.mutate_sygtasks(text,jsonb,uuid,integer) is
  'Performs bounded SygTasks mutations with explicit board/task parent scoping, idempotency, authorization, notifications, and append-only audit history.';

commit;
