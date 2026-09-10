# SygSphere Name Mentions and Alert Reliability

**Date:** 09/10/2026  
**Status:** Database released; application release verification in progress

## Problem and user impact

SygSphere required employees to choose or type account usernames such as `@mhood` instead of the names people actually use. The launcher also suppressed a new-message toast and sound when the recipient already had that conversation open or when its read state reached zero before the launcher processed the new message. The same 30-second age cutoff could discard a legitimate arrival delivered by the polling fallback after a brief delay.

## Root cause

- Structured mentions preserved the correct employee UUID, but their visible token and database validation were coupled to the employee username.
- The launcher treated an open conversation and a zero unread count as evidence that no alert was needed. Those are read-state signals, not proof that the new message had already been announced.
- A message timestamp cutoff duplicated the launcher's existing first-load suppression and introduced a false-negative window.

## Changes

- Added forward migration `20260910163434_sygsphere_human_name_mentions.sql` (SHA-256 `A6F3CC794BE23679CCC36CC0CCFAF8111E2309384150DAD6C40E37FFCA189AA1`).
- Added a server-controlled display label to structured mentions while retaining the employee UUID as the authoritative identity.
- Added legal-first, preferred-name, legal-full-name, and displayed-name aliases. A short name is accepted only when it identifies exactly one active participant in that conversation; duplicate names fall back to a full human name.
- Kept username tokens as a temporary compatibility path for browser tabs already open during deployment and for historical messages. The new interface neither inserts nor displays usernames as the default tag.
- Typing `@Michelle` now resolves the unique employee directly. The rounded picker filters by human names, displays the employee photo/name/role, and shows the readable tag it will insert.
- Updated draft preservation, retry, Enter-to-send, Shift+Enter, rendering, and fixture behavior to retain the selected employee identity and human-readable label.
- Changed SygSphere alerting to announce each newly observed incoming message ID even while that conversation is open, after its unread count reaches zero, or after a short delivery delay.
- Preserved own-message suppression, conversation mute, per-account SygSphere sound choice, global mute/volume, mention-specific wording, cross-tab deduplication, Realtime invalidation, and the polling fallback.

## Security and preservation

- The browser submits selected employee IDs; the database independently verifies active membership and that the message contains a unique permitted human-name token.
- Private alias and token-matching functions are revoked from `public`, `anon`, and `authenticated`.
- Existing mention rows were backfilled with their prior username token so old messages continue to render. No message body, conversation, participant, read receipt, account, role, permission, schedule, shift, punch, ticket, HR, payroll, or document record was changed.
- The database migration applied atomically from an isolated remote-history workdir that previewed exactly one migration.
- Production migration history contains version `20260910163434`. Database lint reported no finding for the functions changed here; its nonzero overall result is from older unrelated HR, licensing, import, and patrol findings.

## Verification

- Focused SygSphere data and launcher suite: 2 files / 20 tests passed.
- Complete application gate: TypeScript passed, application lint passed with zero warnings, 231 test files / 1,196 tests passed, and both production builds passed.
- SygSphere and mandatory Time Clock browser matrix: 90/90 passed across desktop and mobile. This covered direct typed-name resolution, picker insertion, targeted mention delivery, live two-account delivery, sounds, mobile/small-screen layouts, drafts/retries, threads, attachments, and the complete Time Clock workflow including Early Clock-In and clock-in/break/clock-out controls.
- Added `supabase/tests/sygsphere_human_name_mentions_regression.sql` for transactional database contract verification.

## Release record

- Pre-release fallback tag: `rollback/pre-sygsphere-name-mentions-alert-reliability-20260910` at `26f4eda`.
- Source commit: pending final release commit.
- Cloudflare Worker: pending deployment.
- Production health/readiness and live asset verification: pending deployment.

## Remaining limitation

Audible playback still follows browser autoplay policy. SygShift preloads/unlocks the approved SygSphere sound after interaction and presents an explicit **Enable SygSphere sounds** recovery control if the browser blocks playback. Background operating-system notifications while every SygShift tab is closed remain a separate Web Push capability.
