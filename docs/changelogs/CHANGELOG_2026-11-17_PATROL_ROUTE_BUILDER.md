# Patrol route connection integrity — 11/17/2026

Status: the route migration and SygShift application are deployed and verified at
source `20582b7378c07b15283892fe63ead80d6548b035`. Operations-confirmed MG
property/route mappings and real-device Guard/Operations/client acceptance remain
open. No live mapping, assignment, credential, hours or payroll repair was inferred
or performed as part of this deployment.

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
  passed. The 40 new portable baseline/artifact tests passed without skips.
  Four existing platform-specific release-tool checks skip on Windows; the
  required hosted Linux quality workflow also passed for the exact deployed SHA.
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

Both coordinated database migrations and the SygShift application repair are
released. The separate Sygilant application promotion is tracked in its own
release record. Guessed MG property/route mappings are not authorized. Operations
must identify the actual properties before anyone changes those live links.
The exact predecessor, ledger, candidate, rehearsal and deployment results are
recorded below.

Release preparation adds the following controls:

- A scoped ownership capture preserves the immutable 462-entry November 12
  predecessor and admits only the already verified November 13 client-recovery
  migration plus the exact Sygilant and SygShift patrol sources. The permitted
  applied states are 463 before either patrol activation, 464 after either one,
  and 465 after both; an unknown addition or any earlier source/ledger change
  stops the release.
- A separate expected-after-both manifest can be prepared from a complete
  rollback-rehearsal ledger. It is explicitly not observed production state or
  proof of activation/rollback completion. The fresh production release gate
  must match it after actual activation. Existing manifests are never replaced.
- The generated activation batch checks the exact ledger and immutable source,
  function/security catalogs and protected data before and after the change.
  Data checks compare full row counts and at most 128 ordered rows per protected
  table; they are bounded cohort checks, not full-table content hashes. The
  entire historical migration ledger and owning-source checksums remain checked.
- Native PostgreSQL verification passed 74 checks, including the generated
  SygShift rollback rehearsal, exact transient ledger addition, restored writer
  and ledger, refusal of a deliberate employee change, and stale-ledger refusal.
  This uses isolated synthetic records and does not prove live employee acceptance.
- The two new self-contained baseline/artifact test suites are in the mandatory
  release-tool gate. Complete main-candidate and hosted checks passed for the
  deployed source.
- The approved anonymous-boundary release fallback was used because a configured
  read-only release canary was unavailable. It does not replace the
  pending signed-in Guard/Operations workflow check or permit changing access.

An older browser must refresh before using the new save contract. Concurrent
publication of a new schedule revision has not been live-accepted; the link
checks use the current transactional snapshot and do not claim a new shared
publication lock. If recovery
is needed, preserve receipt/version history and deploy a compatible forward
repair; do not restore the unsafe unguarded writer or discard saved versions.

## Production staging evidence

- Both exact migration batches passed production rollback rehearsals with
  complete command success and follow-up proof that the rehearsed ledger entry
  was absent. Protected record counts/cohorts and unrelated security catalogs
  matched within each transaction.
- The corrected Sygilant migration `20261117181328` was then applied and verified
  at 464 entries; the route repair was still unapplied at that staging checkpoint.
- Rehearsing the route repair on that installed predecessor produced the
  expected 465-entry ledger, then rolled back to 464. The committed expected
  release baseline has SHA-256
  `f4892aa2e6e6bfa5db72cba02c45c6655547d22c11d9ef85c1ac639c29eb2ebc`.
  It is deliberately marked expected/uncommitted, not observed live state.
- The original 462 entries and their owning source checksums remain unchanged;
  only the recorded November 13 recovery migration and the two reviewed patrol
  sources are admitted. No bulk migration replay or live mapping edit is used.
- The production security advisor returned no error-level findings before
  activation. This staging evidence is distinct from the final deployment below.

## Production release and remaining acceptance

- Exact source `20582b7378c07b15283892fe63ead80d6548b035` passed the local
  exact-main candidate gate and GitHub push workflow `44155873858`, including
  the required hosted quality/security checks.
- Both coordinated migrations are applied and verified: Sygilant
  `20261117181328` and SygShift `20261117182334`. The observed production ledger
  contains 465 entries. The separate actual-state baseline
  `docs/reliability/migration-ownership-2026-11-17-patrol-after-both-v2.json`
  has SHA-256
  `ab9f7bea266da232cb5c0b323c79448fc00c29ed2f990777f284e13f35ea3f6d`.
  The expected rehearsal manifest is retained unchanged and is not relabeled as
  observed production.
- The guarded SygShift release promoted Worker
  `0819cdf2-eb09-49fc-9539-5a33c457242e` on that source, with two reconciliation
  reads, 16 production probes and two upstream probes. No rollback was required.
  Wrangler supplied no candidate Version URL; candidate-only URL verification is
  unavailable, not claimed passed.
- Independent production root, login, health and readiness requests returned
  HTTP 200. Readiness showed all 12 checks true and zero consecutive failures.
  The natural full-success watermark advanced to `2026-11-17T19:27:54.523Z` on
  the deployed source. The live `index-C_719yHL` entry matched the fresh production
  build and contained no fixture marker.
- The prior Worker checkpoint is `b8a5955c-320a-404f-909b-1276a63042f4`, source
  `1e9750a41e98c7fe38e18d6b7a58280ac0d3371b`. Retain all migration, route-version
  and receipt evidence if application recovery is needed. An older browser or
  older application needs the compatible save contract; never undo the database
  protections or erase history to restore an unsafe writer.
- No post-release signed-in UI acceptance is claimed. The browser checkpoint
  could not confirm its destination URL. Operations must confirm the real MG
  route/property mappings, then complete Guard selection/evidence/draft,
  supervisor review and client-release checks on the actual devices. Successful
  deployment and health probes do not close those employee cases by themselves.
