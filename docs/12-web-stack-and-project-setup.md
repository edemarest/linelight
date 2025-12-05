# LineLight Web Stack & Project Setup

File: `docs/12-web-stack-and-project-setup.md`

This document describes the **web-only stack**, repository layout, and setup process
for LineLight. It assumes:

- We are building a **web app only** (no mobile client for now).
- The backend wraps MBTA v3 and exposes the endpoints defined in `11-data-layer-and-api-reference.md`.
- The frontend is a React/TypeScript app (ideally Next.js) consuming those endpoints.


## 1. High-Level Stack Overview

**Backend**

- Runtime: Node.js (LTS) + TypeScript.
- Framework: Express (or similar minimal HTTP framework).
- Responsibilities:
  - Call MBTA v3 (`/stops`, `/schedules`, `/predictions`, etc.).
  - Blend schedule + prediction data into ETAs.
  - Cache results to reduce load and improve latency.
  - Expose LineLight-specific endpoints under `/api`.


**Frontend (Web)**

- React + TypeScript.
- Recommended: Next.js (App Router or Pages Router) for SSR/SPA hybrid.
- Data fetching & caching: TanStack Query.
- Map: MapLibre GL JS (or Leaflet) with a dark basemap.
- Styling:
  - Tailwind CSS for layout and utility styling.
  - Custom CSS variables/classes for LineLight glow, gradients, and motion.


**Shared Types & API Client (optional but recommended)**

- `@linelight/core` package with:
  - TypeScript interfaces for all models in doc 11.
  - Typed API client helpers (`fetchHome`, `fetchStationBoard`, etc.).
- Used by both backend (as response contracts) and frontend (for fetch helpers and types).


## 2. Repository Layout

Recommended monorepo layout using npm workspaces:

```text
linelight/
  package.json           # root, with workspaces
  docs/                  # markdown docs, including 11 and 12
  backend/
    package.json
    tsconfig.json
    src/
      index.ts           # Express app entry
      routes/            # API routes
      mbta/              # MBTA integration & ETA logic
      core/              # internal services, caching, etc.
  web/
    package.json
    next.config.js       # or Vite config if not using Next
    tsconfig.json
    src/ or app/
      pages/ or routes/  # Next pages or app router
      components/
      hooks/
      styles/
  packages/
    core/
      package.json
      tsconfig.json
      src/
```

Root `package.json` example:

```jsonc
{
  "name": "linelight",
  "private": true,
  "workspaces": [
    "backend",
    "web",
    "packages/core"
  ],
  "scripts": {
    "dev:backend": "npm --workspace backend run dev",
    "dev:web": "npm --workspace web run dev",
    "build:backend": "npm --workspace backend run build",
    "build:web": "npm --workspace web run build"
  }
}
```


## 3. Shared Core Package (`@linelight/core`)

Folder: `packages/core`

**Purpose**

- Single source of truth for LineLight models and API helpers.

**Contents**

- `src/models/` – types from doc 11 (HomeResponse, StationBoard, etc.).
- `src/api/` – `fetchHome`, `fetchStationBoard`, `fetchTripTrack`, etc.
- `src/utils/` – helpers (time formatting, ETA formatting, etc.).
- `src/index.ts` – re-exports public API.

Minimal `package.json`:

```jsonc
{
  "name": "@linelight/core",
  "version": "0.0.1",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  }
}
```

Minimal `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "module": "commonjs",
    "target": "ES2019",
    "strict": true,
    "esModuleInterop": true
  },
  "include": ["src"]
}
```


## 4. Backend Setup (`backend/`)

Folder: `backend`

**Responsibilities**

- Implement `/api/home`, `/api/stations/:id/board`, `/api/trips/:tripId/track` and other endpoints.
- Integrate MBTA v3, blend `predictions` + `schedules` into ETAs (see doc 14).
- Use `@linelight/core` types for response models where possible.

Example `backend/package.json`:

```jsonc
{
  "name": "linelight-backend",
  "version": "0.0.1",
  "main": "dist/index.js",
  "scripts": {
    "dev": "ts-node-dev src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@linelight/core": "0.0.1",
    "axios": "^1.x",
    "cors": "^2.8.5",
    "express": "^4.18.0"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "ts-node-dev": "^2.x"
  }
}
```

Backend `tsconfig.json` (example):

```jsonc
{
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "module": "commonjs",
    "target": "ES2019",
    "strict": true,
    "esModuleInterop": true
  },
  "include": ["src"]
}
```

**Env vars**

- `PORT` – default 4000.
- `MBTA_API_KEY` – MBTA v3 API key.
- `MBTA_BASE_URL` – optional override (default `https://api-v3.mbta.com`).
- Any caching config (e.g., `ETA_CACHE_TTL_SECONDS`).

**Dev commands (from repo root)**

```bash
npm --workspace packages/core run build
npm --workspace backend run dev
```


## 5. Web Frontend Setup (`web/`)

Folder: `web`

Framework choices (recommended: Next.js, but any React + Vite setup works).

Example Next-based structure:

```text
web/
  package.json
  next.config.js
  tsconfig.json
  src/
    pages/ or app/
    components/
    hooks/
    styles/
```

Example `web/package.json`:

```jsonc
{
  "name": "linelight-web",
  "version": "0.0.1",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "@linelight/core": "0.0.1",
    "@tanstack/react-query": "^5.x",
    "next": "^14.x",
    "react": "^18.x",
    "react-dom": "^18.x",
    "maplibre-gl": "^4.x",
    "react-map-gl": "^7.x",
    "tailwindcss": "^3.x"
  },
  "devDependencies": {
    "typescript": "^5.x"
  }
}
```


### 5.1 API base URL

Frontend must know where the backend lives:

- Local dev: `NEXT_PUBLIC_API_BASE_URL=http://localhost:4000`
- Production: e.g. `NEXT_PUBLIC_API_BASE_URL=https://api.linelight.app`

In code, a small helper:

```ts
// web/src/lib/config.ts
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
```


### 5.2 React Query Setup

Wrap the app with `QueryClientProvider` and define hooks using `@linelight/core` API helpers.

Example hook:

```ts
import { useQuery } from "@tanstack/react-query";
import { fetchHome } from "@linelight/core";
import { API_BASE_URL } from "../lib/config";

export function useHome(position: { lat: number; lng: number }) {
  return useQuery({
    queryKey: ["home", position],
    queryFn: () => fetchHome(API_BASE_URL, position),
    staleTime: 15_000,
    refetchInterval: 15_000
  });
}
```


### 5.3 Map & Styling

- Use MapLibre GL JS for an interactive map.
- Configure a dark basemap and styles for stop markers and lines.
- Install and configure Tailwind CSS for layout, plus custom CSS for glows and transitions.


## 6. Local Development Workflow

Typical workflow:

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Build shared core**

   ```bash
   npm --workspace packages/core run build
   ```

3. **Run backend**

   ```bash
   cd backend
   cp .env.example .env   # then fill MBTA_API_KEY, etc.
   cd ..
   npm --workspace backend run dev
   ```

4. **Run web frontend**

   ```bash
   cd web
   cp .env.local.example .env.local   # set NEXT_PUBLIC_API_BASE_URL
   cd ..
   npm --workspace web run dev
   ```

5. Visit the web app (e.g. `http://localhost:3000`) and verify it can reach `http://localhost:4000/api/...`.

This loop (backend + web) is the main development environment for LineLight.


## 7. Extensibility & Future Enhancements

- The stack can easily support:
  - Additional frontend views (Lines, Insights) reusing `/api/lines`, `/api/system/insights`.
  - Backend caching layers (e.g., Redis) without changing frontend contracts.
  - Dockerization and cloud deployment using a separate deployment guide.

When adding new features:

1. Add or update models in `@linelight/core`.
2. Implement or adjust backend endpoints in `backend/` to return those models.
3. Create or update React Query hooks and components in `web/` that consume them.

This document should be used by any engineer (or AI assistant) to understand **where to put new code**, **how to wire backend and frontend**, and **how to run LineLight locally as a web app**.
