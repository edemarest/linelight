#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_lib.sh"

require_var NEXT_PUBLIC_API_BASE_URL
require_var NEXT_PUBLIC_DEFAULT_MAP_LAT
require_var NEXT_PUBLIC_DEFAULT_MAP_LNG
require_var NEXT_PUBLIC_DEFAULT_MAP_ZOOM

export NEXT_PUBLIC_API_BASE_URL
export NEXT_PUBLIC_DEFAULT_MAP_LAT
export NEXT_PUBLIC_DEFAULT_MAP_LNG
export NEXT_PUBLIC_DEFAULT_MAP_ZOOM

docker compose -f docker-compose.yml build web

container_id="$(docker create linelight-web:latest)"
rm -rf web/out
docker cp "$container_id:/app/web/out" web/out
docker rm "$container_id"

# Ensure landmarks are bundled; they live in public but are not emitted by export.
mkdir -p web/out/landmarks
rsync -a --delete web/public/landmarks/ web/out/landmarks/

find web/out -name '.DS_Store' -print0 | xargs -0 rm -f

if [[ ! -d "web/out" ]]; then
  echo "Expected web/out after export, but it was not found." >&2
  exit 1
fi

echo "Static export ready at web/out"
