# LineLight Web Refactor Plan – Old App → Glance-First Web App

File: `docs/15-refactor-plan-web-app.md`

This document is a **migration map** for refactoring an existing LineLight codebase
into the new **web-only, glance-first** architecture described in docs 11–14.

The goal is to give an engineer (or AI assistant) a clear sequence of steps to:

1. Align the repo structure with the new web stack.
2. Introduce or update shared types and API contracts.
3. Implement the new MBTA ETA strategy.
4. Update the frontend to the new Home/Stop/Lines UX.


## 1. Current State (Assumptions)

We assume the current project has some or all of the following:

- A Node/Express backend that calls MBTA v3 directly from route handlers.
- A React frontend with some map and line-oriented views.
- ETAs possibly derived from `/predictions` only, or inconsistently from MBTA endpoints.
- No clear separation between:
  - Core models.
  - Backend services.
  - Frontend fetch helpers.

If your repo differs, adjust filename references accordingly but keep the overall sequence.


## 2. Target Architecture Snapshot

We want to end with:

- **Backend** (`backend/`):
  - TypeScript + Express.
  - Clean `/api/home`, `/api/stations/:id/board`, `/api/trips/:tripId/track` routes.
  - Internal MBTA integration modules and an ETA service that blends `/schedules` + `/predictions`.
- **Frontend** (`web/`):
  - React/Next.js + TypeScript.
  - Glance-first Home page, Stop Sheet, Lines view.
  - React Query for API calls.
- **Shared types** (`packages/core/` or similar):
  - TypeScript models for LineLight data contracts (doc 11).
  - Typed API helpers for the web frontend.


## 3. Step-by-Step Refactor Plan

### Step 1 – Create / Confirm Monorepo Layout

1. In the project root, create (if not present):

   ```text
   backend/
   web/
   packages/core/
   docs/
   ```

2. Add or update root `package.json` to use npm workspaces as outlined in doc 12.

3. Move existing backend into `backend/` and frontend into `web/` where necessary.

4. Ensure both can still run (even temporarily) after the move, even if in a “legacy” form.


### Step 2 – Introduce Shared Core Types (`@linelight/core`)

1. In `packages/core/`, create:

   - `src/models/` containing TypeScript definitions from `11-data-layer-and-api-reference.md`.
   - `src/api/` with stubs for `fetchHome`, `fetchStationBoard`, `fetchTripTrack`, etc.
   - `src/index.ts` exporting models and API helpers.

2. Add a `build` script and `tsconfig` as in doc 12.

3. Build the package:

   ```bash
   npm --workspace packages/core run build
   ```

4. Update backend and frontend to import LineLight models from `@linelight/core` instead of ad-hoc types (where feasible).


### Step 3 – Normalize Backend Endpoints

1. In `backend/`, define new or updated routes:

   - `GET /api/home`
   - `GET /api/stations/:id/board`
   - `GET /api/trips/:tripId/track`
   - Optionally `/api/lines`, `/api/lines/:id/overview`, `/api/system/insights`

2. For each route:

   - Create route handler files under `src/routes/` (e.g., `apiHome.ts`, `apiStations.ts`, `apiTrips.ts`).
   - Make handlers construct and return the corresponding models from `@linelight/core` (`HomeResponse`, `GetStationBoardResponse`, `TripTrackResponse`, etc.).

3. If the existing backend already has similar endpoints, refactor them to conform to the new response shapes without changing behavior yet (keep old ETA logic temporarily).


### Step 4 – Implement MBTA Integration & ETA Service

1. Create `backend/src/mbta/` folder with modules:

   - `client.ts` – thin HTTP client around MBTA v3 (base URL, API key, error handling).
   - `schedules.ts`, `predictions.ts`, `vehicles.ts`, `routes.ts`, `stops.ts`, `alerts.ts` – small, focused helper functions.

2. Create `backend/src/services/etaService.ts`:

   - Implement schedule and prediction blending logic as described in doc 14.
   - Expose functions like:
     - `getDeparturesForStop(stopId, now): StationDeparture[]`
     - `getSummaryEtasForStop(stopId, now): StationBoardRoutePrimary[]`

3. Update route services:

   - `homeService.ts` – uses `etaService` to build `HomeResponse` from nearby/favorite stops.
   - `stationBoardService.ts` – uses `etaService` to build `GetStationBoardResponse`.
   - `tripTrackService.ts` – uses `/vehicles`, `/predictions` and `etaService` to build `TripTrackResponse`.

4. Wire these services into route handlers, replacing any direct MBTA calls in the routes.


### Step 5 – Update Frontend to Use New Contracts

1. In `web/`, define API configuration:

   - `src/lib/config.ts` with `API_BASE_URL` from env.

2. Implement React Query hooks:

   - `useHome(position)` → `GET /api/home` → `HomeResponse`.
   - `useStationBoard(id, position?)` → `GET /api/stations/:id/board`.
   - `useTripTrack(tripId)` → `GET /api/trips/:tripId/track`.

3. Replace any legacy API calls with these hooks and `@linelight/core` types.

4. Implement or refactor the main screens to match doc 13:

   - `HomePage` – Home/Nearby UX.
   - `StopSheetPage` or panel – Stop Sheet UX.
   - `LinesPage` and `LineDetailPage` – optional, if you already have line views.


### Step 6 – Retire Legacy Code

Once the new endpoints and frontend views are working end-to-end:

1. Remove or archive legacy:
   - MBTA calling functions that bypass `etaService`.
   - Old endpoints that no longer match the LineLight contracts.
   - Old frontend components/pages that are superseded by the new Home/Stop/Lines.


## 4. Implementation Checklist

Use this checklist to track refactor progress:

### Backend

- [ ] Monorepo layout is in place (`backend`, `web`, `packages/core`, `docs`).
- [ ] `@linelight/core` is created and builds successfully.
- [ ] `/api/home` implemented to return `HomeResponse`.
- [ ] `/api/stations/:id/board` implemented to return `GetStationBoardResponse`.
- [ ] `/api/trips/:tripId/track` implemented to return `TripTrackResponse`.
- [ ] MBTA client and helpers implemented under `src/mbta/`.
- [ ] `etaService` implemented with schedule + prediction blending.
- [ ] Legacy direct MBTA calls removed from route handlers.

### Frontend

- [ ] API base URL configured (`NEXT_PUBLIC_API_BASE_URL`).
- [ ] React Query provider wired at app root.
- [ ] `useHome`, `useStationBoard`, `useTripTrack` hooks implemented.
- [ ] Home screen updated to glance-first layout using `HomeResponse`.
- [ ] Stop Sheet screen updated using `GetStationBoardResponse`.
- [ ] Lines/Insights screens wired to `/api/lines` and `/api/system/insights` (if implemented).
- [ ] Old views and APIs no longer used have been removed or archived.

### Docs

- [ ] Docs 11–14 kept in sync with code changes as models stabilize.
- [ ] This refactor plan (doc 15) updated with any deviations or decisions taken during implementation.


## 5. How to Use This Document with an AI Assistant

When engaging an AI assistant to continue the refactor:

1. Point it to docs:
   - `11-data-layer-and-api-reference.md`
   - `12-web-stack-and-project-setup.md`
   - `13-web-glance-first-ux-and-feature-spec.md`
   - `14-mbta-eta-strategy-and-integration-guide.md`
   - `15-refactor-plan-web-app.md` (this file)

2. Ask it to:
   - Confirm current repo layout and what already exists.
   - Execute **one step at a time** from Section 3, updating code and re-running builds/tests.
   - Keep types stable with doc 11 and route behavior aligned with docs 13–14.

This document should be updated if the target architecture or API contracts evolve, but the general migration shape should remain valid: **separate core types, isolate ETA logic, normalize backend APIs, and refactor the frontend around glance-first views.**
