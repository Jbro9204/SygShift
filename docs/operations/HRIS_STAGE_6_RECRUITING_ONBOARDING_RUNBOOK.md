# HRIS Stage 6 — Recruiting and Onboarding Runbook

**Runbook date:** 08/30/2026
**Default production state:** Disabled

## Normal dormant state

The expected state after deployment is:

- recruiting database gate: disabled;
- onboarding database gate: disabled;
- `SYGSHIFT_HR_RECRUITING_ENABLED`: false;
- `SYGSHIFT_HR_ONBOARDING_ENABLED`: false;
- Stage 6 role permission assignments: zero;
- Stage 6 employee permission overrides: zero;
- candidate conversion requests: zero unless a later controlled activation has occurred;
- onboarding cases and tasks: zero unless a later controlled activation has occurred.

An unauthenticated request to a Stage 6 route must return `401`. An authenticated request while the applicable gate is closed must not disclose protected recruiting or onboarding data.

## Pre-activation checklist

Do not enable Stage 6 unless all items are complete:

1. Confirm the production backup and recovery evidence is current.
2. Confirm the intended HR owners and approvers in writing.
3. Review every proposed role and individual permission assignment.
4. Confirm no permission grants broader access than the approved job function.
5. Validate a canary requisition, applicant, interview, scorecard, offer, and disposition workflow.
6. Validate the two-person candidate conversion rule and duplicate-match report.
7. Confirm candidate conversion creates no account, role, schedule, time, or payroll record.
8. Review one onboarding template and all dependencies.
9. Validate authoritative readiness links for User Accounts, Licensing, Training, documents, equipment, and site access.
10. Confirm reminders and escalations are routed only to approved recipients.
11. Run the Stage 6 validator and the complete application quality suite.
12. Record the activation window, owner, rollback owner, and success criteria.

## Controlled activation order

1. Assign only the approved canary permissions.
2. Re-run the access-preservation inventory.
3. Enable the database gate for the selected workspace.
4. Enable the matching Worker flag.
5. Deploy the Worker.
6. Test authenticated view access and confirm unauthorized users are denied.
7. Execute the approved canary workflow.
8. Inspect append-only events and audit evidence.
9. Confirm no unrelated employee, account, role, schedule, time, payroll, licensing, or document record changed.
10. Record the continue-or-rollback decision.

Recruiting and onboarding may be activated independently. Do not activate both merely because one has passed its canary.

## Emergency stop

If protected data is exposed incorrectly, a permission is broader than approved, a duplicate employee could be created, or a source-system readiness result is wrong:

1. Disable the affected Worker flag.
2. Deploy immediately.
3. Disable the matching database release gate.
4. Remove Stage 6 role and individual permission assignments added by the activation.
5. Preserve all records and append-only events.
6. Capture the affected request identifiers, actors, timestamps, and Worker version.
7. Verify unrelated production counts and access assignments remain unchanged.
8. Do not delete or rewrite candidate, conversion, employee, onboarding, or audit history.

## Candidate conversion response

If a duplicate match appears, stop the conversion. HR must determine whether the applicant already has an employee identity. Never bypass the duplicate report by changing the applicant's name, email, or telephone solely to force conversion.

An approved conversion must be reviewed by an authorized person other than the requester. If the resulting employee should receive a login, role, schedule, license, training assignment, or payroll setup, complete those actions through their existing authoritative SygShift workflows.

## Verification commands

Run from the repository root with the bundled Node runtime available:

```text
pnpm check:hris-recruiting-onboarding
pnpm check
git diff --check
```

After deployment, verify the primary and fallback health and readiness endpoints, confirm both release gates remain in the approved state, confirm access assignments match the approved snapshot, and record the deployed Worker version in the dated change log.
