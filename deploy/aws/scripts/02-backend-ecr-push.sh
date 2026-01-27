#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_lib.sh"

require_var AWS_PROFILE
require_var AWS_REGION
require_var AWS_ACCOUNT_ID
require_var ECR_BACKEND_REPO
require_var BACKEND_IMAGE_TAG

REPO_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_BACKEND_REPO"

aws ecr describe-repositories \
  --repository-names "$ECR_BACKEND_REPO" \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" >/dev/null 2>&1 || \
aws ecr create-repository \
  --repository-name "$ECR_BACKEND_REPO" \
  --image-scanning-configuration scanOnPush=true \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" >/dev/null

aws ecr get-login-password --region "$AWS_REGION" --profile "$AWS_PROFILE" | \
  docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

docker buildx build \
  --platform linux/amd64 \
  -f backend/Dockerfile \
  -t "$REPO_URI:$BACKEND_IMAGE_TAG" \
  --push \
  .
