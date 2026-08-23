# SygShift Release Refresh Safeguard

**Date:** 08/23/2026  
**Production version:** `85cc3ffa-4377-4bd4-ae41-4d8101fbf647`

## Issue addressed

An already-open SygShift browser tab could continue running the previous JavaScript release after a production deployment. That made newly deployed controls—such as the Site/Post field in Add Missing Punch—appear absent even though the current production files contained them.

## Changes

- Added a same-origin release check when SygShift opens, regains focus, becomes visible, and at a controlled interval.
- Added a centered, accessible update notice when the loaded browser release no longer matches production.
- Added one clear `Refresh SygShift` action instead of silently reloading and risking unsaved work.
- Kept the notice responsive and consistently formatted on desktop and phone layouts.
- Added automated coverage for locating the current hashed production module without false positives from non-module scripts.

## Verification

- Type checking passed.
- Lint passed with no warnings.
- All `317` automated tests passed.
- Production build passed.
- Time Maintenance layout passed in desktop Chrome and mobile Chrome.
- Production `/api/v1/health` returned HTTP `200`.
- Production `/api/v1/ready` returned HTTP `200` with all readiness checks true.
- Live production assets contain both the Site/Post manual-punch workflow and the release-update safeguard.

## One-time user action

Tabs opened before this release must be hard-refreshed once. After that first refresh, future stale tabs will display the update notice automatically.
