#!/bin/sh
# Runs once, when the production Postgres data volume is first initialised (an existing volume
# skips it; see deploy/README.md to create the roles by hand). Unlike infra/local/postgres, no
# test database is created.
#
# POSTGRES_USER is the image's superuser, for maintenance only. The services never use it:
# - shotx: owns the database (and so the public schema). api, worker, migrate and backup log in
#   as shotx. Not a superuser, so a SQL injection can't read files or run programs.
# - shotx_monitor: logs in with no privileges of its own; `ops migrate` grants it SELECT on
#   exactly the columns it reads (deploy/ops/migrate.ts MONITOR_GRANTS).
# ltree is created here by the superuser; the migrations' CREATE EXTENSION IF NOT EXISTS is then a
# no-op.
set -eu

: "${APP_DB_PASSWORD:?set APP_DB_PASSWORD in env/postgres.env}"
: "${MONITOR_DB_PASSWORD:?set MONITOR_DB_PASSWORD in env/postgres.env}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$APP_DB_PASSWORD" -v monitor_password="$MONITOR_DB_PASSWORD" <<'SQL'
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE ROLE shotx LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
ALTER DATABASE :"DBNAME" OWNER TO shotx;
CREATE ROLE shotx_monitor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  CONNECTION LIMIT 2 PASSWORD :'monitor_password';
REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO shotx, shotx_monitor;
SQL
