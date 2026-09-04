-- Track the timestamp an admin/supervisor last successfully signed in,
-- so admins can see whether a supervisor has ever actually logged in.
ALTER TABLE "admin_users" ADD COLUMN "last_login_at" TIMESTAMP(3);
