# Backend — QR Feedback System (NestJS)

This is the **backend repo** for the QR Feedback System. It is its own git repository, separate from the frontend repo (`../frontend`). See `../CLAUDE.md` (root) for the full business context, requirements, and day-by-day project plan.

**Tech stack locked 2026-07-23** — this replaces an earlier FastAPI/Python draft. Do not scaffold or suggest Python/FastAPI code here.

**Scope change (2026-07-23): no n8n.** ClickUp delivery is a single direct API call — there is no parallel webhook path. Do not build any n8n integration or `N8N_WEBHOOK_URL` handling.

## Tech Stack
- **Framework:** NestJS + TypeScript
- **ORM:** Prisma
- **Database & Auth:** Supabase PostgreSQL (via Prisma) + Supabase Auth
- **Media storage:** Cloudinary
- **CRM:** ClickUp OAuth + direct API integration only
- **Deployment:** Railway

## Responsibilities
- Admin auth (JWT verification against Supabase Auth, via a NestJS guard)
- Clients CRUD (`/clients`) — every mutation syncs to ClickUp
- Sites CRUD (`/sites`) — slug generation/enforcement, ClickUp sync
- QR code generation + download (PNG/JPG/PDF, A4/A5 sized)
- CSV bulk upload (`/clients/bulk-upload`) — per-row success/error reporting
- Public slug resolution (`/public/{slug}`)
- Feedback submission (`/feedback/{slug}`) — direct ClickUp API delivery, logged via `clickup_delivery_status`
- Media upload handling via Cloudinary
- ClickUp OAuth flow (authorize, token exchange, token refresh)

## Environment Variables
See `.env.example`. Never commit `.env` or paste real secrets into a prompt. Required:
`DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`, `CLICKUP_CLIENT_ID`, `CLICKUP_CLIENT_SECRET`, `CLICKUP_REDIRECT_URI`, `CLICKUP_WORKSPACE_ID`, `CLICKUP_LIST_ID`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `BASE_DOMAIN`.

## Critical Rules
- **Service role key stays backend-only.** Never expose it to the frontend.
- **ClickUp uses OAuth, not a static personal token** — store and refresh access/refresh tokens server-side; never let an expired token silently fail a sync.
- **Prisma is the source of truth for schema changes** — model changes go through `schema.prisma` + `prisma migrate`, not manual edits in the Supabase dashboard.
- **Slug uniqueness is enforced at the DB level** (Prisma `@unique`), not just app-level — bulk CSV upload is the likeliest place for a race condition.
- **CSV bulk upload processes rows individually** — one bad row must not fail the whole batch. Log every batch + row to `csv_upload_batches` / `csv_upload_rows`.
- **No n8n, single delivery path** — the direct ClickUp API call is the only way a feedback ticket is created. Add retry/backoff on that call and log outcome via `clickup_delivery_status`; there is no fallback path if it fails.
- **Soft delete by default** — `clients` and `sites` use a `status` column (`active`/`inactive`). Hard delete is only via explicit API action, and `feedback_submissions.site_id` is `ON DELETE RESTRICT` (see Open Decision #2 in root doc — confirm before changing).
- **ClickUp rate limits** — add retry/backoff on ClickUp calls, especially during bulk uploads. Never let a failed sync fail silently.
- Full DB schema: see root-level reference doc or the current `schema.prisma` — do not assume table shape without checking.

## Database
Full schema (tables: `admin_users`, `clients`, `sites`, `feedback_submissions`, `feedback_media`, `csv_upload_batches`, `csv_upload_rows`) is documented in the root project plan (`../CLAUDE.md`, Section 7). Model it in `prisma/schema.prisma` when Day 1 Hr 4 begins — that file becomes the live source of truth for column names/types once created, ahead of the root doc.

## Open Decisions Affecting This Repo
Before building the related endpoint, confirm these with the user (full list in `../CLAUDE.md`):
1. ~~Duplicate ticket risk~~ — moot, n8n dropped 2026-07-23.
2. Hard delete behavior on sites with feedback history (currently `ON DELETE RESTRICT`).
3. ClickUp structure mapping — client = List, Folder, or Task w/ custom fields?
4. CSV template column names/order.
5. ~~Cloudflare product choice~~ — resolved: Cloudinary. Confirm upload preset/transformation settings.
6. Upload flow — client → Cloudinary direct (signed upload) vs. client → backend → Cloudinary.
7. Domain/slug routing (affects `BASE_DOMAIN` and QR generation — must be locked before QR codes are printed).

## Working Style
- One hour-block from the roadmap = one focused session/prompt.
- Ask for a plan before writing code that touches the DB schema or an external API (ClickUp, Cloudinary).
- Commit at the end of every completed task, not just end of day.
