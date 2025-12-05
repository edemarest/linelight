# Dev Setup, Installation & Running

File: `docs/08-dev-setup-installation-and-running.md`

This document describes how to set up a development environment, install dependencies, configure environment variables, and run both the backend and frontend for the MBTA System Radar project.

It is aimed at:

- Human developers onboarding to the project.
- AI assistants (Codex/Copilot) that need to understand the expected project structure and commands.


## 1. Prerequisites

- **Node.js:** LTS version (e.g., 20.x or current LTS).
- **Package manager:** `npm` (or `pnpm`/`yarn` if we standardize later).
- **Git:** for cloning the repository.
- **MBTA API access:** The MBTA V3 API is generally public, but if an API key is recommended or required, ensure you have one.

Optional for future features:

- **Redis:** for shared caching in multi-instance deployments.
- **Postgres:** for historical analytics (not required for v1).


## 2. Repository structure

Expected repo layout (simplified):

```text
/ (repo root)
├─ docs/
│  ├─ 01-product-spec-and-ux.md
│  ├─ 02-mbta-api-and-data-overview.md
│  ├─ 03-data-models-and-types.md
│  ├─ 04-architecture-and-stack.md
│  ├─ 05-backend-api-design-and-polling-strategy.md
│  ├─ 06-frontend-ui-layout-and-map-layers.md
│  ├─ 07-design-system-and-visual-style.md
│  └─ 08-dev-setup-installation-and-running.md
├─ backend/
│  ├─ src/
│  │  ├─ index.ts
│  │  ├─ mbta-client/
│  │  ├─ polling/
│  │  ├─ models/
│  │  └─ routes/
│  ├─ package.json
│  └─ tsconfig.json
├─ frontend/
│  ├─ app/ or pages/
│  ├─ src/
│  │  ├─ components/
│  │  ├─ hooks/
│  │  ├─ lib/
│  │  └─ styles/
│  ├─ package.json
│  └─ tsconfig.json
├─ package.json          # optional root scripts
└─ README.md
```

This structure may evolve, but the general separation of `/backend` and `/frontend` is expected.


## 3. Clone and initial install

From your terminal:

```bash
# Clone the repository
git clone <REPO_URL> mbta-system-radar
cd mbta-system-radar

# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

You can also set up a root-level `package.json` with convenience scripts if desired.


## 4. Environment variables

Both backend and frontend will use `.env`-style configuration.

### 4.1 Backend `.env`

In `/backend`, create a file named `.env` with contents similar to:

```bash
# Port for the backend HTTP server
PORT=4000

# MBTA API base URL (if configurable)
MBTA_API_BASE_URL=https://api-v3.mbta.com

# MBTA API key (if applicable; can be left empty if not required)
MBTA_API_KEY=

# Optional: Redis URL for shared caching in future versions
REDIS_URL=
```

Backend code will read these values using `process.env`.


### 4.2 Frontend `.env.local`

In `/frontend`, create `.env.local`:

```bash
# URL where the backend API is accessible from the browser
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
```

- For Next.js, `NEXT_PUBLIC_` prefix makes variables available client-side.
- Adjust the URL if the backend runs on a different host/port.


## 5. Backend: scripts & running

In `/backend/package.json`, we expect scripts like:

```jsonc
{
  "scripts": {
    "dev": "ts-node-dev src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "lint": "eslint src --ext .ts"
  }
}
```

To run the backend in development mode:

```bash
cd backend
npm run dev
```

This should:

- Start the Express server on `http://localhost:4000` (or `PORT` from `.env`).
- Initialize polling loops for MBTA data.
- Serve API endpoints like `/api/lines`, `/api/lines/:id/overview`, etc.


## 6. Frontend: scripts & running

In `/frontend/package.json`, we expect Next.js or similar scripts, for example (assuming Next.js):

```jsonc
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  }
}
```

To run the frontend in development mode:

```bash
cd frontend
npm run dev
```

By default, Next.js serves the app at:

- `http://localhost:3000`

The frontend will:

- Call `NEXT_PUBLIC_API_BASE_URL` + `/api/...` to hit the backend.
- Render the map, sidebar, and context panels using mocked or live data (depending on if backend is running).


## 7. Running both services together

In development, you typically need two terminals:

```bash
# Terminal 1: backend
cd backend
npm run dev

# Terminal 2: frontend
cd frontend
npm run dev
```

Optionally, you can set up a root-level script using a tool like `concurrently`:

## 8. Running with Docker Compose

If you have [Docker](https://www.docker.com/) installed, you can run the full stack (backend, frontend, and Redis) using the provided `docker-compose.yml`.

1. Copy environment files:

```bash
# Backend env (optional if using defaults)
cp "backend .env (copy to there)" backend/.env

# Frontend env
cp "web  copy.env (copy to there)" web/.env
```

2. Start the stack:

```bash
docker compose up --build
```

Services:
- `redis` (port 6379 inside the network)
- `backend` (exposed on `http://localhost:4000`)
- `web` (exposed on `http://localhost:3000`)

The frontend is built via Next.js standalone output and uses `NEXT_PUBLIC_API_BASE_URL` (default `http://localhost:4000`) to talk to the backend.

3. Stop the stack:

```bash
docker compose down
```

The Redis data volume `redis-data` persists between runs; to remove it, run `docker compose down -v`.

## 9. Deploying to Render

The repo includes a `render.yaml` Blueprint that provisions:

- `linelight-redis` – managed Redis for cache sharing.
- `linelight-api` – backend service built from `backend/Dockerfile`, health checked via `/api/health`.
- `linelight-web` – frontend service built from `web/Dockerfile`, pointing to the API host URL.

### Render setup steps

1. Connect the repository to Render.
2. Add a new Blueprint instance using `render.yaml`.
3. Set the required secrets when prompted (e.g., `MBTA_API_KEY`).
4. Deploy; Render will build the Docker images and start all services in the same region.

Environment variables:
- `linelight-api` expects `MBTA_API_KEY` (optional) and pulls `REDIS_URL` from the managed Redis.
- `linelight-web` receives `NEXT_PUBLIC_API_BASE_URL` automatically via the Blueprint reference to the API service.

Once deployed, verify:
- `https://<linelight-api>.onrender.com/api/health` returns redis cache status.
- `https://<linelight-web>.onrender.com` serves the app and calls the API over HTTPS.

```jsonc
// package.json at repo root
{
  "scripts": {
    "dev": "concurrently "npm run dev --prefix backend" "npm run dev --prefix frontend""
  }
}
```

Then:

```bash
npm run dev
```

This starts backend and frontend together.


## 8. Basic verification checklist

After starting both services:

1. Visit `http://localhost:4000/api/lines` in a browser or via curl:
   - You should receive a JSON payload with line summaries (may be stubbed if MBTA polling is not yet fully implemented).
2. Visit `http://localhost:3000`:
   - You should see the main app shell, with:
     - Sidebar.
     - Map canvas.
     - Right context area (possibly with placeholder content).
3. Check the browser dev tools network panel:
   - Frontend should request `GET /api/lines` and other endpoints on `localhost:4000`.

If these checks pass, the basic wiring is correct.


## 9. Linting, formatting & testing

Setup (suggested, can be adjusted later):

- **ESLint** for linting.
- **Prettier** for formatting.
- Tests with **Jest** or **Vitest** (starting with backend).

Example commands:

```bash
# Backend
cd backend
npm run lint
npm test      # if configured

# Frontend
cd ../frontend
npm run lint
npm test      # if configured
```

These can be fleshed out once code is present. For now, this document simply reserves space for standard lint/test flows.


## 10. Production build (outline)

For a production deployment (outline only; details depend on hosting provider):

### 10.1 Backend

```bash
cd backend
npm run build
npm start
```

- `npm run build` compiles TypeScript to JavaScript in `dist/`.
- `npm start` runs `node dist/index.js`.

### 10.2 Frontend

```bash
cd frontend
npm run build
npm start
```

- `npm run build` creates an optimized production build (e.g., `.next/`).
- `npm start` serves the built app (for Next.js).

Environment variables should be set appropriately in the production environment (backend URL, MBTA API key, etc.).


## 11. Summary

- The project assumes a **two-service** setup: `backend` and `frontend`, each with its own Node.js environment.
- `.env` files configure MBTA API access and backend/ frontend ports.
- Standard scripts (`npm run dev`, `npm run build`, `npm start`) are used to run and build each service.
- Developers should be able to clone the repo, install dependencies, set env vars, and run both services with minimal friction.

This doc should be kept up to date as the repository structure and tooling evolve so that both humans and AI tools can reliably bootstrap and extend the project.
