# SygSphere Responsive Viewport Repair

Date: 09/22/2026
Status: Released to production

## Outcome

SygSphere now remains fully usable on phones, small laptops, short screens, and
heavily zoomed browser or operating-system displays. The conversation history
receives the available workspace height, the composer remains visible, and the
page no longer produces the large unused box beneath the chat.

## Responsive behavior

- Corrected height and overflow ownership across the SygShift shell,
  SygSphere workspace, active conversation, message history, and composer.
- Made message history the scrolling region instead of allowing the full page
  or composer to overflow the viewport.
- Expanded the focused one-column conversation layout through 760 CSS pixels,
  covering phones and high-zoom compact displays.
- Compacted nonessential surrounding chrome on short screens while preserving
  normal message text, controls, notifications, and navigation.
- Collapsed the empty typing-status row and constrained text-entry and mention
  menus to the available dynamic viewport height.
- Kept the message composer, attachment controls, voice controls, and **Send**
  action visible at constrained heights.
- Preserved safe-area spacing for mobile devices and improved the smallest
  text-size selector so **Extra large** remains readable.

## Accessibility and preservation

- The existing Normal, Large, and Extra Large SygSphere text choices remain
  available, including at narrow phone widths.
- Keyboard focus, screen-reader labels, touch controls, reduced-motion
  behavior, light mode, and dark mode are unchanged.
- No database migration was required.
- No message, attachment, voice, employee, permission, notification, schedule,
  timekeeping, payroll, or audit data was changed.
- No SygSphere action, route, authorization rule, or existing workflow was
  removed or bypassed.

## Verification

- Full `pnpm check`: 301 test files / 1,604 tests, strict TypeScript,
  zero-warning application lint, Worker build, client production build, and
  static-asset contract.
- Final SygSphere plus mandatory Time Clock browser matrix: 114/114 desktop and
  mobile Chromium checks.
- Focused Firefox constrained-viewport matrix: 9/9 checks.
- Responsive geometry and rendered layouts verified at 1024x600, 800x600,
  700x500, 683x384, 390x667, and 320x480 with Extra Large message text.
- Safari was not runtime-tested on this Windows release host; the repair uses
  standards-based flexbox, dynamic viewport units with a `100vh` fallback, and
  ordinary responsive media queries.

## Release references

- Database migration: none
- Source commit: `e5abd45`
- Cloudflare Worker version: `6f2a4ae7-3dd3-4658-9f4e-845876b4b79f`
- Rollback tag: `rollback/pre-sygsphere-responsive-viewport-repair-20260922`
- Production verification: custom-domain and Worker-origin health and readiness
  returned HTTP 200; the live SygSphere page referenced
  `index-BgyKA8yZ.js` and `index-CTK_ipML.css`, and the live stylesheet contains
  the dynamic-height and empty-typing-row repairs.
