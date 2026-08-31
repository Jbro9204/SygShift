# Sidebar Collapse and Backlog Cleanup

Date: 08/31/2026

## Summary

The desktop navigation collapse control was moved out of the logo area and rebuilt as a clear, accessible control attached to the outer sidebar edge. Completed work was also removed from the active future-items list so that the planning document contains only unfinished work.

## Changes

- Moved the desktop collapse/expand control to the sidebar edge so it is no longer clipped or lost inside the brand header.
- Increased the interaction target to 44 by 44 pixels and applied the established SygShift gold treatment, border, shadow, hover, active, and keyboard-focus states.
- Preserved the existing collapse preference without changing the active route or resetting page state.
- Kept the desktop control out of the mobile layout, which continues to use the existing mobile navigation controls.
- Preserved dynamic accessible labels and tooltips for **Collapse navigation** and **Expand navigation**.
- Removed the completed **Canonical My Time and Review Queue Navigation** and **Accessible Sidebar Collapse Control** entries from the active future-items list.
- Updated the FIDO2 pilot entry to record Jordan Brown's enrolled physical key while retaining the remaining browser, fallback, revocation, and recovery validation work.

## Validation

- Added a regression test for the control's size, placement, accessible labeling, and mobile exclusion.
- Ran the focused navigation regression suite successfully.
- Full project validation and production health checks are required before release completion.
