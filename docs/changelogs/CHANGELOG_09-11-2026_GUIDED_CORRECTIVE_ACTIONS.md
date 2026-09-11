# Guided Corrective Actions

Date: 2026-09-11  
Scope: Simple, protected corrective-action creation, independent HR review, private delivery, and employee response

## Outcome

Employee Cases now includes one guided corrective-action workflow. A manager records the facts and expectations, a different authorized HR user reviews the record, and the approved record is delivered privately to the employee through Action Center and one email. The employee can acknowledge receipt, respond, dispute, or decline acknowledgment without any response being represented as agreement.

## Delivered

- Added a four-step **Employee → Facts → Expectations → Review** walkthrough with readable character limits and clear instructions.
- Prevented the proposing manager from approving their own record.
- Separated approval from delivery so an approved draft is never sent accidentally.
- Added one private employee notification and one email at delivery, with no sensitive case details in the email body.
- Added employee choices for receipt-only acknowledgment, written response, dispute, or declined acknowledgment.
- Added explicit language that acknowledgment confirms receipt and review only and does not mean agreement.
- Added immutable employee responses and an append-only corrective-action event timeline.
- Connected every corrective action to the canonical restricted HR case record rather than creating a second competing case system.
- Added delivered corrective actions to the existing Required Actions Checkpoint without copying or replacing the source record.
- Added responsive layouts for desktop, small laptops, and mobile, including non-overlapping step controls and full-width mobile actions.

## Safety and verification

- The migration does not create, alter, or delete any current employee, case, case note, evidence, document, role assignment, or permission override.
- A complete create → independent approve → deliver → employee dispute → close cycle passed inside a rolled-back production transaction.
- Database RLS keeps the new tables service-only; employees access only their own delivered records through narrowly scoped functions.
- TypeScript, lint, the full unit suite, and production build passed.
- Guided-workflow contract tests and desktop/mobile browser accessibility and overflow checks passed.

## Files

- `supabase/migrations/20260912130000_guided_corrective_action_workflow.sql`
- `worker/index.ts`
- `src/data/correctiveActions.ts`
- `src/components/CorrectiveActionsWorkspace.tsx`
- `src/components/RequiredActionsCheckpointNotice.tsx`
- `src/pages/HrisStage8Page.tsx`
- `src/pages/ActionCenterPage.tsx`
- `src/App.css`
