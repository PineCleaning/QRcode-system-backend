# Backend — QR Feedback System (NestJS)

This is the **backend repo** for the QR Feedback System. It is its own git repository, separate from the frontend repo (`../frontend`). See `../CLAUDE.md` (root) for the full business context, requirements, and day-by-day project plan.

**Tech stack locked 2026-07-23** — this replaces an earlier FastAPI/Python draft. Do not scaffold or suggest Python/FastAPI code here.

**Scope change (2026-07-23): no n8n.** ClickUp delivery is a single direct API call — there is no parallel webhook path. Do not build any n8n integration or `N8N_WEBHOOK_URL` handling.

**DB schema locked at v1.5 (2026-07-24)** — see `../CLAUDE.md` Section 7 for the full ERD/enums. Key additions vs. the original design: `clickup_connections` (encrypted OAuth token storage), `integration_jobs` (delivery retry engine, replaces a single status column), `idempotency_key` on feedback. `csv_upload_*` tables are renamed `csv_import_*`. The `feedback_submissions` text field is `feedback` (user override — the source SQL file names it `message`, do not use that name). **`client_site_status` is 2-state (`ACTIVE`/`INACTIVE`)** — a proposed `ARCHIVED` third state was dropped 2026-07-24, don't add it back.

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

## Responsibilities
- Admin auth (JWT verification against Supabase Auth, via a NestJS guard)
- Clients CRUD (`/clients`) — every mutation syncs to ClickUp, stores `clickup_entity_id`
- Sites CRUD (`/sites`) — slug generation/enforcement, ClickUp sync, stores `clickup_entity_id`
- QR code generation + download (PNG/JPG/PDF, A4/A5 sized)
- CSV bulk upload (`/clients/bulk-upload`) — per-row success/error reporting via `csv_import_batches`/`csv_import_rows`
- Public slug resolution (`/public/{slug}`)
- Feedback submission (`/feedback/{slug}`) — accepts a frontend-generated `idempotency_key` (plain UUID v4, no server-side derivation), direct ClickUp API delivery tracked via an `integration_jobs` row (not a simple status column)
- Media upload handling via Cloudinary — `feedback_media` stores `cloudinary_public_id` + `resource_type`, not a URL
- ClickUp OAuth flow (authorize, token exchange) — resulting connection stored encrypted in `clickup_connections`, not just env-config
- Retry/backoff worker for `integration_jobs` in `PENDING`/`RETRYING` status

## Environment Variables
See `.env.example`. Never commit `.env` or paste real secrets into a prompt. Required:
`DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`, `CLICKUP_CLIENT_ID`, `CLICKUP_CLIENT_SECRET`, `CLICKUP_REDIRECT_URI`, `CLICKUP_TOKEN_ENCRYPTION_KEY` (encrypts `clickup_connections.encrypted_access_token`), `CLICKUP_WORKSPACE_ID`, `CLICKUP_LIST_ID`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `BASE_DOMAIN`.

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
- Full DB schema: see root-level reference doc or the current `schema.prisma` — do not assume table shape without checking.

## Database
Full v1.5 schema (tables: `admin_users`, `clickup_connections`, `clients`, `sites`, `feedback_submissions`, `feedback_media`, `csv_import_batches`, `csv_import_rows`, `integration_jobs`) is documented in the root project plan (`../CLAUDE.md`, Section 7), sourced from `pine-cleaning-schema-v1_5.sql` in Downloads (with the `message`→`feedback` override). Already modeled in `prisma/schema.prisma` as of 2026-07-24 — that file is the live source of truth for column names/types over the root doc.

## Open Decisions Affecting This Repo
Before building the related endpoint, confirm these with the user (full list in `../CLAUDE.md`):
1. ~~Duplicate ticket risk~~ — moot, n8n dropped 2026-07-23.
2. Hard delete behavior on sites with feedback history (currently `ON DELETE RESTRICT`).
3. ClickUp structure mapping — client = List, Folder, or Task w/ custom fields?
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
