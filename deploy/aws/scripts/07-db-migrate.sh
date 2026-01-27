#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_lib.sh"

require_var DATABASE_URL

PGSSLMODE="${PGSSLMODE:-require}"
PGSSLROOTCERT="${PGSSLROOTCERT:-}"
PGSSL_SERVERNAME="${PGSSL_SERVERNAME:-}"
PGSSLREJECTUNAUTHORIZED="${PGSSLREJECTUNAUTHORIZED:-false}"
NODE_TLS_REJECT_UNAUTHORIZED="${NODE_TLS_REJECT_UNAUTHORIZED:-0}"

echo "Building backend image for migrations..."
docker build -f backend/Dockerfile -t linelight-backend:latest .

echo "Running migrations against DATABASE_URL..."
docker run --rm \
  -e DATABASE_URL="$DATABASE_URL" \
  -e PGSSLMODE="$PGSSLMODE" \
  -e PGSSLROOTCERT="$PGSSLROOTCERT" \
  -e PGSSL_SERVERNAME="$PGSSL_SERVERNAME" \
  -e PGSSLREJECTUNAUTHORIZED="$PGSSLREJECTUNAUTHORIZED" \
  -e NODE_TLS_REJECT_UNAUTHORIZED="$NODE_TLS_REJECT_UNAUTHORIZED" \
  linelight-backend:latest \
  node dist/scripts/dbMigrate.js
