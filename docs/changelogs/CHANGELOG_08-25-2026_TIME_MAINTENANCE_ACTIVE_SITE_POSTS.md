# SygShift Change Log — Time Maintenance Active Site/Posts

Date: 08/25/2026

## Purpose

Ensure supervisors can select a valid operational Site/Post, including Neon Local, when recording or correcting employee time even if no schedule occurrence exists for the selected workday.

## Root Cause

The Time Maintenance Site/Post menu was populated only from schedule occurrences on the selected workday. A valid location disappeared whenever that date did not already contain a matching scheduled shift, even though the Site/Post remained active in SygShift.

## Changes

- Added a protected active Site/Post data source for Time Maintenance.
- Kept assigned and other scheduled shifts at the top of the menu because those choices create a direct schedule link.
- Added every remaining active Site/Post in a clearly labeled secondary group.
- Applied the same complete location list to both Add Missing Punch and Correct Site/Post.
- Saved a selected active Site/Post as a canonical audited location when no matching shift exists.
- Preserved the manual Other location option for verified work performed outside the configured Site/Post directory.
- Kept inactive Sites and Posts out of time-entry choices.
- Protected the new database function with MFA and the existing `time.manage` permission.

## Operator Experience

The Site/Post menu now shows scheduled choices first and all other active Site/Posts afterward. Neon Local no longer depends on already having a shift on Sunday before it can be selected for Michael V.'s punch.

## Quality Assurance

- Type checking passed.
- Lint passed with warnings denied.
- 375 automated tests passed.
- Production build passed.
- Added regression coverage for active Site/Post loading, Neon Local availability, permission enforcement, and inactive-record filtering.

