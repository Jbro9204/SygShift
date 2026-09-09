/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(join(
  process.cwd(),
  'supabase',
  'migrations',
  '20260910120000_sygtasks_parent_scope_repair.sql',
), 'utf8')

const regression = readFileSync(join(
  process.cwd(),
  'supabase',
  'tests',
  'sygtasks_parent_scope_regression.sql',
), 'utf8')

const scopedIdentifiers = [
  ['membership.board_id = board_id', 'membership.board_id = sygtasks_mutation.board_id', 3],
  ['task.board_id = board_id', 'task.board_id = sygtasks_mutation.board_id', 1],
  ['assignee.task_id = task_id', 'assignee.task_id = sygtasks_mutation.task_id', 4],
  ['watcher.task_id = task_id', 'watcher.task_id = sygtasks_mutation.task_id', 4],
  ['assignee.task_id=task_id', 'assignee.task_id=sygtasks_mutation.task_id', 1],
  ['watcher.task_id=task_id', 'watcher.task_id=sygtasks_mutation.task_id', 1],
  ['label.board_id=board_id', 'label.board_id=sygtasks_mutation.board_id', 1],
  ['task_label.task_id=task_id', 'task_label.task_id=sygtasks_mutation.task_id', 1],
  ['task_label.label_id=label_id', 'task_label.label_id=sygtasks_mutation.label_id', 1],
  ['item.task_id=task_id', 'item.task_id=sygtasks_mutation.task_id', 1],
  ['comment.task_id=task_id', 'comment.task_id=sygtasks_mutation.task_id', 1],
  ['dependency_task.board_id=board_id', 'dependency_task.board_id=sygtasks_mutation.board_id', 1],
  ['dependency.task_id=task_id', 'dependency.task_id=sygtasks_mutation.task_id', 3],
] as const

describe('SygTasks parent-scope repair', () => {
  it('fails closed unless every known ambiguous parent reference is repaired', () => {
    expect(migration).toContain("'public.mutate_sygtasks(text,jsonb,uuid,integer)'::regprocedure")
    expect(migration).toContain("'#variable_conflict use_column'")
    expect(migration).toContain("E'#variable_conflict error\\n<<sygtasks_mutation>>'")
    expect(migration).toContain('execute repaired_definition')

    expect(scopedIdentifiers.reduce((total, [, , count]) => total + count, 0)).toBe(23)
    for (const [searchText, replacementText, count] of scopedIdentifiers) {
      expect(migration).toContain(`'${searchText}'`)
      expect(migration).toContain(`'${replacementText}'`)
      expect(migration).toMatch(new RegExp(`'${replacementText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',\\s*${count}`))
    }

    expect(migration).toContain('actual_occurrences <> expected_occurrences')
    expect(migration).toContain('revoke all on function public.mutate_sygtasks(text,jsonb,uuid,integer)')
    expect(migration).toContain('grant execute on function public.mutate_sygtasks(text,jsonb,uuid,integer)')
  })

  it('keeps the live regression rollback-only and covers cross-parent mutations', () => {
    expect(regression.match(/^begin;$/gm)).toHaveLength(1)
    expect(regression.match(/^commit;$/gm)).toBeNull()
    expect(regression.match(/^rollback;$/gm)).toHaveLength(1)

    for (const action of [
      'add_board_member',
      'remove_board_member',
      'assign_task',
      'unassign_task',
      'watch_task',
      'unwatch_task',
      'apply_label',
      'remove_label',
      'add_dependency',
      'remove_dependency',
      'update_task',
      'add_comment',
    ]) {
      expect(regression).toContain(`'${action}'`)
    }

    expect(regression).toContain('A cross-board dependency was accepted.')
    expect(regression).toContain('Task-update notifications crossed task boundaries')
    expect(regression).toContain('Comment notifications crossed task boundaries')
  })
})
