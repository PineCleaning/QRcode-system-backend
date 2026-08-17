-- Track when an auth-class ClickUp failure (401 / ECODE OAUTH_025 "Token
-- invalid") flips a connection to RECONNECT_REQUIRED, so the admin portal
-- can show why and when. Both cleared back to null on a successful
-- reconnect. Additive/nullable, no existing data affected.
ALTER TABLE "clickup_connections" ADD COLUMN "last_error_message" TEXT;
ALTER TABLE "clickup_connections" ADD COLUMN "disconnected_at" TIMESTAMPTZ;
