# Backend — QR Feedback System (FastAPI)

This is the **backend repo** for the QR Feedback System. It is its own git repository, separate from the frontend repo (`../frontend`). See `../CLAUDE.md` (root) for the full business context, requirements, and day-by-day project plan.

## Tech Stack
- **Framework:** FastAPI
- **Database & Auth:** Supabase (Postgres + Supabase Auth)
- **Media storage:** Cloudflare (Images/Stream/R2 — TBD, see Open Decision #5 in root doc)
- **CRM:** ClickUp API (direct integration) + n8n (parallel webhook path, owned by client's own developer)

## Responsibilities
- Admin auth (JWT verification against Supabase Auth)
- Clients CRUD (`/clients`) — every mutation syncs to ClickUp
- Sites CRUD (`/sites`) — slug generation/enforcement, ClickUp sync
- QR code generation + download (PNG/JPG/PDF, A4/A5 sized)
- CSV bulk upload (`/clients/bulk-upload`) — per-row success/error reporting
- Public slug resolution (`/public/{slug}`)
- Feedback submission (`/feedback/{slug}`) — dual delivery to ClickUp (direct API + n8n webhook), independently logged
- Media upload handling via Cloudflare

## Environment Variables
See `.env.example`. Never commit `.env` or paste real secrets into a prompt. Required:
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`, `CLICKUP_API_TOKEN`, `CLICKUP_WORKSPACE_ID`, `CLICKUP_LIST_ID`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `N8N_WEBHOOK_URL`, `BASE_DOMAIN`.

## Critical Rules
- **Service role key stays backend-only.** Never expose it to the frontend.
- **Slug uniqueness is enforced at the DB level**, not just app-level — bulk CSV upload is the likeliest place for a race condition.
- **CSV bulk upload processes rows individually** — one bad row must not fail the whole batch. Log every batch + row to `csv_upload_batches` / `csv_upload_rows`.
- **Dual ClickUp delivery must be independent** — the direct ClickUp API call and the n8n webhook fire separately (separate try/except or background tasks). One path failing/slow must never block or hide the other. Log both paths independently (`clickup_delivery_status`, `n8n_delivery_status`).
- **Soft delete by default** — `clients` and `sites` use a `status` column (`active`/`inactive`). Hard delete is only via explicit API action, and `feedback_submissions.site_id` is `ON DELETE RESTRICT` (see Open Decision #2 in root doc — confirm before changing).
- **ClickUp rate limits** — add retry/backoff on ClickUp calls, especially during bulk uploads. Never let a failed sync fail silently.
- Full DB schema: see root-level reference doc or ask for the current Supabase schema — do not assume table shape without checking.

## Database
Full schema (tables: `admin_users`, `clients`, `sites`, `feedback_submissions`, `feedback_media`, `csv_upload_batches`, `csv_upload_rows`) is documented in the root project plan (`../CLAUDE.md`, Section: Database Schema). Treat that as the source of truth for column names/types until the live Supabase schema diverges.

## Open Decisions Affecting This Repo
Before building the related endpoint, confirm these with the user (full list in `../CLAUDE.md`):
1. Duplicate ticket risk — does n8n update the same ticket the direct API creates, or are two tickets acceptable?
2. Hard delete behavior on sites with feedback history (currently `ON DELETE RESTRICT`).
3. ClickUp structure mapping — client = List, Folder, or Task w/ custom fields?
4. CSV template column names/order.
5. Cloudflare product choice (Images vs. Stream vs. R2).
6. Upload flow — client → Cloudflare direct (signed URL) vs. client → backend → Cloudflare.
7. Domain/slug routing (affects `BASE_DOMAIN` and QR generation — must be locked before QR codes are printed).

## Working Style
- One hour-block from the roadmap = one focused session/prompt.
- Ask for a plan before writing code that touches the DB schema or an external API (ClickUp, Cloudflare).
- Commit at the end of every completed task, not just end of day.
