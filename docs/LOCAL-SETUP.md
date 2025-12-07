# Local development: running Redis for a locally-run backend

This document explains how to run Redis in Docker while running the `backend` process locally (Option B). The backend expects a Redis server reachable at the `REDIS_URL` in `backend/.env`.

Recommended approach (publish Redis to localhost)

1. Start a Redis container and publish its port to the host so the local backend can connect to `127.0.0.1:6379`:

```bash
# from repo root (uses the newly added docker-compose.local.yml)
docker compose -f docker-compose.local.yml up -d

# or using plain docker
docker run -d --name linelight-redis -p 6379:6379 redis:7-alpine
```

2. Confirm Redis is running and reachable on the host:

```bash
# should print a pong
redis-cli -h 127.0.0.1 -p 6379 ping
```

3. Ensure `backend/.env` contains the host URL (this repo default already does):

```
REDIS_URL=redis://127.0.0.1:6379
PORT=4000
MBTA_API_KEY=your_key_here
```

4. Start the backend locally (it will use `backend/.env` via dotenv):

```bash
cd backend
npm run dev
```

5. Start the frontend locally (if not already running):

```bash
cd ../web
npm run dev
```

6. Verify the backend health endpoint responds and reports Redis as healthy:

```bash
curl -s http://localhost:4000/api/health | jq .
# verify `redis.healthy: true` and `mbtaApiKeyConfigured: true`
```

Notes and alternatives

- If you prefer not to publish Redis to the host, you can run the backend in Docker Compose (where the backend container resolves the `redis` hostname on the Docker network). In that case, use the project `docker-compose.yml` which sets `REDIS_URL=redis://redis:6379` for the backend service.
- If you run Redis inside Docker without publishing the port, the backend running on the host will not be able to connect at `127.0.0.1`. Either publish the port (recommended) or change `backend/.env` to point to a reachable host for Redis.
- When finished, stop the local Redis container:

```bash
docker compose -f docker-compose.local.yml down
# or
docker rm -f linelight-redis
```
