# Docker commands for LineLight (local development)

This file collects common Docker and local-Redis commands you'll need to manage the dev stack.

Notes
- The Compose setup uses an internal service name `redis` for container-to-container communication. When running the stack with `docker compose up`, the backend container is configured to use `redis://redis:6379` (this is set in `docker-compose.yml`).
- For running the backend locally with `npm run dev`, set `REDIS_URL=redis://localhost:6379` (for a local Redis instance) in `backend/.env` or export it in your shell.

Quick start (run the whole stack)
```bash
# from repo root
docker compose up -d --build
# watch logs
docker compose logs -f
```

Stop / teardown
```bash
# stop and remove containers and the default network
docker compose down --remove-orphans
```

Rebuild (force a fresh build of images followed by start)
```bash
docker compose build --no-cache
docker compose up -d
```

Check container status
```bash
# list containers for this project
docker ps --filter "name=linelight" --format "{{.Names}}\t{{.Image}}\t{{.Status}}"

# view one service's logs
docker compose logs -f backend
```

Inspect backend env inside container
```bash
# show specific env vars
docker compose exec backend env | grep -i MBTA || true
docker compose exec backend env | grep -i REDIS || true
```

Local Redis (recommended for running `npm run dev` locally)
```bash
# run a local Redis container bound to host 6379
docker run -d --name linelight-redis -p 6379:6379 redis:7-alpine

# verify Redis is responsive from the host (if you have redis-cli)
redis-cli -h localhost -p 6379 ping
# expected output: PONG

# stop+remove the local Redis container
docker stop linelight-redis && docker rm linelight-redis
```

Using the Compose Redis from the host
```bash
# If you prefer the compose-managed Redis, expose it to host by adding the port mapping in docker-compose.yml
# Or use docker exec to run redis-cli inside the redis container
docker compose exec redis redis-cli ping
# expected output: PONG
```

Troubleshooting
- `getaddrinfo ENOTFOUND red-...` — DNS name (Render-hosted Redis) is not resolvable from your machine. Use a local Redis (above) or update `backend/.env` to point at a reachable host.
- If backend run locally is still failing to connect to Redis, ensure the `REDIS_URL` environment variable in your shell or `backend/.env` is set to `redis://localhost:6379` before launching `npm run dev`.

Example workflow for local dev (backend running locally + Redis in Docker)
```bash
# start local redis
docker run -d --name linelight-redis -p 6379:6379 redis:7-alpine

# set env for local backend (temporary)
export REDIS_URL="redis://localhost:6379"
cd backend
npm run dev
```

Security note
- Avoid committing secrets (passwords or production Redis host strings) to the repo. Use local `.env` (gitignored) or OS-level env vars for secrets in development.

If you'd like, I can:
- Patch `backend/.env` to restore the Render host only when you want it (I already updated it to `redis://localhost:6379`).
- Add a Compose option to publish Redis to host (so host processes can access it without a separate container).
- Create a short Makefile to wrap these common commands.
