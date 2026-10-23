# Database release baseline review

Date: 10/23/2026  
Purpose: Read-only release evidence for the required-action checkpoint resilience release  
Database mutation authorized: No

## Why the release stopped

The normal SygShift production release gate compared a fresh production migration ledger with the last reviewed
format-v2 baseline and refused to upload the Worker because seven newer applied versions were present. The refusal
occurred before any production upload or promotion.

The seven versions are all owned by the separate Sygilant source tree. The reviewed owning tree was advanced from
the prior coordinated source `a6deebba38c365510399711a18e136601ea7413c` to clean `origin/main` source
`f9dc221e3281ee5c503579c13cc92e09124cc4a3`. That source contains one exact version-and-name migration file for
each newly observed ledger entry and the Sygilant release evidence for each production activation.

## Reviewed delta

| Version | Migration | Statements | Normalized source SHA-256 | Ordered ledger SHA-256 |
| --- | --- | ---: | --- | --- |
| `20261021170000` | `retained_historical_patrol_schedule_revision` | 11 | `88690d111d98756d1a3cbf2e4214590bfce244751a33211841e7e063c571df06` | `77314b0e0092fd45f896cecf2ede242c64c37a5637de644ed7ed7d43fd2a272f` |
| `20261021180000` | `historical_report_location_correction` | 13 | `e2d3539fd473835cdf445a77c2e2c1a1dff181a0b5b75ae543b312d14404abd5` | `29e1a981983c40df57f3f1aee4111cfaa69b77d87e14fac7753cde23914cdbcc` |
| `20261022143000` | `site_manager_contract_access` | 14 | `c15bc7942d0368d7b6f83a3a1a2cc85f33714d76edc52f44a4fe94e5aab6330d` | `c77ff0827697ddfada4a2f9e89f0ee719135746607e6ddbbe6def7c4781192e6` |
| `20261022181918` | `client_invitation_delivery_state` | 11 | `f007923b0f8d81e81138b94b25fdd02a5e563aebabf7e0f6a77252e5b0c8d36b` | `dde5b31ff48bd1fdd7e6a5bcb77cbff552142b388dc376aee766488ff16d3399` |
| `20261022190000` | `safe_unused_client_invitation_identity_adoption` | 11 | `f95ef4cefdb60022f5760d2e77c7e534c3961078abc90fe5def256aed6255056` | `f0ce6737f77af3fbfe806e578931cd34e777479b984f8c5c7eb4a565cb483e80` |
| `20261022202545` | `client_invitation_optional_identity_footprint_repair` | 12 | `089332541875128a99d97a40b20f96e7dbccc874d790f5ba6f3cc90afe398a79` | `4ee22bc11edd2fc9bd03509286909f271c89021ef9d6d7c426e172ecc804b51f` |
| `20261023150358` | `tracktik_incident_report_packages` | 54 | `b5fda88f497e825d86a4049335b4b2717556a4462798c90fdfefce07a5bed18a` | `1d26daab32833b3169b0b3a6b830a8aea8a280f65f46dc261383b2f35bbbd9cb` |

The source and ordered-ledger fingerprints match the production-activation evidence committed with Sygilant.
Comparison with the prior 379-entry SygShift baseline found only these seven applied-version additions and their
seven matching Sygilant owning-source additions. No previously reviewed applied version, name, statement-array
checksum, source owner, owning-source identity, or owning-source checksum changed or disappeared.

## Replacement baseline

The read-only replacement manifest is `migration-ownership-release-v2.json` in this directory. It was captured
from the production project and the two clean owning source trees and has file SHA-256
`a187412369aa7ec10752e8b52a7bcee799614c7d3ab746efa6d2f378fb249cc6`.

- Applied migrations: 386
- SygShift owning sources: 396
- Sygilant owning sources: 125
- Missing sources: 0
- Unresolved ownership decisions: 0
- Previously known timestamp differences: 20
- Previously known empty statement arrays: 18

The repository verifier accepted the new manifest against the same freshly captured ledger with no drift errors.
This review does not claim historical SQL equivalence, authorize replay, authorize a bulk migration push, or modify
the production database. The release command must still recapture the live ledger and refuse any new difference.
