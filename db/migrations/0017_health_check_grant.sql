-- Hand-written: lets the application role read which migrations are applied, so GET /api/health can
-- report "current" or "pending". Read-only; the app still cannot change the schema or migration history.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexora_app') THEN
    GRANT USAGE ON SCHEMA drizzle TO nexora_app;
    GRANT SELECT ON drizzle.__drizzle_migrations TO nexora_app;
  END IF;
END
$$;
