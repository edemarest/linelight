#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_lib.sh"

require_var AWS_PROFILE
require_var AWS_REGION
require_var S3_BUCKET

aws s3api head-bucket --bucket "$S3_BUCKET" --profile "$AWS_PROFILE" >/dev/null 2>&1 || \
aws s3 mb "s3://$S3_BUCKET" --region "$AWS_REGION" --profile "$AWS_PROFILE"

aws s3 sync web/out "s3://$S3_BUCKET" --delete --profile "$AWS_PROFILE"
