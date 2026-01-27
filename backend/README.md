Backend Dev Notes

SSM DB Tunnel (local dev)

This project expects a local PostgreSQL connection during development. To reach
the production RDS host from your machine, use an SSM port-forward through the
SSM bastion.

Prereqs
- AWS CLI configured with a profile that can access your SSM bastion.
- Session Manager plugin installed.

Start tunnel
```
aws ssm start-session \
  --profile "$AWS_PROFILE" \
  --target i-xxxxxxxxxxxxxxxxx \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"<rds-hostname>\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"5433\"]}"
```

While the tunnel is open, run the backend with a local DB URL:
```
DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5433/linelight \
PGSSLMODE=disable \
npm run dev -- --port 4000
```

Notes
- Keep the SSM session open while the backend runs.
- Update `backend/.env` if you want to persist local tunnel defaults.
