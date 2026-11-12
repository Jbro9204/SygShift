# Operational email recipient and delivery integrity — November 12, 2026

Status: database support applied in inactive mode; application release pending.

## Verified defects

- Announcement snapshots could still resolve addresses for employees whose
  current employment/account state no longer allowed operational access.
- The old preference filter treated an unresolved address as allowed. Some
  operational lanes did not use it at all.
- Whole-job retries could repeat an earlier recipient after a partially
  successful delivery. A provider error did not prove no delivery occurred.

Retained snapshot rows are evidence of an eligibility risk, not proof that each
row produced a new email. Existing delivery history is not rewritten.

## Repair

- Apply one job-bound operational delivery boundary to general, timekeeping,
  time-off, support and employee-notification lanes. Account recovery, manual
  passwords, invitations, onboarding and security mail remain unchanged.
- Preserve published announcement audiences. For dynamic schedule/call-off
  audiences, freeze employee identities at first dispatch, then recheck current
  eligibility and canonical contact immediately before each send. This is not
  represented as a publish-time snapshot.
- Keep existing lane-specific permission/assignment rules and preferences.
  Required notices bypass optional preferences only, not disabled access.
  Ordinary Guard MFA policy and password-change requirements are unchanged.
- Reject ambiguous/unresolved addresses, closed source jobs, disabled or
  separated recipients and invalid source/recipient pairs. A lookup failure
  does not authorize delivery.
- Use one private append-only ledger for identity, claim and outcome evidence.
  Accepted recipients cannot be blindly resent. Unknown provider outcomes are
  held for explicit reconciliation, never relabeled as delivered or retried as
  though nothing happened. This is not an exactly-once provider guarantee.
- Reconcile lost finalization replies using the same idempotent finalizer;
  guarded deferral cannot reopen a delivered or held job.
- Keep intentionally held email outcomes separate from runtime failures. A
  protected delivery hold does not make the clock or login readiness fail;
  genuine unavailable service operations remain visible failures.
- Guard the legacy claim path so a source rollback cannot resend recipients
  already handled by the new sender. The new batch reserves its audience in
  the claim transaction. Stage the sender inactive, then use a bounded delivery
  pause and verified drain for cutover; do not overlap old in-flight sends with
  new ownership. No maintenance announcement or employee-access change is
  required for this email-only transition.

## Database and preservation

Forward migration `20261112205236_operational_email_recipient_delivery_guard.sql`
adds service-only delivery functions, private forced-RLS delivery/control state
and a private canonical-address expression index. Five existing pending-job
selectors gain only the guarded ownership predicate; account/security functions,
original notification audience rules and old receipts remain unchanged.
The index is justified by the large synthetic address lookup; it does not expose
private contact data through a new public grant.

No employee, Auth credential, access role, schedule, punch, payroll, report or
existing email record is changed by migration activation. New ledger events and
normal source-job outcomes are written only by later operational processing.

## Verification

- 137 focused Worker/adapter tests passed, including five lanes, eligibility
  failures, current-address proof, lost finalization replies, no provider replay
  and preservation of non-operational email paths.
- 82 native PostgreSQL assertions passed using the original production function
  definitions and actual service-role boundaries. Coverage includes concurrent
  claims, preference rules, ambiguous addresses, Guard/no-login cases, disabled
  or removed access, source withdrawal, immutable outcomes and full rollback.
- The initial 82-check pass preserved all 11 dependency definitions. The final
  rollback interlock also requires tests for the five exact predicate changes,
  unchanged remaining definitions and preserved function security metadata.
- A 100,000-row synthetic ambiguity lookup measured 379.129 ms without the
  expression index and 0.077 ms with it. These are local fixture measurements,
  not production service latency.
- Full candidate quality, mandatory Time Clock regression, migration activation,
  exact main-source workflow, deployment and natural scheduled-cycle checks
  remain release requirements.

## Pre-release checkpoint

- The final native database rehearsal passed 108 checks. Mixed old/new callers,
  atomic reservation, unchanged remaining body text/security metadata, staged
  activation and rollback protection are covered.
- Full local `pnpm check` passed: 409 files passed, one intentionally skipped;
  2,597 application tests passed, one intentionally skipped. The release-tool
  suite passed, followed by the production build/static-asset checks. The
  mandatory desktop/mobile clock matrix passed all 42 tests.
- Migration `20261112205236` is applied with the guarded sender still disabled
  and no legacy pause. No delivery-ledger rows were created by activation.
- Normalized source SHA-256:
  `7c78f53fa85fad3b55c5751002d635629c5b144e4854cd2be0541d43fb841089`.
  Its 40-statement ledger SHA-256 is
  `1fbc53499468cffd82a05ed070011fd91f344bd91947d615311e0686736ff8f0`.
- Read-only postflight passed. A new 460-entry ownership baseline preserves all
  457 prior entries/source checksums and admits only the three approved
  reporting/delivery migrations. Baseline file SHA-256:
  `a30105beb40d3fad5c9c7874624d526d0d793b34a4a335152cb654fe339583fd`.
- Database advisors retain the same 409 existing findings and identical key
  fingerprint; none concern the new operational delivery objects. This is not
  a claim that all historical database advisories are resolved.
- Existing Worker rollback checkpoint: version
  `9d275e99-6f25-4f86-82de-0abcc0b4553c`, source
  `0c2809ee5f9af375936806635a3aadd8c9e0ad75`.

## Limitations and rollback

Existing announcement expiration and published audience policy are retained;
this repair does not retroactively reclassify required acknowledgments after a
role change. Held provider outcomes require reconciliation, not automatic resend.

Keep additive ledger evidence if code must roll back. Do not erase accepted or
unknown outcomes, replay completed jobs, change account eligibility to force a
send, or restore an unsafe sender over partially processed guarded jobs without
reviewing their retained outcomes first.
