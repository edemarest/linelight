# Dev Setup, Installation & Running

File: `docs/development/dev-setup-installation-and-running.md`

Setup guide for running the full stack locally.


## 1. Prerequisites

- **Node.js:** LTS version (e.g., 20.x or current LTS).
- **Package manager:** `npm`.
- **Git:** for cloning the repository.
- **MBTA API access:** The MBTA V3 API is public.


## 2. Repository structure

Current repo layout (simplified):

```text
/ (repo root)
├─ docs/
│  ├─ architecture/
│  ├─ data/
│  ├─ deployment/
│  ├─ development/
│  ├─ plans/
│  ├─ product/
│  └─ README.md
├─ backend/
│  ├─ src/
│  │  ├─ index.ts
│  │  ├─ mbta/
│  │  ├─ polling/
│  │  ├─ models/
│  │  └─ services/
│  ├─ package.json
│  └─ tsconfig.json
├─ web/
│  ├─ src/
│  │  ├─ app/
│  │  ├─ components/
│  │  ├─ hooks/
│  │  └─ lib/
│  ├─ package.json
│  └─ tsconfig.json
├─ packages/
│  └─ core/
├─ package.json
└─ README.md
```

This structure may evolve, but the general separation of `/backend` and `/web` is expected.


## 3. Clone and initial install

From your terminal:

```bash
# Clone the repository
git clone <REPO_URL> linelight
cd linelight

# Install workspace dependencies
npm install
```


## 4. Environment variables

Both backend and frontend will use `.env`-style configuration.

### 4.1 Backend `.env`

In `/backend`, create a file named `.env` from the template:

```bash
cp backend/.env.example backend/.env
```

Backend code will read these values using `process.env`.


### 4.2 Frontend `.env.local`

In `/web`, create `.env.local` from the template:

```bash
cp web/.env.example web/.env.local
```

- For Next.js, `NEXT_PUBLIC_` prefix makes variables available client-side.
- Adjust the API URL if the backend runs on a different host/port.
- `NEXT_PUBLIC_LANDMARKS_BASE_URL` points to the S3 bucket where landmark images are hosted.


## 5. Backend: scripts & running

To run the backend in development mode:

```bash
npm run dev:backend
```

This should:

- Start the Express server on `http://localhost:4000` (or `PORT` from `.env`).
- Initialize polling loops for MBTA data.
- Serve API endpoints like `/api/lines`, `/api/lines/:id/overview`, etc.


## 6. Frontend: scripts & running

To run the frontend in development mode:

```bash
npm run dev:web
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
npm run dev:backend

# Terminal 2: web
npm run dev:web
```

## 8. Docker Compose

With Docker installed: `docker compose up --build` starts the full stack. See `docker-compose.yml` for details.

## 9. Verification checklist

1. `curl http://localhost:4000/api/lines` → JSON payload with lines
2. `http://localhost:3000` → app with map, sidebar, and panels
3. DevTools network tab: frontend calls `localhost:4000` endpoints


## 10. Production build

Backend: `cd backend && npm run build && npm start`  
Web: `cd web && npm run build && npm start`  
Set `MBTA_API_KEY` and backend URL in environment.


## 11. Summary

Clone → install → configure `.env` files → run `npm run dev` in two terminals (backend + frontend).
