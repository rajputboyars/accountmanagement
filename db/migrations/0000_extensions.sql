-- Extensions the V1 schema depends on. Must run before 0001 (products_name_trgm uses gin_trgm_ops).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
