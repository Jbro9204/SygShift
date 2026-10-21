# Database release baseline review

The guarded viewer-system-time release discovered that production had one applied
migration newer than the preserved October 19 overnight baseline. The release
stopped before deployment, as designed.

The replacement format-v2 baseline was captured read-only from the reviewed
production project at `2026-10-21T14:16:06.748Z` and compared with the preserved
baseline. The comparison found exactly one expected delta:

- Applied migration `20261020134522_incident_report_direct_capture` was added.
- Its owning source is the committed Sygilant file
  `20261020134522_incident_report_direct_capture.sql` from Sygilant commit
  `703391094995f3ace0a0486a3e586c4d6057c5e8`.
- The migration has an exact version/name source match and a captured 27-statement
  array.
- No prior applied entry was removed or changed.
- No prior owning source was removed or changed.

The new manifest contains 377 applied migrations, 396 SygShift sources, and 116
Sygilant sources. It has no missing sources and no unresolved ownership decisions.
Its SHA-256 is
`b8d28bd8619091ab564466d63a594eb19f5adaec2c394362727e16906af55f23`.

This evidence does not authorize migration replay, bulk migration push, or any
production database mutation. The prior baseline remains preserved unchanged.
