# AWS Deploy Scaffolding

This folder contains lightweight AWS deployment scaffolding.

## Target stack (low cost)

- S3 + CloudFront for the web build
- App Runner for the backend container
- No Redis (single backend instance only)

## Quickstart (scaffold)

1. Copy the config template:

```bash
cp deploy/aws/config.example.env deploy/aws/config.env
```

2. Fill in values in `deploy/aws/config.env`.

3. Run the scripts in order:

```bash
bash deploy/aws/scripts/01-aws-check.sh
bash deploy/aws/scripts/02-backend-ecr-push.sh
bash deploy/aws/scripts/03-web-export.sh
bash deploy/aws/scripts/04-s3-sync.sh
bash deploy/aws/scripts/05-cloudfront-invalidate.sh
```

## App Runner env vars

Use `deploy/aws/apprunner/env-vars.example.json` as a template for the backend env vars.
For updates without writing secrets to disk, use:

```bash
export MBTA_API_KEY="your_real_key"
bash deploy/aws/scripts/06-apprunner-update-env.sh
```

## Next steps to fill in

1. Confirm whether the frontend can be statically exported.
2. Choose region and domain plan (Route53 + ACM).
3. Add App Runner service creation steps (CLI or IaC).
