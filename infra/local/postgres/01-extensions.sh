#!/bin/sh
# Runs once, when the Postgres data volume is first initialised.
# ltree backs folder paths (folders.path). It is created in template1 too, so databases created
# later (the test database below, or per-test databases) have it without a migration.
# On RDS the migrations in packages/db run CREATE EXTENSION IF NOT EXISTS ltree.
set -eu

for db in template1 "$POSTGRES_DB"; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" \
    -c 'CREATE EXTENSION IF NOT EXISTS ltree;'
done

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "CREATE DATABASE \"${POSTGRES_DB}_test\" TEMPLATE template1;"
