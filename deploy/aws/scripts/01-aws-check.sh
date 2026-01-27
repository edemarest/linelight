#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_lib.sh"

require_var AWS_PROFILE

echo "AWS profiles on system:"
aws configure list-profiles

echo
echo "Active identity for profile: $AWS_PROFILE"
aws sts get-caller-identity --profile "$AWS_PROFILE"
