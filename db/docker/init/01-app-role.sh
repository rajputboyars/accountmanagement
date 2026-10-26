#!/bin/sh
# Runs once, when the local database volume is first created.
# nexora_owner (POSTGRES_USER) owns the schema and runs migrations.
# nexora_app is what the application connects as: data read/write only, no DDL.
# Migration 0002 additionally revokes UPDATE/DELETE/TRUNCATE on the journals from nexora_app.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v app_password="$NEXORA_APP_PASSWORD" <<'EOSQL'
CREATE ROLE nexora_app LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE nexora TO nexora_app;
GRANT USAGE ON SCHEMA public TO nexora_app;
ALTER DEFAULT PRIVILEGES FOR ROLE nexora_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nexora_app;
ALTER DEFAULT PRIVILEGES FOR ROLE nexora_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nexora_app;
EOSQL
