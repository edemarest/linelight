# Architecture & Stack

File: `docs/04-architecture-and-stack.md`

This document describes the overall architecture and technology stack for the MBTA System Radar project. It connects the product goals and MBTA data model to concrete implementation choices.

Our goals:

- TypeScript end-to-end for consistency and DX.
- A **thin backend** that centralizes MBTA polling, caching, and aggregation.
- A **map-first React frontend** with smooth, glowy visuals.
- Lightweight, strategic use of MBTA API to avoid rate issues and keep things fast.


## 1. High-level architecture

### 1.1 Top-level components

- **Frontend (client app)**  
  - React + TypeScript single-page app (SPA) with a map-first UI.
  - Talks only to our backend, not directly to MBTA.
  - Handles rendering, interaction, animations, and UI state.

- **Backend (API server)**  
  - Node.js + TypeScript service.
  - Periodically polls MBTA V3 endpoints.
  - Caches raw data and computes derived domain models.
  - Exposes simplified, application-specific JSON endpoints for the frontend.

- **MBTA API**  
  - External service (V3 API) providing static and real-time transit data.
  - We treat it as a read-only upstream dependency.

- **Optional cache store (Redis) and database (Postgres)**  
  - Redis: share caches across multiple backend instances.
  - Postgres: store historical snapshots / analytics (optional in v1).


### 1.2 Data flow (conceptual)

1. Backend polling loops fetch from MBTA:
   - Static bootstrapping (routes, stops, shapes, route patterns, facilities).
   - Real-time updates (predictions, vehicles, alerts, live facilities).
2. Backend updates an in-memory cache and computes:
   - Line overviews and segment statuses.
   - Station boards (on demand, using cached predictions and alerts).
   - Vehicle snapshots.
   - System insights.
3. Frontend calls our backend:
   - `/api/lines`, `/api/lines/:id/overview`
   - `/api/stations/:id/board`
   - `/api/vehicles/:routeId`
   - `/api/system/insights`, etc.
4. Frontend updates React state, map layers, and UI using these domain models.


## 2. Technology stack

### 2.1 Language

- **TypeScript** for:
  - Frontend (React components, hooks, state management).
  - Backend (API handlers, polling jobs, caching logic).
  - Shared type definitions (data models) where appropriate.

This ensures consistent typing, better tooling (IntelliSense, refactors), and easier AI-assisted code generation.


### 2.2 Frontend stack

**Framework & tooling:**

- **Next.js (React 18 + TypeScript)**
  - Provides:
    - File-based routing.
    - Built-in bundling/optimizations.
    - `pages` or `app` router for top-level pages.
    - Optional server-side rendering for non-map pages (docs, about, etc.).
  - The core system map itself will behave as a client-side SPA view.

- **Package manager:** `pnpm` or `npm` (either is fine; we can pick one in setup docs).

**UI & styling:**

- **Tailwind CSS**
  - Utility-first CSS framework.
  - Great for quickly building a consistent dark theme with glowy accents.
  - Plays well with componentization and our design system doc.

- **Motion / Framer Motion (for React)**
  - For high-level animations and transitions:
    - Sliding panels, fading overlays.
    - Hover interactions with slight scaling and glow.
    - Smooth route/vehicle state transitions.

**Data fetching and state:**

- **TanStack Query (React Query)**
  - Handles async data fetching from our backend endpoints.
  - Will be used for:
    - `useQuery` hooks for line overviews, station boards, system insights.
    - Caching, deduplication, background refetching, and `staleTime` / `refetchInterval` control.
  - Perfect for our “lightweight polling” design.

- **Local state management:** React state + context (if needed) for UI toggles, filters, and map selections. We avoid heavy global state libraries in v1.

**Map & visualization:**

- **MapLibre GL JS**
  - Open-source, WebGL-based map engine for vector tiles.
  - Provides the base map and camera controls (pan/zoom).
  - Supports custom styling for a dark, minimal basemap.

- **React bindings for MapLibre**
  - Either:
    - `react-map-gl` configured for MapLibre, or
    - A dedicated `react-maplibre` wrapper.
  - Provides React-friendly components for map rendering.

- **deck.gl**
  - WebGL visualization library layered on top of MapLibre.
  - Used for rendering rich overlays:
    - LineLayer for routes with per-segment coloring.
    - ScatterplotLayer / IconLayer for vehicle markers.
    - Additional layers for alerts, heat maps, etc.
  - Handles large numbers of objects efficiently and supports animation-friendly updates.

**Utility libraries:**

- **turf.js**
  - For geographical computations:
    - Snapping vehicles to nearest points on a shape.
    - Interpolating positions along polylines.
    - Calculating distances and segment lengths.

- **date-fns** or similar
  - Lightweight date utilities for formatting and relative time calculations.


### 2.3 Backend stack

**Runtime & framework:**

- **Node.js** (LTS version).
- **Express.js** + TypeScript:
  - Simple, familiar HTTP framework.
  - Easy to set up route handlers and middleware.
  - Works well with a small API surface.

**Key backend responsibilities:**

- Implement polling loops for MBTA endpoints.
- Maintain in-memory caches of:
  - Raw MBTA responses (or normalized forms).
  - Derived domain models (LineOverview, SystemInsights, etc.).
- Expose HTTP endpoints the frontend can call.
- Optionally connect to Redis/Postgres for shared or historical data.

**Supporting libraries:**

- HTTP client: `node-fetch` or `axios` (Codex-friendly and widely used).
- Caching helpers:
  - Custom in-memory caches using Maps, plus TTL logic.
  - Future: Redis client (`ioredis` or `redis` package) if needed.
- Validation & typing:
  - Basic runtime validation for external data (e.g., `zod` or manual checks) if we want stricter guarantees.

**Testing & tooling:**

- Jest or Vitest for unit tests (optional to detail later).
- ESLint + Prettier for consistent style.


### 2.4 Optional datastore

- **Redis (optional, v2+)**
  - Share MBTA caches across multiple backend instances.
  - Useful when horizontal scaling and uptime become important.

- **Postgres (optional, v2+)**
  - Store historical snapshots for analytics (e.g., reliability history, “last week’s performance”).
  - Not required for the initial real-time-focused app.


## 3. Service boundaries and APIs

### 3.1 Backend → MBTA

- Backend will communicate directly with the MBTA V3 API.
- It will:
  - Use route/station-level filters to reduce payloads.
  - Respect any documented rate limits.
  - Use exponential backoff or safe retries in case of errors.

MBTA endpoints backend uses (conceptually, not exhaustive):

- `GET /routes`, `GET /lines`, `GET /stops`, `GET /shapes`, `GET /route_patterns`, `GET /facilities` (static bootstrapping).
- `GET /predictions` with route/stop filters (real-time).
- `GET /vehicles` with route filters (real-time).
- `GET /alerts` (real-time service disruptions).
- `GET /live_facilities` (live parking/elevator data, where available).


### 3.2 Frontend → Backend

The frontend will not call MBTA directly. Instead, it will use our API, which returns already-aggregated domain models.

Example endpoints (detailed definitions in `05-backend-api-design-and-polling-strategy.md`):

- `GET /api/lines`
  - Returns a list of line summaries (name, color, basic status).

- `GET /api/lines/:lineId/overview`
  - Returns `LineOverview` for a line (segments, KPIs, alerts).

- `GET /api/stations/:stopId/board`
  - Returns `StationBoard` for a given stop/station.

- `GET /api/vehicles/:routeId`
  - Returns a list of `VehicleSnapshot` for a route/line, ready to plot.

- `GET /api/system/insights`
  - Returns `SystemInsights` for all lines and top trouble segments.

- `POST /api/trip-lens`
  - Takes a `TripLensRequest` and returns candidate `TripLensOption[]`.


## 4. Application structure (monorepo layout)

We can use a simple monorepo layout to keep frontend and backend together:

```text
/ (repo root)
├─ docs/
│  ├─ 01-product-spec-and-ux.md
│  ├─ 02-mbta-api-and-data-overview.md
│  ├─ 03-data-models-and-types.md
│  └─ 04-architecture-and-stack.md
├─ backend/
│  ├─ src/
│  │  ├─ index.ts          # app entry (Express server)
│  │  ├─ mbta-client/      # low-level MBTA HTTP client code
│  │  ├─ polling/          # polling jobs and cache updates
│  │  ├─ models/           # TypeScript interfaces (raw + derived)
│  │  └─ routes/           # Express route handlers (/api/...)
│  ├─ package.json
│  └─ tsconfig.json
├─ frontend/
│  ├─ app/ OR pages/       # Next.js routes
│  ├─ src/
│  │  ├─ components/
│  │  ├─ hooks/
│  │  ├─ lib/              # API client wrappers, types
│  │  └─ styles/
│  ├─ package.json
│  └─ tsconfig.json
├─ package.json            # optional root scripts
└─ README.md
```

This layout:

- Keeps frontend and backend concerns clearly separated.
- Allows sharing model types via a small shared module later (e.g., `/shared/` or separate package).


## 5. Scalability and performance considerations

### 5.1 Keeping MBTA usage light

- **Centralized polling:** Only the backend talks to MBTA. 1000 users looking at Red Line still results in a single MBTA request per poll interval, not 1000.
- **Filter aggressively:** Use `filter[route]`, `filter[stop]`, etc., to avoid requesting the entire system when we only need a subset.
- **Adjustable intervals:** Polling intervals are configurable per resource (predictions, vehicles, alerts, facilities). We can tune them to balance freshness and traffic.
- **Cache TTLs:** Derived models (LineOverview, StationBoard) have TTLs that avoid recomputing more often than necessary.

### 5.2 Backend scalability

- Stateless backend instances reading shared data from:
  - In-memory caches (per instance) for small deployments.
  - Redis for larger deployments requiring clustering.
- Horizontal scaling via container orchestration or PaaS (e.g., Render, Fly.io, etc.).
- Eventually, we can separate the polling/aggregation worker from the HTTP API if needed (two-process architecture).


### 5.3 Frontend performance

- Map rendering handled via MapLibre + deck.gl (GPU accelerated).
- Use `TanStack Query` caching and background refetching to avoid unnecessary API calls.
- Only render detailed overlays (e.g., full vehicle sets, per-station detail) when zoomed in or when selected.
- Use React Suspense/loading states where appropriate for smoother UX.


## 6. Future evolution

The chosen stack leaves room for the following future improvements without major rewrites:

- WebSockets or Server-Sent Events for pushing updates from backend to frontend.
- Historical analysis and replay using Postgres or a time-series database.
- Stronger type sharing via a dedicated `@mbta-system-radar/types` package.
- Theming and white-labeling (e.g., for other agencies using similar architectures).

This architecture is intended to be clear, maintainable, and friendly to both human developers and AI assistants that will generate and refactor code based on these docs.
