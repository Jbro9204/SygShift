# SygShift Release — Compact Profile Photo

**Release date:** 08/27/2026  
**Production Worker version:** `940bc401-a2d4-4288-b706-19735362763d`

## My Account profile photo

- Replaced the oversized idle photo workspace with one compact profile-photo row.
- Removed the duplicate photo-selection controls and the empty oversized new-photo panel.
- Kept one clear **Change photo** or **Add photo** action beside the current profile image.
- Kept photo removal available as a separate, clearly labeled action only when a photo exists.
- Opens the crop and positioning workspace only after a user selects a new image.
- Reduced the crop workspace and preview dimensions while preserving drag, zoom, reset, save, cancel, replace, and remove functionality.
- Added responsive layouts so photo controls remain aligned and readable on smaller screens.

## Quality assurance

- Type checking passed.
- Lint passed with zero warnings.
- All 87 test files passed: 446 tests.
- Production build passed.
- Production deployment completed successfully.
