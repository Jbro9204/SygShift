# Authenticated Cursor System and HR Role Split

## Release summary

SygShift now applies one mandatory, centrally managed custom cursor system after authentication on desktop devices with an accurate fine pointer. The former ordinary Human Resources role has also been restored as **Human Resources Employee**, separate from the elevated **Human Resources Manager** role.

## Cursor system

- Signed-in application sessions set one root `data-sygshift-cursors="active"` state from the authenticated application shell. The state is removed on sign-out and unmount, so the public login experience remains native.
- There is no employee preference or opt-out inside authenticated desktop sessions.
- Touch-only and coarse-pointer devices remain unaffected.
- Forced-colors/high-contrast environments use semantic native cursors.
- The implementation uses local SVG assets, CSS cursor URLs, and native fallbacks. It adds no JavaScript cursor follower, pointer-movement listener, animation loop, remote asset, `cursor: none`, or new dependency.
- Disabled and permission-denied controls take precedence over other cursor mappings. Native resize cursors remain preserved.

### Assets and semantic mappings

| State | Local asset | Hotspot | Native fallback | Applied to |
| --- | --- | --- | --- | --- |
| Default | `/cursors/sygshift-default.svg` | `2 1` | `default` | Noninteractive authenticated surfaces |
| Link / Action | `/cursors/sygshift-link.svg` | `10 2` | `pointer` | Enabled buttons, links, menu items, disclosure controls, and genuine actions |
| Text | `/cursors/sygshift-text.svg` | `12 13` | `text` | Editable text fields, textareas, and editable content only |
| Busy / Processing | `/cursors/sygshift-busy.svg` | `2 1` | `progress` | Explicit application and component busy states |
| Move / Drag | `/cursors/sygshift-move.svg` | `12 13` | `move` | Genuine draggable records and drag handles |
| Blocked / Not Allowed | `/cursors/sygshift-blocked.svg` | `2 1` | `not-allowed` | Disabled and permission-denied actions |

All visible artwork is contained in a 24 by 26 SVG viewport. Default, busy, and blocked use the same arrow geometry and hotspot so those state transitions do not jump.

## Human Resources role correction

- Added protected, MFA-required **Human Resources Employee** (`human_resources_employee`) as the normal HR role.
- Restored the exact original 78-permission HR bundle. Compensation, payroll, security administration, highly restricted vaults, and broader administrative authority remain excluded.
- Preserved **Human Resources Manager** (`human_resources`) as a separate protected, MFA-required role with its existing 110-permission elevated bundle.
- Moved the one employee assignment that existed before the Manager expansion back to Human Resources Employee while preserving its assignment metadata.
- Preserved every unrelated role, permission bundle, employee-role assignment, individual permission override, and permission-catalog record.
- Recorded the correction in the private audit trail.

Production verification after migration:

- Human Resources Manager: active, protected, MFA required, 110 enabled permissions, 0 assigned employees.
- Human Resources Employee: active, protected, MFA required, 78 enabled permissions, 1 assigned employee.

## Centralized files

- `src/cursors.css`
- `src/App.tsx`
- `src/components/AppShell.tsx`
- `public/cursors/sygshift-default.svg`
- `public/cursors/sygshift-link.svg`
- `public/cursors/sygshift-text.svg`
- `public/cursors/sygshift-busy.svg`
- `public/cursors/sygshift-move.svg`
- `public/cursors/sygshift-blocked.svg`
- `supabase/migrations/20260902070000_human_resources_employee_role_split.sql`
- `src/cursorSystemGuard.test.ts`
- `src/humanResourcesRoleSplitGuard.test.ts`
- `tests/e2e/cursor-system.spec.ts`
- `playwright.config.ts`

## Verification completed

- Full `pnpm check` passed: type checking, zero-warning lint, 145 test files / 702 tests, Worker build, and client build.
- Full Playwright suite passed: 60 desktop/mobile checks.
- Cursor-specific checks passed in Chrome, Microsoft Edge, and Firefox.
- Verified desktop fine-pointer behavior, mobile/coarse-pointer fallback, forced-colors fallback, enabled and disabled controls, text entry, busy states, drag handles, and permission-restricted states.
- Verified the actual-size cursor gallery on light and dark SygShift surfaces.
- Verified 100%, 125%, and 150% display scaling simulations and 100%, 125%, and 150% browser zoom.
- Native CSS fallbacks are present for browsers that reject or cannot load a custom cursor.
- Safari could not be executed on the Windows release host; the standards-based SVG cursor implementation and native fallbacks remain in place for Safari, with physical Safari validation retained as the only platform-specific follow-up.

## Production rollout

- Applied forward migration `20260902070000_human_resources_employee_role_split.sql` and reconciled only that exact migration marker.
- Pushed implementation commit `259c940` to `origin/main`.
- Deployed Cloudflare Worker version `d4792c75-e14a-4579-a984-9d04984aeaa0`.
- Primary and fallback login, health, and readiness endpoints returned `200`.
- All six production cursor assets returned `200` with `image/svg+xml` content.
- The live JavaScript contains the authenticated cursor activation trigger, and the live CSS contains the centralized cursor mappings and forced-colors safeguards.

No routes, navigation, authentication rules, employee records, timekeeping, payroll behavior, HR workflows, or unrelated permissions were changed. The only access mutation was the explicitly requested restoration of the prior ordinary HR assignment to the normal Human Resources Employee role.
