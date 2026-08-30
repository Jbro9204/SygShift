# HRIS Stage 7 — Leave, Benefits, and Compensation Runbook

**Runbook date:** 08/30/2026  
**Default production state:** Disabled

## Normal dormant state

The expected state after deployment is:

- leave database gate: disabled;
- benefits database gate: disabled;
- compensation database gate: disabled;
- `SYGSHIFT_HR_LEAVE_ENABLED`: false;
- `SYGSHIFT_HR_BENEFITS_ENABLED`: false;
- `SYGSHIFT_HR_COMPENSATION_ENABLED`: false;
- Stage 7 role permission assignments: zero;
- Stage 7 employee permission overrides: zero;
- leave policies and cases: zero unless a later controlled activation has occurred;
- benefit plans and enrollments: zero unless a later controlled activation has occurred;
- compensation records and proposals: zero unless a later controlled activation has occurred.

Unauthenticated Stage 7 API requests must return `401`. An authenticated user without the exact permission must be denied. A user with a permission must still receive no protected workspace data while the applicable release gate is closed.

## Pre-activation checklist

Do not enable any Stage 7 module until all applicable items are complete:

1. Confirm current backup and recovery evidence.
2. Identify the named business owner, operator, and approver.
3. Review every proposed role and individual permission assignment.
4. Obtain approved policy, plan, eligibility, or compensation source data.
5. Confirm no balance, entitlement, benefit promise, or compensation decision is inferred.
6. Test an authorized and unauthorized account.
7. Test bounded 5, 10, and 20 item views.
8. For leave, validate the link to operational time-off and explicit downstream authorization.
9. For protected leave, validate the independent protected-data permission and document-vault boundary.
10. For benefits, validate effective dates, eligibility evidence, enrollment decisions, and history.
11. For compensation, validate recent MFA, proposer/approver separation, and append-only evidence.
12. Run the Stage 7 validator and complete application quality suite.
13. Record the activation window, owner, rollback owner, and success criteria.

## Controlled activation order

Activate leave, benefits, and compensation independently:

1. Assign only the approved canary permission.
2. Re-run the production access-preservation inventory.
3. Enable the applicable private database release gate.
4. Enable the matching Worker feature flag.
5. Deploy the Worker.
6. Verify unauthorized access remains denied.
7. Execute one approved canary workflow.
8. Inspect append-only event and approval evidence.
9. Confirm unrelated employee, role, account, schedule, time, payroll, licensing, document, and operational time-off data remains unchanged.
10. Record the continue-or-rollback decision.

## Emergency stop

If protected information is exposed incorrectly, a permission is broader than approved, a downstream change occurs without authorization, or a compensation decision violates separation:

1. Disable the affected Worker flag.
2. Deploy immediately.
3. Disable the corresponding database release gate.
4. Remove only the Stage 7 access grants added for the activation.
5. Preserve all records and append-only evidence.
6. Capture request identifiers, actors, timestamps, and the deployed Worker version.
7. Verify production access assignments and unrelated operational counts.
8. Do not delete or rewrite leave, benefits, compensation, approval, or audit history.

## Verification commands

Run from the repository root with the bundled Node runtime available:

```text
pnpm check:hris-leave-benefits-compensation
pnpm check
git diff --check
```

After deployment, verify application health and readiness, SPA routing, unauthenticated API boundaries, all three disabled release gates, all three disabled Worker flags, zero unintended permission assignments, and preserved operational counts. Record the Worker version in the dated change log.
