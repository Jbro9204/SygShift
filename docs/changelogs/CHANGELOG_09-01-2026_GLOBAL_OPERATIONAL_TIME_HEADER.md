# Global Operational Time Header

Date: 09/01/2026
Status: Released to production

## Outcome

The authenticated SygShift shell now presents one clean, responsive operational-time header across every workspace. It preserves the existing utility/account row, adds a shared four-zone clock row, and positions the existing alert bar beneath the clocks with deliberate cushioning on every side.

## Existing systems reused

- `AppShell` remains the only authenticated application shell and header owner.
- `WorkspaceAlertStrip` remains the only rotating global alert presentation.
- The existing maintenance-status query supplies the server timestamp used to anchor the display clock and continues its existing 30-second refresh cycle.
- Existing account photo, employee identity, My Account, Sign Out, sidebar, internal Back/Home navigation, inactivity controls, MFA checkpoint, maintenance notices, deployment behavior, and service status are unchanged.

## Clock behavior

- Clocks appear in Eastern, Central, Mountain, and Pacific order.
- Each clock includes an analog face, hour/minute/second hands, digital time, dynamic abbreviation, and the calendar date calculated in that zone.
- IANA zones are `America/New_York`, `America/Chicago`, `America/Denver`, and `America/Los_Angeles`; no permanent EST/CST/MST/PST labels or hardcoded UTC offsets are used.
- Mountain uses a restrained gold treatment and an explicit **Operational default** label.
- One timer updates all clocks. It is cleaned up on unmount and resynchronizes whenever the existing server timestamp refreshes.
- Cached formatters avoid recreating `Intl.DateTimeFormat` instances each second.
- The compact formatter hides duplicate military time for `01:xx–12:xx` and shows it only for `00:xx` and `13:xx–23:xx`.
- Header time remains informational. It cannot authorize or record punches, payroll, patrol hits, or other secured events.

## Alert presentation

- The existing alert bar now appears below the clocks with a 12–14 pixel separation and inset outer margins.
- The alert keeps its permissions, severity, icon, count, destination action, query refreshes, and nine-second rotation between multiple entries.
- Longer text wraps immediately rather than being clipped or requiring a drifting ticker.
- The alert and clocks remain in normal document flow and push page content downward without absolute positioning or overlap.

## Responsive and accessibility behavior

- Four clocks remain in one row at 1920, 1440, 1280, and 1024 pixels with either expanded or collapsed navigation.
- The clock row becomes a two-by-two grid at 768, 390, and 320 pixels.
- My Account, Sign Out, the mobile menu, all four clocks, alert count, and alert action remain visible and usable.
- Analog faces are decorative because equivalent digital information is present.
- The clock region and every zone have concise accessible labels and do not announce updates every second.
- Reduced-motion mode hides the decorative second hand while preserving all digital time and date information.

## Verification

- Exact compact-time tests cover 09:41, 10:15, 12:20, 13:00, 16:35, 23:59, and 00:10.
- Daylight and standard abbreviations are tested for all four zones.
- Eastern/Pacific calendar-date rollover is tested.
- Timer synchronization and cleanup are tested.
- Type checking passed.
- Lint passed with zero warnings.
- 132 test files and 653 tests passed.
- Worker and client production builds passed.
- All 32 Playwright browser tests passed across desktop and mobile projects.
- Required responsive widths, expanded/collapsed sidebar states, alert wrapping, reduced motion, horizontal containment, and automated accessibility analysis passed.
- Wrangler 4.106.0 dry run and production deployment passed.
- Deployed Cloudflare Worker version: `f786e0dd-6337-48ab-9bdf-5bd0ffffafdf`.
- Production app, login, health, readiness, main script, and stylesheet returned HTTP 200.
- The live production bundle contains all four IANA zones, the Mountain operational-default label, the shared clock region, responsive grid styling, inset alert styling, and reduced-motion treatment.
