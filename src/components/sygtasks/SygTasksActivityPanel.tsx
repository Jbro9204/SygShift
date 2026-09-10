import { useInfiniteQuery } from '@tanstack/react-query'
import { ArrowRight, History, LoaderCircle } from 'lucide-react'
import { getSygTaskActivity, type SygTaskActivityEvent } from '../../data/sygtasks'
import { formatSygTaskActivityMoment, presentSygTaskActivity } from '../../lib/sygtasksActivity'

function ActivityEntry({ event }: { event: SygTaskActivityEvent }) {
  const presentation = presentSygTaskActivity(event)
  return (
    <li>
      <span className="sygtasks-activity__dot" aria-hidden="true" />
      <article className="sygtasks-activity__card">
        <header>
          <div>
            <p><strong>{event.actorName}</strong> {presentation.summary}</p>
            <span className={`sygtasks-activity__source sygtasks-activity__source--${event.actorSource}`}>
              {event.actorSource === 'system' ? 'System action' : 'Employee action'}
            </span>
          </div>
          <time dateTime={event.createdAt}>{formatSygTaskActivityMoment(event.createdAt)}</time>
        </header>
        {presentation.context ? <p className="sygtasks-activity__context">{presentation.context}</p> : null}
        {presentation.changes.length ? (
          <details className="sygtasks-activity__details">
            <summary>View {presentation.changes.length === 1 ? 'change' : `${presentation.changes.length} changes`}</summary>
            <dl>
              {presentation.changes.map((item) => (
                <div className={item.long ? 'is-long' : ''} key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>
                    <span><small>Previous</small>{item.before}</span>
                    <ArrowRight aria-label="changed to" size={16} />
                    <span><small>New</small>{item.after}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
      </article>
    </li>
  )
}

export function SygTasksActivityPanel({ taskId }: { taskId: string }) {
  const activityQuery = useInfiniteQuery({
    queryKey: ['sygtasks', 'task-activity', taskId],
    queryFn: ({ pageParam }) => getSygTaskActivity(taskId, pageParam, 50),
    initialPageParam: null as number | null,
    getNextPageParam: (lastPage) => lastPage.page.hasMore ? lastPage.page.nextBeforeId ?? undefined : undefined,
    staleTime: 15_000,
  })
  const events = [...new Map(
    activityQuery.data?.pages.flatMap((page) => page.events).map((event) => [event.id, event]) ?? [],
  ).values()]

  return (
    <section className="sygtasks-activity-panel">
      <div className="sygtasks-activity-panel__heading">
        <div><h3><History aria-hidden="true" size={18} />Activity</h3><p>Every material change is recorded with its author, time, and exact details.</p></div>
        <span>{events.length} event{events.length === 1 ? '' : 's'} shown</span>
      </div>
      {activityQuery.isPending ? <p className="sygtasks-activity__state" role="status"><LoaderCircle className="spin" aria-hidden="true" size={18} />Loading task activity…</p> : null}
      {activityQuery.isError ? <div className="sygtasks-activity__state sygtasks-activity__state--error" role="alert"><span>{activityQuery.error instanceof Error ? activityQuery.error.message : 'Task activity could not load.'}</span><button type="button" className="sygtasks-button sygtasks-button--secondary sygtasks-button--small" onClick={() => void activityQuery.refetch()}>Try Again</button></div> : null}
      {!activityQuery.isPending && !activityQuery.isError && !events.length ? <p className="sygtasks-activity__state">No activity has been recorded for this task yet.</p> : null}
      {events.length ? <ol className="sygtasks-activity">{events.map((event) => <ActivityEntry event={event} key={event.id} />)}</ol> : null}
      {activityQuery.hasNextPage ? <button type="button" className="sygtasks-button sygtasks-button--secondary sygtasks-activity__load" disabled={activityQuery.isFetchingNextPage} onClick={() => void activityQuery.fetchNextPage()}>{activityQuery.isFetchingNextPage ? 'Loading earlier activity…' : 'Load Earlier Activity'}</button> : null}
    </section>
  )
}
