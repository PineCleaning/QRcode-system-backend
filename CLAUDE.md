# Backend — QR Feedback System (NestJS)

This is the **backend repo** for the QR Feedback System. It is its own git repository, separate from the frontend repo (`../QRcode-system-frontend`). See `../../CLAUDE.md` (root) for the full business context, requirements, and day-by-day project plan.

**Tech stack locked 2026-07-23** — this replaces an earlier FastAPI/Python draft. Do not scaffold or suggest Python/FastAPI code here.

**Scope change (2026-07-23): no n8n.** ClickUp delivery is a single direct API call — there is no parallel webhook path. Do not build any n8n integration or `N8N_WEBHOOK_URL` handling.

**DB schema locked at v1.5 (2026-07-24)** — see `../../CLAUDE.md` Section 7 for the full ERD/enums. Key additions vs. the original design: `clickup_connections` (encrypted OAuth token storage), `integration_jobs` (delivery retry engine, replaces a single status column), `idempotency_key` on feedback. `csv_upload_*` tables are renamed `csv_import_*`. The `feedback_submissions` text field is `feedback` (user override — the source SQL file names it `message`, do not use that name). **`client_site_status` is 2-state (`ACTIVE`/`INACTIVE`)** — a proposed `ARCHIVED` third state was dropped 2026-07-24, don't add it back.

## Tech Stack
- **Framework:** NestJS + TypeScript
- **ORM:** Prisma 7 (rust-free — WASM query engine + `@prisma/adapter-pg` driver adapter, `moduleFormat = "cjs"` in the generator block to match this project's CommonJS build)
- **Database & Auth:** Supabase PostgreSQL (via Prisma) + Supabase Auth
- **Media storage:** Cloudinary
- **CRM:** ClickUp OAuth + direct API integration only
- **Deployment:** Railway

## ⚠️ Known environment issue: Prisma CLI blocked on this machine
This machine's **Windows Smart App Control** policy blocks Prisma's native `schema-engine-windows.exe` from running — confirmed via Windows Event Viewer (`Microsoft-Windows-CodeIntegrity/Operational`, Code Integrity policy violation). This means **`prisma migrate dev`, `prisma migrate deploy`, `prisma db push`, and `prisma db pull` do not work on this machine.** `prisma generate` and `prisma validate` are unaffected (they don't need the schema-engine binary), and neither is Prisma Client at runtime (Prisma 7's query engine is WASM/TS, not a native binary).

**Until this is resolved** (disabling Smart App Control, or moving dev to WSL/another machine), apply schema changes this way:
1. Hand-write the DDL in a new `prisma/migrations/<timestamp>_<name>/migration.sql` file (matching what `prisma migrate dev` would have generated from the `schema.prisma` diff).
2. Run `node scripts/apply-baseline-migration.js <timestamp>_<name>` — this applies the SQL via `pg` (pure JS, unaffected by Smart App Control) and records the migration in `_prisma_migrations` with the correct SHA-256 checksum, so a real `prisma migrate deploy` later (e.g. on Railway, which is Linux) sees it as already applied and doesn't try to re-run it.
3. Update `prisma/schema.prisma` to match, then `prisma generate`.

This workaround was used for the initial `20260724142555_init_schema_v1_5` migration. If Smart App Control gets resolved on this machine, switch back to normal `prisma migrate dev` for all subsequent schema changes.

## Auth (Day 1 Hr 5 — implemented 2026-07-24)
- `PrismaModule`/`PrismaService` (`src/prisma/`) — global module wrapping `PrismaClient` with the `@prisma/adapter-pg` driver adapter.
- `SupabaseModule`/`SupabaseService` (`src/supabase/`) — global module wrapping a `supabase-js` client built from `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (service role — server-only).
- `SupabaseAuthGuard` (`src/auth/supabase-auth.guard.ts`) — verifies the `Authorization: Bearer <token>` header by calling `supabase.auth.getUser(token)` (network call to Supabase Auth, not local JWT verification — chosen for simplicity over local JWKS/secret verification at this app's scale). On success, looks up the corresponding `admin_users` row by id and requires `status = 'ACTIVE'`; a valid Supabase session alone is **not** sufficient — the user must also exist in `admin_users`. Throws `UnauthorizedException` otherwise.
- `@CurrentAdmin()` param decorator (`src/auth/current-admin.decorator.ts`) pulls the resolved `AdminUser` off the request inside a guarded route.
- `GET /auth/me` (`src/auth/auth.controller.ts`) — reference protected endpoint, returns the current admin. Apply `@UseGuards(SupabaseAuthGuard)` to any route that needs admin auth.
- Verified end-to-end 2026-07-24: rejects missing/invalid tokens (401), accepts a real Supabase Auth session for a user with a matching active `admin_users` row (200).

## ClickUp Structure Mapping (Open Decision #3 — resolved 2026-07-24)

Confirmed against the client's real ClickUp workspace. Full detail also in `../../CLAUDE.md` Section 7.

- Feedback → **Task in one shared `TICKETS` List**. No per-client List/Folder.
- Client → **existing record in a `COMPANIES` List** (under a `CUSTOMERS` space). The portal creates/updates Company task records, never the List/Space itself.
- Ticket-to-Company link: a **pre-existing Relationship custom field** (`CLIENT NAME`) on the `TICKETS` list. ClickUp's API can't create custom fields — fetch its `field_id` once via `GET /list/{list_id}/field` and cache it in `clickup_connections.client_field_id`.
- **Site has no ClickUp structure yet** — no Sites list exists. Represent it as plain text on the ticket (e.g. task title/description: "Client Name — Site Name"). `sites.clickup_entity_id` and `clickup_connections.site_field_id` stay unused/null — reserved for later, don't populate them now.
- Config (`tickets_list_id`, `companies_list_id`, `client_field_id`, `site_field_id`) lives on `clickup_connections` — one-time per-workspace, not per-row.
- **Company record writes are partial-write only** — the portal writes just its own fields (name, contact email, contact phone, status-equivalent) when creating/updating a Company task. Never touch other fields on that record (Facility Type, Cleaning Frequency, Date Quote Accepted, Upcoming Tasks, etc.) — those belong to the client's own team and must survive a portal sync untouched.
- **Never create ClickUp Lists, Folders, Spaces, or custom fields programmatically** — the integration is read/write against structure that already exists, full stop.

## ClickUp Integration Module (Day 1 Hr 6 — implemented 2026-07-24, awaiting real credentials)

Built end-to-end but **not yet live-tested against real ClickUp** — the user doesn't have `CLICKUP_CLIENT_ID`/`CLICKUP_CLIENT_SECRET` yet. Everything is designed to start working the moment those (and the two List IDs) are supplied, with **no code changes needed** — see "How this activates" below.

- `src/clickup/clickup-crypto.util.ts` — AES-256-GCM encrypt/decrypt for the ClickUp access token, keyed by `CLICKUP_TOKEN_ENCRYPTION_KEY` (already generated and set in `.env` — this one doesn't depend on ClickUp at all).
- `src/clickup/clickup-api.client.ts` (`ClickupApiClient`) — thin wrapper over the raw ClickUp v2 REST API (`fetch`-based). No business logic. Note: ClickUp expects the raw access token in the `Authorization` header with **no `Bearer` prefix** — this is a ClickUp-specific quirk, not a bug if it looks unusual.
- `src/clickup/clickup-connection.service.ts` (`ClickupConnectionService`) — owns the `clickup_connections` row: encrypts/decrypts the token, upserts the connection, caches list/field config, and signs/verifies the OAuth `state` param via HMAC (keyed by the same encryption key) instead of a server-side session store — stateless, no extra infra.
- `src/clickup/clickup.service.ts` (`ClickupService`) — domain-level `createCompany`/`updateCompany`. **Design choice:** contact email/phone are written into the Company task's native `description` field (not custom fields), and our `ACTIVE`/`INACTIVE` maps to ClickUp's native task `status` (names configurable via `CLICKUP_COMPANY_STATUS_ACTIVE`/`CLICKUP_COMPANY_STATUS_INACTIVE` env vars, default `"active"`/`"inactive"`). This was a deliberate simplification to avoid needing more `clickup_connections` columns for extra custom-field IDs, and it has a nice side effect: since custom fields are never included in the update payload at all, it's structurally impossible for this service to accidentally overwrite a custom field it doesn't own (Facility Type, Cleaning Frequency, etc.).
- `src/clickup/clickup.controller.ts` — 4 endpoints:
  - `GET /clickup/oauth/authorize` (admin-guarded) — returns the ClickUp authorize URL.
  - `GET /clickup/oauth/callback` (public — ClickUp calls this directly; the signed `state` is the actual auth check) — exchanges the code, fetches the authorized workspace, stores the encrypted connection.
  - `POST /clickup/setup` (admin-guarded, body `{ ticketsListId, companiesListId, clientFieldName? }`) — one-time step after connecting: fetches the `TICKETS` list's fields, finds the one named `clientFieldName` (default `"CLIENT NAME"`), caches its `field_id`. Read-only against ClickUp — never creates anything.
  - `GET /clickup/status` (admin-guarded) — debug/verification endpoint: connection + config state.

**How this activates once real values exist:**
1. Get a ClickUp OAuth app (Client ID/Secret) → set `CLICKUP_CLIENT_ID`/`CLICKUP_CLIENT_SECRET` in `.env`.
2. Sign in as the test admin (or any admin), call `GET /clickup/oauth/authorize`, open the returned `url` in a browser, approve access.
3. Find the `TICKETS` and `COMPANIES` list IDs in ClickUp (open each list, copy the ID from the URL after `/li/`), call `POST /clickup/setup` with them.
4. `GET /clickup/status` should show `configured: true`. `ClickupService.createCompany`/`updateCompany` are then usable by the Clients API (Day 1 Hr 7, not yet built).

Verified 2026-07-24 (without real ClickUp credentials, since none exist yet): app boots with all 4 routes mapped; `/clickup/status` correctly reports `{connected: false}`; `/clickup/oauth/authorize` returns a correctly-shaped URL (with an empty `client_id` right now, which will just work once the env var is set); `/clickup/oauth/callback` correctly rejects invalid/missing `state`; `/clickup/setup` correctly 404s when no connection exists yet.

## Clients API (Day 1 Hr 7 — implemented 2026-07-25)

`src/clients/` — full CRUD, admin-guarded (`@UseGuards(SupabaseAuthGuard)` on the whole controller):
- `POST /clients` — `clientCode` (immutable, lowercase alphanumeric+hyphen, validated via regex), `name`, optional `contactEmail`/`contactPhone`. Duplicate `clientCode` → `409 Conflict` (caught from Prisma's `P2002`).
- `GET /clients` — list, newest first, each row includes `_count.sites`.
- `GET /clients/:id` — 404s via `NotFoundException` if missing.
- `PUT /clients/:id` — `UpdateClientDto` deliberately has **no `clientCode` field at all** (not just ignored — it's not a property on the DTO), and the global `ValidationPipe`'s `whitelist: true` strips any extra property before it reaches the service, so a client can never rename its own `clientCode` through this endpoint even if a caller tries.
- `DELETE /clients/:id` — **hard delete**, `204` on success. Relies on the DB's own cascade rules: deleting a client cascades to its sites, but a site with feedback history is `ON DELETE RESTRICT` — so the whole delete fails atomically (caught as Prisma's `P2003`, surfaced as `409 Conflict` telling the caller to deactivate instead). No separate "soft delete" endpoint — deactivating is just `PUT` with `{ status: "INACTIVE" }`.

**ClickUp sync is non-blocking**, per explicit decision: every create/update attempts a sync to the matching Company record, but a ClickUp failure (or ClickUp not being connected/configured at all, which is the current state) is caught, logged via `Logger.warn`, and never fails the request. A client created while ClickUp is disconnected has `clickupEntityId: null`; the **next** update to that client automatically retries the sync as a create (self-healing — no separate "retry sync" endpoint needed). Verified 2026-07-25 with ClickUp still unconnected: create/list/get/update/delete/validation/duplicate/404/401 all behave correctly, and the server log shows the expected `ClickUp sync failed for client ...: No ClickUp connection found` warning without affecting the API response.

## Sites API (Day 1 Hr 8 — implemented 2026-07-25)

`src/sites/` — full CRUD, admin-guarded, no ClickUp sync (sites have no structured ClickUp counterpart yet, per the ClickUp Structure Mapping above):
- `POST /clients/:clientId/sites` — body is just `siteName` + optional `address`. `siteCode` and `slug` are **system-generated, never accepted from the client** — matches the Core User Flows doc's "The system creates a permanent site slug" (not the admin typing one in). 404s if `clientId` doesn't exist.
- `GET /clients/:clientId/sites` — list sites for a client, ordered by `siteCode` ascending. 404s if the client doesn't exist.
- `GET /sites/:id` / `PUT /sites/:id` / `DELETE /sites/:id` — flat, don't need the client in the URL since the site's own id is sufficient.
- `PUT /sites/:id` — `siteName`, `address`, `status` only. Like `clientCode`, `siteCode`/`slug` are absent from `UpdateSiteDto` entirely and stripped by `ValidationPipe`'s whitelist if a caller tries to sneak them in — verified 2026-07-25 by attempting exactly that.
- `DELETE /sites/:id` — hard delete, same DB-cascade-driven pattern as Clients: `ON DELETE RESTRICT` from `feedback_submissions.site_id` blocks deletion of a site with feedback history, surfaced as `409 Conflict`.

**`site_code` generation:** next sequential number for that client, zero-padded to at least 2 digits (`"01"`, `"02"`, ... `"100"`). Computed by fetching all existing `site_code`s for the client and taking the numeric max **in application code**, not via `ORDER BY site_code DESC` — lexicographic string ordering breaks past 99 (`"100"` sorts before `"99"` as a string), and a single client could plausibly reach 100+ sites eventually. `slug` is `{client_code}-{site_code}`. On a unique-constraint race (two concurrent creates for the same client), the create is retried up to 5 times with a freshly recomputed `site_code` rather than failing — cheap insurance given creation is a rare, low-concurrency admin action, not a hot path.

Verified 2026-07-25 against the live Supabase project: sequential slugs (`seveneleven-01`, `-02`, `-03`) generated correctly across multiple sites under one client, 404 on a nonexistent client, list/get/update/delete all correct, and an update payload trying to override `slug`/`siteCode` was silently stripped rather than applied.

## QR Generation (Day 2 Hr 1–3 — implemented 2026-07-25)

`src/qr/qr.service.ts` (`QrService`) + `GET /sites/:id/qr?format=png|pdf&size=A4|A5` on `SitesController` (admin-guarded). QR codes are generated **on demand from the site's slug** — nothing is cached or stored; there's no `qr_code_url` column in v1.5 (unlike the earlier draft schema).

- **PNG only, deliberately no JPG** even though the roadmap says "PNG/JPG": JPEG's lossy compression can introduce artifacts that make a QR code fail to scan, so offering it would be strictly worse with no upside. PNG generation uses the `qrcode` package (pure JS, no native binary — safe given this machine's Smart App Control history).
- **PDF** uses `pdfkit` (also pure JS). Page size is literally `'A4'`/`'A5'` via pdfkit's built-in support — no manual mm/pt math. Layout is deliberately minimal per "card/sticker design is not in scope, only the raw QR file": QR code centered, with client name / site name / slug printed below as a small caption purely so printed sheets stay identifiable when handling many of them — not a designed card.
- **Target URL**: `{BASE_DOMAIN}/{slug}`. `BASE_DOMAIN` is empty right now (Open Decision #7, domain routing, is still unresolved) — `QrService.buildTargetUrl` falls back to `http://localhost:3000` when unset, so QR generation and testing both work today. **This is a real risk to flag**: once `BASE_DOMAIN` is set and QR codes are actually printed, changing it again means every printed QR breaks (same warning already in the root doc's Open Decision #7 and Notes/Risks). Lock the domain before any real printing happens.
- **A pdfkit/TypeScript gotcha worth knowing about**: `@types/pdfkit` mistypes the module's export as a `PDFDocument` *instance* rather than the constructor, even though the real CommonJS export is the class. `import * as PDFDocument from 'pdfkit'` type-checks fine but throws `TypeError: PDFDocument is not a constructor` at runtime (hit and fixed during this hour). Fixed via `import PDFDocument = require('pdfkit')`, which bypasses the ESM-interop wrapping and gets the raw export. If pdfkit code ever needs touching again, don't "fix" this back to a normal `import` statement — it will silently reintroduce the runtime bug despite compiling cleanly.

Verified 2026-07-25 against a live client+site: PNG downloads correctly (visually confirmed — a clean, well-formed QR), PDF downloads correctly at both A4 and A5 (valid single-page PDFs), invalid `format` values rejected with 400, nonexistent site 404s, unauthenticated requests 401.

## Cloudinary Direct-Upload Signing (Day 2 Hr 5 — implemented 2026-07-25, live-verified)

`src/cloudinary/` — implements the resolved Open Decision #6 (direct signed upload, confirmed 2026-07-25 from the Core User Flows doc: "Media uploads directly to Cloudinary with visible progress"). Built with the same self-activating pattern as ClickUp, but this one is now **fully live-verified** — the user created a real (temporary, personal) Cloudinary account specifically so this could be tested end-to-end rather than just structurally, ahead of swapping in the client's real Cloudinary account later. Swapping accounts later is just three env var values changing — nothing else to touch.

- **`CloudinaryService.generateSignedUploadParams(folder?)`** — signs upload params (`timestamp` + optional `folder`) using the Cloudinary SDK's `utils.api_sign_request`, so the API secret never leaves the server. The frontend gets back `{ signature, timestamp, apiKey, cloudName, folder }` and uses those to upload the file **directly to Cloudinary** — the file itself never touches our backend.
- **`CloudinaryService.verifyResource(publicId, resourceType)`** — for Day 2 Hr 6 to call after a client claims it uploaded something: confirms the asset genuinely exists in Cloudinary via the Admin API before trusting it and marking `feedback_media.status` `VERIFIED` (vs. `REJECTED` for a spoofed/fabricated `public_id`).
- **`POST /uploads/cloudinary-signature`** (body: `{ folder? }`) — **deliberately public, no `SupabaseAuthGuard`.** Unlike every other endpoint in this repo so far, this one is called from the anonymous public feedback form (Day 4), not the admin portal, so it can't require an admin session.
- **`cloudinary` npm package is pure JS**, no native binary — confirmed via its `package.json` (single dependency, no `node-gyp`/native build step) — safe given this machine's Smart App Control history.

**Live-verified 2026-07-25 against a real (temporary) Cloudinary account:**
1. Requested a real signature from `POST /uploads/cloudinary-signature` — got back real `apiKey`/`cloudName`, not placeholders.
2. Used that signature to upload a real 1x1 PNG **directly to Cloudinary's API** (bypassing the backend entirely for the file itself, exactly as the real frontend flow will) — succeeded, returned a real `public_id`.
3. Called `verifyResource` with that real `public_id` — correctly found it (`format`, `bytes` matched).
4. Called `verifyResource` with a fabricated/spoofed `public_id` — correctly returned `null` (Cloudinary 404'd it, caught cleanly).
5. Cleaned up the test asset afterward via `cloudinary.uploader.destroy`.

This is a genuine, not just structural, confirmation that the whole signature → direct-upload → verify pipeline works exactly as designed.

## Responsibilities
- Admin auth (JWT verification against Supabase Auth, via a NestJS guard) — done, see above
- ClickUp OAuth connect + one-time list/field config — done, see above (awaiting real credentials to live-test)
- Clients CRUD (`/clients`) — done, see above
- Sites CRUD (`/sites`) — done, see above
- QR code generation + download (PNG/PDF, A4/A5 sized) — done, see above
- CSV bulk upload (`/clients/bulk-upload`) — per-row success/error reporting via `csv_import_batches`/`csv_import_rows`
- Public slug resolution (`/public/{slug}`)
- Feedback submission (`/feedback/{slug}`) — accepts a frontend-generated `idempotency_key` (plain UUID v4, no server-side derivation), delivered as a Task in `TICKETS` (Relationship field set to the client's `clickup_entity_id`, site as plain text), tracked via an `integration_jobs` row (not a simple status column)
- Media upload handling via Cloudinary — signing done, see above; `feedback_media` will store `cloudinary_public_id` + `resource_type`, not a URL (wired up in Day 2 Hr 6)
- Retry/backoff worker for `integration_jobs` in `PENDING`/`RETRYING` status

## Environment Variables
See `.env.example`. Never commit `.env` or paste real secrets into a prompt. Required:
`DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`, `CLICKUP_CLIENT_ID`, `CLICKUP_CLIENT_SECRET`, `CLICKUP_REDIRECT_URI`, `CLICKUP_TOKEN_ENCRYPTION_KEY` (encrypts `clickup_connections.encrypted_access_token` — already generated, see `.env`), `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `BASE_DOMAIN`. Optional: `CLICKUP_COMPANY_STATUS_ACTIVE`/`CLICKUP_COMPANY_STATUS_INACTIVE` (ClickUp task status names for Company records, default `"active"`/`"inactive"`). `CLICKUP_WORKSPACE_ID`/`CLICKUP_LIST_ID` from earlier drafts are **superseded** — list/field IDs now live in `clickup_connections`, set via `POST /clickup/setup`, not env vars.

## Critical Rules
- **Service role key stays backend-only.** Never expose it to the frontend.
- **ClickUp uses OAuth**, authorized once through the portal — the resulting access token is stored encrypted in `clickup_connections`, not a static env var. Never log or return the decrypted token.
- **`CLICKUP_TOKEN_ENCRYPTION_KEY` lives only as a server-side env var** — never write it to the database, never commit it, never log it. Only the encrypted token (`clickup_connections.encrypted_access_token`) is persisted.
- **Prisma is the source of truth for schema changes** — model changes go through `schema.prisma` + `prisma migrate`, not manual edits in the Supabase dashboard.
- **Slug uniqueness is enforced at the DB level** (Prisma `@unique`), not just app-level — bulk CSV upload is the likeliest place for a race condition.
- **CSV bulk upload processes rows individually** — one bad row must not fail the whole batch. Log every batch + row to `csv_import_batches` / `csv_import_rows`.
- **No n8n, single delivery path** — the direct ClickUp API call is the only way a feedback ticket is created. Every feedback submission gets an `integration_jobs` row driving retry/backoff (`attempt_count`, `next_attempt_at`, `last_error`); there is no fallback path if delivery fails.
- **`idempotency_key` is frontend-generated (plain UUID v4), backend just enforces it** — reject/dedupe on the unique constraint; don't hash or derive it server-side.
- **Soft delete via 2-state status** — `clients` and `sites` use `ACTIVE`/`INACTIVE` only (uppercase enum, not free-text). Do not reintroduce `ARCHIVED` — dropped 2026-07-24. Hard delete is only via explicit API action, and `feedback_submissions.site_id` is `ON DELETE RESTRICT` (see Open Decision #2 in root doc — confirm before changing).
- **ClickUp rate limits** — add retry/backoff on ClickUp calls, especially during bulk uploads. Never let a failed sync fail silently.
- **Never create ClickUp Lists, Folders, Spaces, or custom fields via the API.** All required structure (`TICKETS` list, `COMPANIES` list, `CLIENT NAME` relationship field) already exists in the client's workspace — fetch and cache IDs, don't create.
- **Company record syncs are partial writes only** — never overwrite fields on a Company task that the portal doesn't own (see ClickUp Structure Mapping above).
- Full DB schema: see root-level reference doc or the current `schema.prisma` — do not assume table shape without checking.

## Database
Full v1.5 schema (tables: `admin_users`, `clickup_connections`, `clients`, `sites`, `feedback_submissions`, `feedback_media`, `csv_import_batches`, `csv_import_rows`, `integration_jobs`) is documented in the root project plan (`../../CLAUDE.md`, Section 7), sourced from `pine-cleaning-schema-v1_5.sql` in Downloads (with the `message`→`feedback` override). Modeled in `prisma/schema.prisma` — that file is the live source of truth for column names/types over the root doc. `clickup_connections` gained `tickets_list_id`, `companies_list_id`, `client_field_id`, `site_field_id` on 2026-07-24 (migration `20260724163207_clickup_connection_config_fields`) per the ClickUp Structure Mapping resolution above.

## Open Decisions Affecting This Repo
Before building the related endpoint, confirm these with the user (full list in `../../CLAUDE.md`):
1. ~~Duplicate ticket risk~~ — moot, n8n dropped 2026-07-23.
2. Hard delete behavior on sites with feedback history (currently `ON DELETE RESTRICT`).
3. ~~ClickUp structure mapping~~ — resolved 2026-07-24, see "ClickUp Structure Mapping" section above.
4. CSV template column names/order.
5. ~~Cloudflare product choice~~ — resolved: Cloudinary. Confirm upload preset/transformation settings.
6. Upload flow — client → Cloudinary direct (signed upload) vs. client → backend → Cloudinary. `feedback_media.status` (`PENDING`/`VERIFIED`/`REJECTED`) implies signed-direct-upload-then-verify.
7. Domain/slug routing (affects `BASE_DOMAIN` and QR generation — must be locked before QR codes are printed).
8. ~~`INACTIVE` vs. `ARCHIVED`~~ — resolved 2026-07-24: `ARCHIVED` dropped, 2-state status only.
9. ~~`idempotency_key` generation~~ — resolved 2026-07-24: frontend UUID v4, backend enforces via unique constraint.
10. ~~ClickUp token encryption strategy~~ — resolved 2026-07-24: app-level `CLICKUP_TOKEN_ENCRYPTION_KEY`, server-env-only.
11. Max file attachments per feedback submission — not yet specified, still open (raised 2026-07-24).

## Working Style
- One hour-block from the roadmap = one focused session/prompt.
- Ask for a plan before writing code that touches the DB schema or an external API (ClickUp, Cloudinary).
- Commit at the end of every completed task, not just end of day.
