#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${AWS_CONFIG:-deploy/aws/config.env}"

if [[ -f "$CONFIG_PATH" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_PATH"
fi

require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env var: $name" >&2
    exit 1
  fi
}
