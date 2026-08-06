-- RLS hardening: defense-in-depth for a currently-unused direct-Postgres
-- access path. The backend connects via the pooled `postgres` role
-- (BYPASSRLS), so none of this changes the app's actual runtime
-- behavior - every real read/write already goes through the NestJS API.
-- This exists only so that IF anything ever queried these tables
-- directly via Supabase's client SDK (using the public anon key, which
-- ships in the frontend bundle and is not a secret), it can't read or
-- write anything it shouldn't.
--
-- Found during this hardening pass: every table already had full
-- SELECT/INSERT/UPDATE/DELETE grants for both `anon` and `authenticated`
-- (Supabase's default), and was only actually protected by RLS being
-- enabled with zero policies (implicit deny-all). That's fragile - if
-- RLS were ever disabled by mistake, the underlying grants alone would
-- expose everything, including the encrypted ClickUp token in
-- clickup_connections. Fixed at both layers below.

-- SECURITY DEFINER so its internal query against admin_users runs as
-- the function's owner (this migration's connecting role, which has
-- BYPASSRLS) instead of recursively re-applying admin_users' own policy
-- to itself - Postgres rejects that as infinite recursion otherwise.
-- SET search_path pins it against search_path hijacking.
CREATE OR REPLACE FUNCTION public.is_active_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM admin_users
    WHERE id = auth.uid() AND status = 'ACTIVE'
  );
$$;

-- anon should never reach any of these tables directly - the public
-- feedback form and slug-resolve endpoints go through the backend API,
-- never Supabase's client SDK. Revoking the grant is a second,
-- independent layer of protection alongside RLS itself.
REVOKE ALL ON TABLE admin_users FROM anon;
REVOKE ALL ON TABLE clickup_connections FROM anon;
REVOKE ALL ON TABLE clients FROM anon;
REVOKE ALL ON TABLE sites FROM anon;
REVOKE ALL ON TABLE feedback_submissions FROM anon;
REVOKE ALL ON TABLE feedback_media FROM anon;
REVOKE ALL ON TABLE csv_import_batches FROM anon;
REVOKE ALL ON TABLE csv_import_rows FROM anon;
REVOKE ALL ON TABLE integration_jobs FROM anon;

-- authenticated (any valid Supabase session) keeps its grants, but every
-- table now also requires is_active_admin() - a valid JWT alone is not
-- enough, matching SupabaseAuthGuard's own behavior (a deactivated
-- admin's still-valid token doesn't pass either check).
CREATE POLICY "active admins only" ON admin_users FOR ALL TO authenticated USING (is_active_admin()) WITH CHECK (is_active_admin());
CREATE POLICY "active admins only" ON clickup_connections FOR ALL TO authenticated USING (is_active_admin()) WITH CHECK (is_active_admin());
CREATE POLICY "active admins only" ON clients FOR ALL TO authenticated USING (is_active_admin()) WITH CHECK (is_active_admin());
CREATE POLICY "active admins only" ON sites FOR ALL TO authenticated USING (is_active_admin()) WITH CHECK (is_active_admin());
CREATE POLICY "active admins only" ON feedback_submissions FOR ALL TO authenticated USING (is_active_admin()) WITH CHECK (is_active_admin());
CREATE POLICY "active admins only" ON feedback_media FOR ALL TO authenticated USING (is_active_admin()) WITH CHECK (is_active_admin());
CREATE POLICY "active admins only" ON csv_import_batches FOR ALL TO authenticated USING (is_active_admin()) WITH CHECK (is_active_admin());
CREATE POLICY "active admins only" ON csv_import_rows FOR ALL TO authenticated USING (is_active_admin()) WITH CHECK (is_active_admin());
CREATE POLICY "active admins only" ON integration_jobs FOR ALL TO authenticated USING (is_active_admin()) WITH CHECK (is_active_admin());
