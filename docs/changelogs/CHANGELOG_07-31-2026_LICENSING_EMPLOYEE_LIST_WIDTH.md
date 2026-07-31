# SygShift Changelog — 07/31/2026 — Licensing Employee List Width

## Summary

Expanded and cleaned up the Licensing Center employee list so employee information has proper side spacing and the Open Licensing Profile action no longer gets clipped at the right edge.

## Changes

- Increased the employee licensing table's working width so the list has enough horizontal room for all columns.
- Added more side padding and column spacing to the employee rows.
- Expanded the Action column and centered the Open Licensing Profile button inside it.
- Made the action button keep its full readable label instead of wrapping or clipping.
- Added guard coverage to preserve the wider employee list and action-column layout.

## QA

- Targeted button layout guard test will be run.
- Full lint, test, and production build will be run before deployment.
