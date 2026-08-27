# Sites & Posts Directory Redesign

Date: 08/27/2026

## Outcome

Sites & Posts is now a compact, full-width operational directory that is easier to scan and manage on desktop, tablet, and mobile. The release reorganizes the existing site and post tools without changing operational records, scheduling relationships, permissions, validation rules, deletion safeguards, or retained history.

## Directory workspace

- Added a compact header with a clearly separated **Add Site** action.
- Added one search field covering site names, post names, codes, cities, and addresses.
- Added **All**, **Active**, and **Inactive** status filters.
- Added a focused **Recently Deleted** view in the directory toolbar.
- Replaced large site cards with compact rows showing identity, address or review state, coverage, status, post count, and a Manage action.
- Limited the directory to one expanded site at a time so long site lists remain readable.
- Added keyboard-accessible expand and collapse controls with explicit accessible state and labels.

## Site and post workspaces

- Expanded site rows now show the existing site information and a compact list of posts without moving users to a separate page.
- Added clear **Edit Site** and **Add Post** actions inside the expanded site workspace.
- Kept new posts permanently tied to the selected parent site throughout creation.
- Reorganized post rows to show coverage time, armed requirement, active status, and focused Edit and Delete actions.
- Displayed default post times in civilian and military formats; posts without default hours clearly state that time is set per shift.
- Kept destructive actions inside the site management workspace instead of placing delete controls in the primary directory row.

## Responsive and interface quality

- Added desktop, tablet, and mobile layouts without horizontal page scrolling.
- Preserved readable location, status, coverage, and management information on narrow screens.
- Standardized spacing, control heights, button alignment, field groups, status chips, typography, and dialog presentation with the existing SygShift design system.

## Security and data safeguards

- Existing `sites.manage` authorization remains authoritative for every write action.
- Existing API calls, validation rules, and cache refresh behavior remain unchanged.
- Existing site and post deletion safeguards remain unchanged; referenced operational records cannot be deleted.
- Existing audit logging and 14-day deleted-record metadata retention remain unchanged.
- No site, post, schedule, event, credential, or retained-history record was modified by this interface release.
- No database migration was required.

## Validation

- Added 10 focused Sites & Posts tests covering filtering, status views, accessible expansion, one-site-at-a-time behavior, site creation, post creation, parent-site locking, permissions, protected deletion, unused-record deletion, and retained deletion metadata.
- Type checking passed.
- Linting passed with zero warnings.
- All 86 automated test files passed: 437 tests.
- Production build passed.
- Cloudflare deployment packaging and dry-run validation passed with expected bindings intact.
- Production Worker startup completed in 6 ms.
- Production health and readiness checks returned HTTP 200 on the primary and fallback domains; all readiness checks passed.
- The unsigned browser correctly remained at the secure sign-in boundary; authenticated production access was not bypassed with stored or shared credentials.

## Production

- Primary application: https://app.sygilant.us/sites
- Worker fallback: https://sygshift.sygilant.workers.dev/sites
- Production version: `7c1e4ee0-9ba0-4b61-8302-ed42ace44679`
