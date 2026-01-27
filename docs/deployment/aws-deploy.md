# AWS Deployment (Low Cost, Fast Loads)

This document proposes a low-cost AWS stack that still keeps the app fast and reliable for low traffic.

## Recommended stack (cost-first, still reliable)

- **Frontend:** S3 static hosting + CloudFront CDN
- **Backend API:** AWS App Runner (single instance, always on)
- **Cache:** In-memory only (skip Redis for now)

Why:
- CloudFront serves static assets fast and cheaply.
- App Runner keeps the backend always-on for MBTA polling loops.
- Redis is optional; with one backend instance, in-memory cache is enough.

## Networking overview

- Browser -> CloudFront -> S3 (static web assets)
- Browser -> App Runner service (API)
- App Runner -> MBTA API (outbound HTTPS)

No VPC is required for this phase. If you add Redis later, we will attach App Runner to a VPC connector.

## Secrets and config to migrate

Backend (server-side only):
- `MBTA_API_KEY` (secret)
- `MBTA_API_BASE_URL` (default is fine)
- `LOG_LEVEL`
- `MBTA_RATE_LIMIT_WINDOW_MS`
- `MBTA_RATE_LIMIT_MAX_REQUESTS`
- `MBTA_MAX_RETRIES`
- `MBTA_RETRY_BASE_DELAY_MS`
- `MBTA_RETRY_MAX_DELAY_MS`
- `HOME_SNAPSHOT_TIMEOUT_MS` (home ETA fetch timeout)
- `HOME_SNAPSHOT_CONCURRENCY` (home ETA concurrency)
- `TRIP_PLANNER_REALTIME` (toggle realtime usage)
- `OSRM_BASE_URL` (optional; enables walking geometry)
- `OSRM_TIMEOUT_MS`

Frontend (public):
- `NEXT_PUBLIC_API_BASE_URL` (points to App Runner API URL)
- `NEXT_PUBLIC_DEFAULT_MAP_LAT`
- `NEXT_PUBLIC_DEFAULT_MAP_LNG`
- `NEXT_PUBLIC_DEFAULT_MAP_ZOOM`
- `NEXT_PUBLIC_LANDMARKS_BASE_URL` (S3 or CDN base for landmark images)

## Frontend build note (static export)

For the S3 + CloudFront option, Next.js must build a static export. That requires:
- `web/next.config.ts` to use `output: "export"`.
- `images.unoptimized = true` if `next/image` is used.
- `trailingSlash = true` so S3 can serve route folders.

We will verify that all routes can be statically exported before switching.

## Phase 1 plan (scaffold)

1. Confirm static export works for the frontend.
2. Create an S3 bucket + CloudFront distribution for the web build.
3. Build and push the backend Docker image to ECR.
4. Create App Runner service from the ECR image.
5. Wire secrets and environment variables.
6. Update `NEXT_PUBLIC_API_BASE_URL` to the App Runner URL and rebuild the web.

## Alternative (simpler, slightly higher cost)

Deploy both `web` and `backend` as App Runner services (no S3/CloudFront). This avoids static export,
but costs more because both services stay warm.

## Detailed steps (CLI-first)

These steps assume you will use the AWS CLI with a named profile (export `AWS_PROFILE`).

### 1) Backend container -> ECR

Create an ECR repo:

```bash
aws ecr create-repository \
  --repository-name linelight-backend \
  --image-scanning-configuration scanOnPush=true \
  --profile "$AWS_PROFILE"
```

Login and push:

```bash
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile "$AWS_PROFILE")
AWS_REGION=us-east-1

aws ecr get-login-password --region "$AWS_REGION" --profile "$AWS_PROFILE" | \
  docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

docker build -f backend/Dockerfile -t linelight-backend:latest .
docker tag linelight-backend:latest "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/linelight-backend:latest"
docker push "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/linelight-backend:latest"
```

### 2) App Runner service (backend)

Create an App Runner service pointing at the ECR image. Set env vars:

- `PORT=4000`
- `MBTA_API_BASE_URL=https://api-v3.mbta.com`
- `MBTA_API_KEY=...`
- `LOG_LEVEL=info`
- `MBTA_RATE_LIMIT_WINDOW_MS=10000`
- `MBTA_RATE_LIMIT_MAX_REQUESTS=6`
- `MBTA_MAX_RETRIES=4`
- `MBTA_RETRY_BASE_DELAY_MS=500`
- `MBTA_RETRY_MAX_DELAY_MS=7500`
- `HOME_SNAPSHOT_TIMEOUT_MS=1500`
- `HOME_SNAPSHOT_CONCURRENCY=4`
- `TRIP_PLANNER_REALTIME=true`
- `OSRM_BASE_URL=` (leave empty to disable)
- `OSRM_TIMEOUT_MS=1500`

Note: For a first pass, you can set these directly in the App Runner console.
Later we can move to SSM Parameter Store or Secrets Manager.

### 3) Web static export -> S3

Build the static site with the API URL set to the App Runner URL:

```bash
export NEXT_PUBLIC_API_BASE_URL="https://<apprunner-service>.awsapprunner.com"
export NEXT_PUBLIC_DEFAULT_MAP_LAT=42.3601
export NEXT_PUBLIC_DEFAULT_MAP_LNG=-71.0589
export NEXT_PUBLIC_DEFAULT_MAP_ZOOM=11

npm --workspace web run build
```

This produces `web/out/`. Sync to S3:

```bash
aws s3 mb "s3://linelight-web-$AWS_ACCOUNT_ID" --profile "$AWS_PROFILE"
aws s3 sync web/out "s3://linelight-web-$AWS_ACCOUNT_ID" --delete --profile "$AWS_PROFILE"
```

### 3.5) DB migrations (if schema changed)

Use the helper script to run migrations against RDS:

```bash
export DATABASE_URL="postgres://<user>:<pass>@<host>:5432/linelight?sslmode=require"
deploy/aws/scripts/07-db-migrate.sh
```

### 4) CloudFront

Create a CloudFront distribution with the S3 bucket as origin. Then:

- Default root object: `index.html`
- Cache policy: use managed CachingOptimized
- Error responses: map `403` and `404` to `/index.html` (SPA routing)

### 5) Domain: linelights.live (Cloudflare)

- Request an ACM cert in `us-east-1` for `linelights.live` and `www.linelights.live`.
- Attach the cert to the CloudFront distribution.
- In Cloudflare, add a CNAME pointing `linelights.live` to the CloudFront domain.
- Set Cloudflare SSL/TLS to "Full (strict)".
