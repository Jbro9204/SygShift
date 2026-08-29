# SygShift Changelog — Banner Alert Lifecycle and Modal

Date: 08/29/2026

## Summary

Banner alerts now use an authoritative lifecycle instead of trusting a stored Active flag after an alert expires. The banner editor was also rebuilt into a properly spaced, consistent SygShift modal, and authorized managers can cancel or delete alerts from the workspace.

## What changed

- Rebuilt the Create/Edit Banner modal with consistent typography, field spacing, section hierarchy, focus states, helper text, and footer actions.
- Added server-calculated banner states: Active, Scheduled, Expired, Canceled, and Inactive.
- Expired alerts no longer appear in the current-alert list or display as Active.
- Added a compact current-alert list and a separate recent-history section. Both lists are bounded to prevent long scrolling.
- Added Cancel Alert for immediately stopping an active or scheduled alert while retaining its history.
- Added Delete Alert for removing an alert from the manager workspace while retaining protected audit history.
- Added confirmation dialogs and clear consequences for cancel and delete actions.
- Added database fields for cancellation and deletion authorship and timestamps.
- Added audit coverage for banner lifecycle changes.
- Preserved employee-facing expiration enforcement so expired alerts cannot be delivered on Home or in the global banner.

## Production behavior

- The previously expired Welcome alert is now treated as Expired and appears only in recent history.
- Canceling an alert removes it from employee delivery immediately.
- Deleting an alert removes it from the manager workspace without erasing the audit trail.
- Editing an existing current alert keeps it in the controlled lifecycle and recalculates its effective status from server time.

## QA completed

- TypeScript type-check passed.
- Lint passed.
- Full automated suite passed: 494 tests.
- Production build passed.
- Targeted Supabase migration applied to the linked production project.
- Live database verified for lifecycle columns, lifecycle RPC, archive support, and retained expired history.

