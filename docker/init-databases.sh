#!/bin/bash
# Creates the test database alongside the development one.
#
# Two databases because `npm run test:db` truncates its tables. A single shared database means
# one test run silently destroys whatever `npm run backfill` imported, and the tests still pass
# — so the split is a safety boundary, not tidiness. The suite additionally refuses any
# database whose name does not end in `_test`.
#
# Postgres only runs docker-entrypoint-initdb.d scripts when the data directory is empty, so on
# an existing volume create it by hand:
#
#   docker compose exec postgres psql -U factory -d postgres -c 'create database factory_test'
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
    CREATE DATABASE factory_test;
EOSQL
