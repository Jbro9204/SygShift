# SygSphere Communications — Usage and Outcome Boundary

**Date:** September 19, 2026  
**Status:** Source prepared; release gates remain closed.

- Added a protected Communications usage response shape. It reports the UTC billing period, 1,000 decimal-GB allowance, $0.05/GB projection, remaining allowance, reconciliation timing, and truthful telemetry status.
- Missing usage data remains `unavailable`; it is never substituted with zero.
- Command outcomes now return the caller's command ID plus a newly generated correlation ID, without provider credentials, raw errors, tenant data, or employee details.
- Heartbeats receive a correlation-safe acknowledgement. Resume/snapshot requests fail safely as unavailable until the server-owned room snapshot exists; a browser-provided room reference can never recreate an active call.
- A protected authorization-refresh path re-reads the server authorization context and can update only the matching active socket for the same actor and tenant. It cannot move a connection between accounts or tenants.
- The initial route-only cookie now lasts 90 seconds, covering the first 45-second refresh. Every successful refresh renews that same opaque route reference for another bounded 90-second window. The raw one-use ticket remains separate and expires after 30 seconds.
- The usage endpoint remains behind the false Communications runtime gate and requires the dedicated read permission if/when the gate is later approved.
