# Main Release Governance and Candidate Safety

Date: 10/20/2026
Scope: SygShift repository release controls and CI workflow only
Production deployment: None
Database migration: None

## Outcome

SygShift now has a source-controlled main-branch candidate gate that verifies the exact code being pushed before Git accepts a main update. This safety work changes release behavior only; it does not alter application features, employee data, schedules, timekeeping, payroll, SygSphere, Cloudflare bindings, or production configuration.

## Controls added

- Added the tracked executable `.githooks/pre-push` entry point and `pnpm setup:git-hooks`.
- Added `tools/main-release-gate.mjs`, which accepts only a checked-out `main` or `HEAD:main` update to the canonical `origin` target, verifies a clean fast-forward candidate, and uses both checkout-local and cross-clone token-owned locks.
- The gate creates a detached exact-SHA worktree, performs a frozen install and production dependency audit, runs the complete shared release verification, rechecks local source, remote tip, candidate cleanliness, and active Actions state before Git can push.
- Active-run validation is workflow-specific and push-specific: it blocks an earlier active `main` push run for `security.yml`, fails closed on malformed or unreadable status data, and uses bounded pagination rather than allowing a crowded Actions history to hide active work. Workflow concurrency separately serializes push, scheduled, and manual runs for the same ref.
- Candidate commands use an explicit toolchain and OS allowlist with isolated temporary runtime locations. This reduces accidental credential exposure; it is not a security sandbox for files the invoking user may read.
- Interrupted verification is fail-closed. If process termination or cleanup cannot be confirmed, the gate records token-owned lock quarantine metadata and preserves only the exact controlled candidate paths needed for recovery. If Git for Windows has already removed the worktree registration but reports a partial filesystem cleanup failure, the gate verifies that unregistered state before using its guarded, long-path-capable controlled-root remover.
- Added `pnpm release:verify`: `pnpm check`, the mandatory standalone Time Clock browser workflow, and a fresh production build. The focused runner owns one temporary loopback Vite fixture, checks its expected page marker, runs both desktop and mobile Chromium projects, and fails closed if startup, browser execution, termination, or cleanup cannot be confirmed. The repository-controlled Vitest wrapper uses only `.work/test-runtime/<unique-run>` and refuses to delete paths outside that controlled root.
- Updated CI to use reviewed immutable action commits, `ubuntu-24.04`, non-canceling ref concurrency, exact checked-out-SHA and hook-mode verification, locked dependencies, Chromium installation, production dependency audit, and the shared complete candidate gate.

## Promotion-race repair

The normal Worker candidate-release path already required a clean `HEAD == origin/main` before candidate upload. It now repeats the exact source check after candidate validation and immediately before production promotion. If `origin/main` moves during candidate validation, the uploaded candidate is not promoted.

## Verification before push

- The complete local `pnpm release:verify` passed strict TypeScript, zero-warning lint, 378 passing Vitest files plus one intentional skip, and 2,204 passing application tests plus one intentional skip.
- `pnpm release:test` passed all 174 release-governance checks, including hook discovery, remote-target validation, active-run pagination, lock ownership and recovery, process-tree termination, controlled cleanup, production-promotion race protection, and exact toolchain validation. Static release-discipline validation also passed.
- The mandatory standalone Time Clock browser workflow passed all 42 unchanged checks: 21 desktop Chromium and 21 mobile Chromium. Both production builds and both static-asset contract checks passed, including the fresh rebuild after browser verification.
- The committed candidate runs this same complete verification again through the versioned pre-push gate. Its exact commit SHA and GitHub Actions URL are recorded in the release handoff so this changelog can remain part of the one candidate commit rather than requiring a follow-up documentation-only push.

## Remaining external control

GitHub API evidence confirmed that `main` is currently unprotected: the branch-protection endpoint returned `404 Branch not protected`. This change intentionally does not impose a PR-only workflow without owner approval. A GitHub owner must still configure server-side required checks, force-push and deletion protection, direct-update and bypass policy, and current-branch or merge enforcement. The local hook and workflow fail closed where they can, but they are defense in depth rather than a claim that server-side GitHub policy is already configured.
