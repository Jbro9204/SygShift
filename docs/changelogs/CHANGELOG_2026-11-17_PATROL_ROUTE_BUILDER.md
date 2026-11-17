# Patrol route connection integrity — 11/17/2026

Status: local implementation and verification complete. No production migration, push, deployment, or
operational record change has been performed.

Base: `1e9750a41e98c7fe38e18d6b7a58280ac0d3371b` (`origin/main` at start).

## Verified causes

- The route editor's location catalog used an inner join to active posts, so an
  active property with no post could not be selected.
- A stop could be saved without a canonical property link. Reporting could not
  then derive its correct client or authorize the property for a Guard.
- Route saves lacked a stable request identity and expected source version.
- Reconnecting a later version of the same route could add a second assignment
  whose properties were combined with the retained earlier version.
- Candidate shifts could include superseded publication or canceled records.

## Repairs

- Make property the primary selector and post optional. Show the linked client;
  include only active properties with an active client. Post selection must
  belong to that property. This is an Operations catalog, not Guard access.
- Keep unfinished configurations in Draft. An active route requires verified
  property links and active weekday hit requirements at every stop. Linking
  also verifies applicable requirements for the chosen shift's weekday.
- Preserve the existing version writer behind the canonical protected RPC.
  Stable request receipts make exact retries harmless, while row locks and
  expected-version checks reject stale saves. Receipts are private, forced-RLS,
  append-only records with no direct browser access.
- Capture the exact in-flight form. Distinguish rejected, uncertain, confirmed
  but not refreshed, and conflicting saves. Do not resend a confirmed save to
  fix a readback failure. Verify the saved configuration before reporting success.
- Recheck the current, uncanceled published shift and exact employee assignment
  before linking or returning a prior link. Refuse a conflicting retained
  version of the same route rather than canceling history or combining versions.
  Deliberate different-route behavior is unchanged.
- Filter connection candidates using the same current-publication and
  cancellation boundaries. Retained assignments and completed history remain.

Forward migration:
`20261117182334_patrol_route_builder_integrity.sql`.
It performs no route, stop, shift, assignment, obligation, punch, payroll, report,
employee, or permission backfill. Actual live property links require Operations
confirmation through the authorized workflow.

## Verification

- Native PostgreSQL 18: 66 checks passed, including exact retries, competing
  updates, stale sources, site/post/client validation, denied access, canceled
  and superseded assignments, source-definition drift, and rollback.
- Tests use actual route writer and workspace definitions with synthetic
  identity/reconciliation fixtures. They are not live employee acceptance.
- Focused application: 30 tests passed, including readback normalization,
  superseded-save review, account changes, failures, and exact retry behavior.
- Four desktop/phone light/dark rendered cases passed with actual route-page
  components and isolated synthetic data. Postless-property save was verified;
  external network requests were blocked. Screenshots were inspected.
- Full `pnpm release:verify` passed on Node 24.19.0 and pnpm 11.25.0:
  412 application test files / 2,646 tests passed; one existing private-HR-corpus
  test file remains conditionally skipped because that separate corpus is not
  installed. TypeScript, lint, native history/security/route checks, release
  regressions, Worker/client production builds, and static-asset validation
  passed. No new test is skipped or gate waived.
- Mandatory clock-in preservation: 42/42 desktop/mobile workflow tests passed
  against this changed checkout, followed by a fresh production build.
- The separate Sygilant report candidate verifies the exact route-obligation
  property/client boundary; saving a route alone does not grant report access.

## Operations workflow

1. Open Patrol > Routes & Requirements; build or edit a route.
2. Add each property explicitly. Choose a post only if needed, confirm the
   linked client, and configure the required weekdays/hits.
3. Save a new route version. Active routes must pass setup validation; incomplete
   work may be kept as a Draft.
4. Open Patrol > Operations and connect the route to the exact published shift
   and assigned employee. Saving a route does not automatically rewrite shifts.
5. If an earlier version is already connected, stop and reconcile that retained
   assignment deliberately. Do not delete old evidence or add another version
   to force a property to appear.
6. Verify the Guard's property list, report checklist, and client association
   before declaring that employee's live case closed.

## Release and rollback boundary

Deployment is not authorized in this work order. Apply no live mappings based on
assumed property names. Before release, verify the exact installed predecessor
functions and ledger, run the complete candidate gates, rehearse the forward
migration, and complete an authorized Guard/Operations workflow check.

An older browser must refresh before using the new save contract. Concurrent
publication of a new schedule revision has not been live-accepted; the link
checks use the current transactional snapshot and do not claim a new shared
publication lock. If recovery
is needed, preserve receipt/version history and deploy a compatible forward
repair; do not restore the unsafe unguarded writer or discard saved versions.
