# SygSphere Upload and Inline Image Repair

Date: 10/08/2026
Status: Deployed and verified in production

## Outcome

This release repairs SygSphere file sharing and makes approved image attachments visible directly inside the chat
without making private conversation files public.

## Root cause

- SygSphere and Patrol received a signed Supabase Storage upload token but sent it to the unsigned TUS endpoint.
  Supabase therefore parsed the signed token as an ordinary authorization token and rejected it as an invalid compact
  JWS.
- A prior change sent every SygSphere file, including the 0.10 MB image in the reported failure, through the resumable
  flow even though the existing protected direct-upload route already supports normal files through 25 MB.
- Chat messages rendered only attachment controls. Images could be opened manually in the existing preview, but no
  protected thumbnail was rendered in the conversation.

## Repairs

- Signed SygSphere and Patrol resumable authorizations now use the required
  `/storage/v1/upload/resumable/sign` endpoint on the direct Supabase Storage origin.
- Files through 25 MB use the existing same-origin protected upload route again. Larger supported files continue to
  use resumable upload through 100 MB.
- The resumable browser fingerprint is versioned so a browser cannot resume a stale upload created for the former
  endpoint.
- JPEG, PNG, and WebP attachments up to 25 MB render as contained thumbnails inside their chat message.
- Inline images load only when they approach the viewport, preserving bandwidth and memory in long conversations.
- A thumbnail opens the existing full preview on click or tap. Loading, failure, retry, download, keyboard focus,
  object-URL cleanup, and compact phone layouts are retained.
- Shared Files remains a compact on-demand list instead of downloading every image in a conversation.
- The Worker now enforces the same 25 MB preview ceiling as the client for images and PDFs.

## Security boundary

- Image bytes still come from `/api/v1/sygsphere/files/:id?mode=preview` with the current bearer and shared-identity
  assurance headers.
- The Worker rechecks current conversation membership and file state before private storage is read.
- Preview responses remain private and `no-store`, with `nosniff`, sandbox CSP, same-origin resource policy, and no
  public or long-lived signed Storage URL.
- Direct uploads retain file validation, private storage, exact size and SHA-256 read-back verification, message
  attachment, and audit behavior.
- No database migration or RLS relaxation is included.

## Verification completed

- `pnpm check`: **365 passing test files / 1 skipped** and **2,041 passing tests / 1 skipped**, plus strict TypeScript,
  zero-warning app/Worker lint, production builds, and the static-asset contract.
- Focused upload, preview, access-boundary, and endpoint tests: **41/41** passed.
- SygSphere desktop/mobile browser matrix: **72/72** passed, including ordinary upload, retry, phone, small-laptop,
  high-zoom, composer, and attachment layout checks.
- Mandatory Time Clock desktop/mobile matrix: **42/42** passed.
- `git diff --check`: passed.
- Signed-in production verification opened an existing private image conversation, rendered protected thumbnails,
  opened a full image preview, and returned to the user's original conversation without creating a test message or
  uploading a test file.

## Deployment record

- Database migration: not required.
- Source revision: `7056a9f` (`fix: repair SygSphere uploads and inline images`), fast-forwarded to `origin/main`.
- Cloudflare Worker version: `c98f175c-39bf-484b-84cc-76b465b9ac9e`.
- `https://app.sygilant.us/api/v1/health`: `status=ok`, `service=sygshift`, `version=v1`.
- `https://app.sygilant.us/api/v1/ready`: `status=ready`, `ready=true`; every reported dependency check passed.
- The fallback Worker origin passed health, the live HTML exactly matched the six production entry assets, and all
  six returned HTTP 200.
