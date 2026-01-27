# Trip Planner Progress

## Phase Status

- Phase 1: Backend trip planner service + endpoint — completed
- Phase 2: Backend caching + data fetch strategy — completed
- Phase 3: Backend tests (unit + contract) — completed
- Phase 4: Shared types + schema validation — completed
- Phase 5: Frontend data hook — completed
- Phase 6: Frontend UI entry + modal — completed
- Phase 7: Map preview layers — completed
- Phase 8: Results UI (primary + alternates) — completed
- Phase 9: UX state handling — pending
- Phase 10: Integration tests — pending
- Phase 11: Performance + error handling — pending
- Phase 12: End-to-end verification — pending

## Phase 1 Log

- Added formal spec: `docs/plans/trip-planner.md`
- Added trip planner service + endpoint (`/api/trip-planner`)
- Verified endpoint returns summary + legs for a sample subway query

## Phase 2 Log

- Added in-memory caching for station stop lookup + route graph (TTL-based)
- Added note to migrate caches to Redis when scaling

## Phase 3 Log

- Added trip planner tests covering realtime + schedule fallback
- Updated backend test runner to include all tests

## Phase 4 Log

- Added shared trip planner types + validation helper in `packages/core`
- Backend now validates trip planner payloads before responding
- Backend Docker image now includes `@linelight/core` package at runtime

## Phase 5 Log

- Added trip planner API client with shared response validation
- Added React Query hook for trip planner requests

## Phase 6 Log

- Added Trip Planner modal with start/destination inputs, saved location suggestions, and loading states
- Wired Trip Planner entry button into the Map Spotlight header

## Phase 7 Log

- Added trip preview map with line segment and walking path overlays
- Fit map preview bounds to the trip response map bounds

## Phase 8 Log

- Added primary + alternate route cards with leg timelines and summary stats
- Added selection-driven map highlighting for the active route
