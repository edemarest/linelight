# Architecture & Stack

File: `docs/architecture/architecture-and-stack.md`

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

- **Package manager:** `npm`.

**UI & styling:**

- **Tailwind CSS**
  - Utility-first CSS framework.
  - Great for quickly building a consistent dark theme with glowy accents.
  - Plays well with componentization and our design system doc.

- **Framer Motion:** Smooth animations (panels, overlays, state transitions).

**Data fetching and state:**

- **TanStack Query (React Query)**
  - Handles async data fetching from our backend endpoints.
  - Will be used for:
    - `useQuery` hooks for line overviews, station boards, system insights.
    - Caching, deduplication, background refetching, and `staleTime` / `refetchInterval` control.
  - Perfect for our “lightweight polling” design.

- **Local state management:** React state + context for UI toggles and filters.

**Map & visualization:**

- **MapLibre GL JS**
  - Open-source, WebGL-based map engine for vector tiles.
  - Provides the base map and camera controls (pan/zoom).
  - Supports custom styling for a dark, minimal basemap.

- **react-map-gl:** React bindings for MapLibre.

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

Example endpoints (detailed definitions in `docs/architecture/backend-api-and-polling-strategy.md`):

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
│  ├─ README.md
│  ├─ architecture/
│  ├─ data/
│  ├─ deployment/
│  ├─ development/
│  ├─ plans/
│  └─ product/
├─ backend/
│  ├─ src/
│  │  ├─ index.ts          # app entry (Express server)
│  │  ├─ mbta/             # MBTA client + integration helpers
│  │  ├─ polling/          # polling jobs and cache updates
│  │  ├─ models/           # TypeScript interfaces (raw + derived)
│  │  └─ services/         # application services and API handlers
│  ├─ package.json
│  └─ tsconfig.json
├─ web/
│  ├─ src/
│  │  ├─ components/
│  │  ├─ hooks/
│  │  ├─ lib/              # API client wrappers, types
│  │  └─ app/              # Next.js app router
│  ├─ package.json
│  └─ tsconfig.json
├─ packages/
│  └─ core/                # shared types + API helpers
├─ package.json
└─ README.md
```

This layout:

- Keeps frontend and backend concerns clearly separated.
- Uses `packages/core` for shared model types and API helpers.


## 5. Summary

TypeScript end-to-end. React + Next.js frontend talks to Node.js + Express backend. MapLibre + deck.gl for mapping. TanStack Query for data fetching. Backend centralizes MBTA polling and caching.
