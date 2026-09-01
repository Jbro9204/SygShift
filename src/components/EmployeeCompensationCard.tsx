import { type FormEvent, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BadgeDollarSign, CheckCircle2, Clock3, History, PencilLine, ShieldCheck, XCircle } from 'lucide-react'
import {
  getHrEmployeeCompensation,
  proposeHrEmployeePayRate,
  reviewHrEmployeePayRate,
  type HrEmployeeCompensation,
  type HrPayFrequency,
} from '../data/hrCompensation'
import { ModalDialog } from './ModalDialog'

type Props = {
  employeeId: string
  employeeName: string
}

const frequencyLabels: Record<HrPayFrequency, string> = {
  annual: 'Annual',
  biweekly: 'Biweekly',
  hourly: 'Hourly',
  monthly: 'Monthly',
  semimonthly: 'Semimonthly',
  weekly: 'Weekly',
}

function formatDate(value: string | null): string {
  if (!value) return 'Current'
  const [year, month, day] = value.split('-')
  return `${month}/${day}/${year}`
}

function formatRate(amountCents: number, frequency: HrPayFrequency, currencyCode = 'USD'): string {
  const amount = new Intl.NumberFormat('en-US', { currency: currencyCode, style: 'currency' }).format(amountCents / 100)
  const suffix: Record<HrPayFrequency, string> = {
    annual: 'per year',
    biweekly: 'every two weeks',
    hourly: 'per hour',
    monthly: 'per month',
    semimonthly: 'twice per month',
    weekly: 'per week',
  }
  return `${amount} ${suffix[frequency]}`
}

export function EmployeeCompensationCard({ employeeId, employeeName }: Props) {
  const [proposalOpen, setProposalOpen] = useState(false)
  const [reviewProposal, setReviewProposal] = useState<HrEmployeeCompensation['pendingProposals'][number] | null>(null)
  const [notice, setNotice] = useState('')
  const query = useQuery({
    queryFn: () => getHrEmployeeCompensation(employeeId),
    queryKey: ['hr-employee-compensation', employeeId],
    retry: false,
  })
  const record = query.data

  return (
    <section className="hr-file-compensation" aria-labelledby="employee-compensation-heading">
      <div className="hr-file-card__heading">
        <BadgeDollarSign aria-hidden="true" />
        <div><p className="eyebrow">Highly restricted</p><h2 id="employee-compensation-heading">Compensation &amp; pay rate</h2></div>
        {record?.canManage ? <button className="hr-file-card__edit" onClick={() => { setNotice(''); setProposalOpen(true) }} type="button"><PencilLine aria-hidden="true" size={16} />{record.currentRate ? 'Propose rate change' : 'Add pay rate'}</button> : null}
      </div>

      {query.isPending ? <div className="hr-file-compensation__state" role="status"><Clock3 aria-hidden="true" />Loading protected compensation…</div> : null}
      {query.isError ? <div className="hr-file-compensation__state hr-file-compensation__state--error" role="alert"><ShieldCheck aria-hidden="true" /><span><strong>Protected compensation could not be opened.</strong><small>{query.error instanceof Error ? query.error.message : 'Verify with MFA and try again.'}</small></span><button className="secondary-button" onClick={() => void query.refetch()} type="button"><ShieldCheck aria-hidden="true" size={16} />Verify and retry</button></div> : null}

      {record ? (
        <>
          {notice ? <div className="hr-file-employment-saved" role="status"><CheckCircle2 aria-hidden="true" size={17} />{notice}</div> : null}
          <div className="hr-file-compensation__summary">
            <article><span>Current base pay</span><strong>{record.currentRate ? formatRate(record.currentRate.amountCents, record.currentRate.payFrequency, record.currentRate.currencyCode) : 'Not recorded'}</strong><small>{record.currentRate ? `Effective ${formatDate(record.currentRate.effectiveFrom)}` : 'Add a protected pay-rate proposal to begin the history.'}</small></article>
            <article><span>Pending approval</span><strong>{record.pendingProposals.length}</strong><small>Pay changes require a different authorized administrator to approve them.</small></article>
          </div>

          {record.pendingProposals.length ? <div className="hr-file-compensation__proposals"><h3>Pending pay-rate proposals</h3>{record.pendingProposals.map((proposal) => <article key={proposal.id}><div><strong>{formatRate(proposal.amountCents, proposal.payFrequency, proposal.currencyCode)}</strong><span>Effective {formatDate(proposal.effectiveFrom)} · Proposed by {proposal.proposedBy}</span><small>{proposal.reason}</small></div>{record.canApprove && !proposal.proposedByCurrentActor ? <button className="secondary-button" onClick={() => { setNotice(''); setReviewProposal(proposal) }} type="button">Review</button> : <span className="action-status">{proposal.proposedByCurrentActor ? 'Awaiting another administrator' : 'Pending approval'}</span>}</article>)}</div> : null}

          {record.history.length ? <details className="hr-file-compensation__history"><summary><History aria-hidden="true" size={16} />Pay-rate history <span>{record.history.length}</span></summary><div>{record.history.map((rate) => <article key={rate.id}><strong>{formatRate(rate.amountCents, rate.payFrequency, rate.currencyCode)}</strong><span>{formatDate(rate.effectiveFrom)} – {formatDate(rate.effectiveThrough)}</span></article>)}</div></details> : null}
        </>
      ) : null}

      {proposalOpen && record ? <PayRateProposalDialog employeeId={employeeId} employeeName={employeeName} onClose={() => setProposalOpen(false)} onSaved={() => setNotice('Pay-rate proposal saved for independent approval.')} /> : null}
      {reviewProposal ? <PayRateReviewDialog employeeId={employeeId} employeeName={employeeName} onClose={() => setReviewProposal(null)} onSaved={(status) => setNotice(`Pay-rate proposal ${status}.`)} proposal={reviewProposal} /> : null}
    </section>
  )
}

function PayRateProposalDialog({ employeeId, employeeName, onClose, onSaved }: { employeeId: string; employeeName: string; onClose: () => void; onSaved: () => void }) {
  const queryClient = useQueryClient()
  const [amount, setAmount] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState('')
  const [payFrequency, setPayFrequency] = useState<HrPayFrequency>('hourly')
  const [reason, setReason] = useState('')
  const mutation = useMutation({
    mutationFn: proposeHrEmployeePayRate,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['hr-employee-compensation', employeeId] }),
        queryClient.invalidateQueries({ queryKey: ['hr-compensation'] }),
        queryClient.invalidateQueries({ queryKey: ['hris-employee-file', employeeId] }),
      ])
      onSaved()
      onClose()
    },
  })
  const amountCents = Math.round(Number(amount) * 100)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) return
    mutation.mutate({ amountCents, effectiveFrom, employeeId, payFrequency, reason })
  }

  return <ModalDialog busy={mutation.isPending} busyLabel="Saving protected pay-rate proposal…" className="hr-file-editor-modal" description="Pay values are encrypted in transit, stored in the protected compensation schema, and never shown to ordinary HR or operations roles." onClose={() => !mutation.isPending && onClose()} title={`Pay rate · ${employeeName}`}><form onSubmit={submit}><div className="hr-file-editor-notice"><ShieldCheck aria-hidden="true" /><div><strong>Independent approval required</strong><p>The administrator who proposes this rate cannot approve it. A second compensation-authorized administrator must review the change.</p></div></div><div className="hr-file-editor-grid"><label>Pay amount<input autoFocus inputMode="decimal" min="0" onChange={(event) => setAmount(event.target.value)} placeholder="0.00" required step="0.01" type="number" value={amount} /></label><label>Pay frequency<select onChange={(event) => setPayFrequency(event.target.value as HrPayFrequency)} value={payFrequency}>{Object.entries(frequencyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Effective date<input onChange={(event) => setEffectiveFrom(event.target.value)} required type="date" value={effectiveFrom} /></label></div><label>Business reason<textarea maxLength={1000} onChange={(event) => setReason(event.target.value)} placeholder="Explain the approved offer, raise, adjustment, or correction." required rows={4} value={reason} /></label>{mutation.isError ? <div className="error-message" role="alert">{mutation.error instanceof Error ? mutation.error.message : 'The pay-rate proposal could not be saved.'}</div> : null}<div className="modal-actions"><button className="secondary-button" disabled={mutation.isPending} onClick={onClose} type="button">Cancel</button><button className="primary-action" disabled={mutation.isPending || !amount || !effectiveFrom} type="submit"><BadgeDollarSign aria-hidden="true" size={17} />Submit for approval</button></div></form></ModalDialog>
}

function PayRateReviewDialog({ employeeId, employeeName, onClose, onSaved, proposal }: { employeeId: string; employeeName: string; onClose: () => void; onSaved: (status: 'approved' | 'rejected') => void; proposal: HrEmployeeCompensation['pendingProposals'][number] }) {
  const queryClient = useQueryClient()
  const [decision, setDecision] = useState<'approved' | 'rejected'>('approved')
  const [reason, setReason] = useState('')
  const mutation = useMutation({
    mutationFn: reviewHrEmployeePayRate,
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['hr-employee-compensation', employeeId] }),
        queryClient.invalidateQueries({ queryKey: ['hr-compensation'] }),
        queryClient.invalidateQueries({ queryKey: ['hris-employee-file', employeeId] }),
      ])
      onSaved(result.status)
      onClose()
    },
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    mutation.mutate({ decision, proposalId: proposal.id, reason })
  }

  return <ModalDialog busy={mutation.isPending} busyLabel="Recording compensation decision…" className="hr-file-editor-modal" description="Review the proposed amount, effective date, and documented reason before recording an irreversible approval decision." onClose={() => !mutation.isPending && onClose()} title={`Review pay rate · ${employeeName}`}><form onSubmit={submit}><div className="hr-pay-rate-review-summary"><span>Proposed rate<strong>{formatRate(proposal.amountCents, proposal.payFrequency, proposal.currencyCode)}</strong></span><span>Effective<strong>{formatDate(proposal.effectiveFrom)}</strong></span><span>Proposed by<strong>{proposal.proposedBy}</strong></span><p>{proposal.reason}</p></div><div className="hr-pay-rate-decision" role="group" aria-label="Pay-rate decision"><button className={decision === 'approved' ? 'is-active' : ''} onClick={() => setDecision('approved')} type="button"><CheckCircle2 aria-hidden="true" size={18} />Approve</button><button className={decision === 'rejected' ? 'is-active is-reject' : ''} onClick={() => setDecision('rejected')} type="button"><XCircle aria-hidden="true" size={18} />Reject</button></div><label>Review reason<textarea maxLength={1000} onChange={(event) => setReason(event.target.value)} placeholder="Document why this proposal is approved or rejected." required rows={4} value={reason} /></label>{mutation.isError ? <div className="error-message" role="alert">{mutation.error instanceof Error ? mutation.error.message : 'The pay-rate decision could not be saved.'}</div> : null}<div className="modal-actions"><button className="secondary-button" disabled={mutation.isPending} onClick={onClose} type="button">Cancel</button><button className={decision === 'approved' ? 'primary-action' : 'danger-action'} disabled={mutation.isPending} type="submit">{decision === 'approved' ? <CheckCircle2 aria-hidden="true" size={17} /> : <XCircle aria-hidden="true" size={17} />}Record {decision === 'approved' ? 'approval' : 'rejection'}</button></div></form></ModalDialog>
}
