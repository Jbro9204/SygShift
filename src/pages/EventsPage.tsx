import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, DatabaseZap, MapPin, Search, ShieldAlert, UsersRound } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import {
  getOpenOpportunities,
  opportunityLocation,
  opportunityRequest,
  opportunityTitle,
  submitOpportunityRequest,
  withdrawOpportunityRequest,
  type Opportunity,
} from '../data/opportunities'
import { parseImportedScheduleNote, sourceReferenceLabel } from '../data/sourceNotes'
import { isSupabaseConfigured } from '../lib/supabase'

const requestLabels = {
  pending: 'Requested',
  approved: 'Approved',
  declined: 'Not approved',
  withdrawn: 'Withdrawn',
  canceled: 'Canceled',
} as const

function opportunityTime(opportunity: Opportunity): string {
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    timeZone: opportunity.time_zone,
  }).format(new Date(opportunity.starts_at))
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: opportunity.time_zone,
  })
  return `${day} · ${time.format(new Date(opportunity.starts_at))} – ${time.format(new Date(opportunity.ends_at))}`
}

function OpportunityCard({
  opportunity,
  canRequest,
  mutation,
}: {
  opportunity: Opportunity
  canRequest: boolean
  mutation: ReturnType<typeof useOpportunityMutation>
}) {
  const request = opportunityRequest(opportunity)
  const openSlots = Math.max(opportunity.headcount_required - opportunity.assignments.length, 0)
  const busy = mutation.isPending && mutation.variables?.opportunityId === opportunity.id
  const source = parseImportedScheduleNote(opportunity.notes)
  const sourceReference = sourceReferenceLabel(source)
  const guardCanRequest = canRequest && !source.reviewNeeded

  return (
    <article className={source.reviewNeeded ? 'opportunity-card opportunity-card--review-needed' : 'opportunity-card'}>
      <header>
        <div>
          <div className="opportunity-card__type">
            {opportunity.event ? 'Event' : 'Open shift'}
            {opportunity.is_overtime ? <span>Overtime</span> : null}
            {source.reviewNeeded ? <span>Review needed</span> : null}
          </div>
          <h2>{opportunityTitle(opportunity)}</h2>
        </div>
        {opportunity.requires_armed ? <span className="qualification qualification--armed">Armed</span> : null}
      </header>
      <p className="opportunity-card__time">{opportunityTime(opportunity)}</p>
      <p className="opportunity-card__location">
        <MapPin aria-hidden="true" size={18} />
        {opportunityLocation(opportunity)}
      </p>
      {source.reviewNeeded ? (
        <div className="opportunity-card__source-note" aria-label="Schedule assignment review">
          {source.assignee ? <span><strong>Original assignee:</strong> {source.assignee}</span> : null}
          {source.context ? <span><strong>Schedule context:</strong> {source.context}</span> : null}
          {source.qualification ? <span><strong>Qualification:</strong> {source.qualification}</span> : null}
          {sourceReference ? <small>{sourceReference}</small> : null}
        </div>
      ) : null}
      <footer>
        <div className="opening-count">
          <UsersRound aria-hidden="true" size={19} />
          <span>{openSlots} opening{openSlots === 1 ? '' : 's'}</span>
        </div>
        {guardCanRequest ? (
          request?.status === 'pending' ? (
            <button
              className="secondary-button opportunity-action"
              disabled={busy}
              onClick={() => mutation.mutate({ action: 'withdraw', id: request.id, opportunityId: opportunity.id })}
              type="button"
            >
              {busy ? 'Withdrawing…' : 'Withdraw request'}
            </button>
          ) : request ? (
            <span className={`request-status request-status--${request.status}`}>
              {requestLabels[request.status]}
            </span>
          ) : (
            <button
              className="primary-action opportunity-action"
              disabled={busy}
              onClick={() => mutation.mutate({ action: 'request', id: opportunity.id, opportunityId: opportunity.id })}
              type="button"
            >
              {busy ? 'Requesting…' : 'Request to work'}
            </button>
          )
        ) : canRequest && source.reviewNeeded ? (
          <span className="request-status">Supervisor review required</span>
        ) : (
          <span className="request-status">Supervisor view</span>
        )}
      </footer>
    </article>
  )
}

type OpportunityMutationInput = {
  action: 'request' | 'withdraw'
  id: string
  opportunityId: string
}

function useOpportunityMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ action, id }: OpportunityMutationInput) => {
      if (action === 'request') return submitOpportunityRequest(id)
      await withdrawOpportunityRequest(id)
      return id
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['open-opportunities'] })
    },
  })
}

export function EventsPage() {
  const [search, setSearch] = useState('')
  const opportunitiesQuery = useQuery({
    queryKey: ['open-opportunities'],
    queryFn: getOpenOpportunities,
    enabled: isSupabaseConfigured,
  })
  const mutation = useOpportunityMutation()
  const opportunities = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return (opportunitiesQuery.data?.opportunities ?? []).filter((opportunity) => {
      const searchable = [opportunityTitle(opportunity), opportunityLocation(opportunity)]
        .join(' ')
        .toLocaleLowerCase()
      return !term || searchable.includes(term)
    })
  }, [opportunitiesQuery.data, search])

  return (
    <div className="page page--workforce">
      <section className="page-intro workforce-intro">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>Events &amp; openings</h1>
          <p className="page-summary">
            Published opportunities in one place, with armed-work safeguards and supervisor review
            markers kept visible before a guard requests the work.
          </p>
        </div>
      </section>

      {!isSupabaseConfigured ? (
        <DataStatePanel icon={DatabaseZap} title="Openings ready for the secure connection" tone="setup">
          <p>
            Events and open shifts appear here after authentication is connected. Armed work is never
            shown to an unqualified guard.
          </p>
          <ul>
            <li>Published events and open shifts only</li>
            <li>Request and pending-withdrawal workflow</li>
            <li>Supervisor approval before assignment</li>
          </ul>
        </DataStatePanel>
      ) : opportunitiesQuery.isPending ? (
        <DataStatePanel icon={CalendarClock} title="Loading qualified opportunities">
          <p>Checking published openings against your active employee account and qualifications.</p>
        </DataStatePanel>
      ) : opportunitiesQuery.isError ? (
        <DataStatePanel icon={ShieldAlert} title="Openings unavailable" tone="error">
          <p>{opportunitiesQuery.error.message}</p>
        </DataStatePanel>
      ) : (
        <>
          <section className="workforce-toolbar workforce-toolbar--single" aria-label="Opening controls">
            <label className="search-field search-field--wide">
              <Search aria-hidden="true" size={20} />
              <span className="visually-hidden">Search events and open shifts</span>
              <input
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search events, sites, or posts"
                type="search"
                value={search}
              />
            </label>
          </section>

          {mutation.isError ? (
            <div className="inline-alert" role="alert">{mutation.error.message}</div>
          ) : null}

          {opportunities.length === 0 ? (
            <DataStatePanel icon={CalendarClock} title="No qualified openings are available">
              <p>New published events, overtime openings, and supervisor-reviewed shifts will appear here automatically.</p>
            </DataStatePanel>
          ) : (
            <section className="opportunity-grid" aria-label="Available events and open shifts">
              {opportunities.map((opportunity) => (
                <OpportunityCard
                  canRequest={opportunitiesQuery.data?.role === 'guard'}
                  mutation={mutation}
                  opportunity={opportunity}
                  key={opportunity.id}
                />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  )
}
