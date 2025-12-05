# Backend API Design & Polling Strategy

File: `docs/05-backend-api-design-and-polling-strategy.md`

This document defines:

- The responsibilities of the backend service.
- The REST API it exposes to the frontend.
- How it polls MBTA V3 endpoints and caches data.
- How we keep requests lightweight and reliable.
- Error handling and room for future real-time push (SSE/WebSockets).


## 1. Backend responsibilities

The backend is intentionally **thin** but **smart**:

- Acts as the **sole client** of the MBTA V3 API.
- Runs **polling loops** to fetch and normalize MBTA data.
- Maintains **in-memory caches** (and optionally Redis) for:
  - Raw MBTA responses (or normalized forms).
  - Derived domain models (LineOverview, StationBoard, VehicleSnapshot, SystemInsights, etc.).
- Exposes **simple JSON endpoints** in our own domain model shapes.
- Applies **rate limiting / backoff** toward MBTA when necessary.
- Handles partial failures gracefully (serving last-known-good data when possible).


## 2. REST API surface (frontend-facing)

All endpoints are versioned under `/api`. We can start with `/api/v1` as a prefix if desired, but for now we assume `/api` as the base.

### 2.1 `GET /api/lines`

**Purpose:**

- Provide a lightweight list of lines with high-level status for the sidebar / line selector.

**Response shape:**

```ts
interface GetLinesResponse {
  lines: {
    lineId: LineId;
    displayName: string;
    color: string;
    mode: Mode;
    hasAlerts: boolean;
    health: SegmentHealth; // overall line health summary
  }[];
  generatedAt: IsoTimestamp;
}
```

**Implementation notes:**

- Derived from cached `LineOverview` models (section 3).
- Quick to compute or read directly from cache.


### 2.2 `GET /api/lines/:lineId/overview`

**Purpose:**

- Fetch a complete `LineOverview` for a single line (used for the right-side panel and map-coloring logic).

**Response shape:**

```ts
interface GetLineOverviewResponse {
  line: LineOverview;
}
```

**Implementation notes:**

- Uses precomputed `LineOverview` from cache, refreshed periodically by a polling job.
- May include route/shape IDs or polyline strings needed for segments.


### 2.3 `GET /api/stations/:stopId/board`

**Purpose:**

- Return a `StationBoard` for a specific stop or station ID, ready for station view UI.

**Response shape:**

```ts
interface GetStationBoardResponse {
  board: StationBoard;
}
```

**Implementation notes:**

- Uses cached predictions, schedules, alerts, facilities, and live facilities.
- Station board may be computed on demand because it is scoped to one stop:
  - Use cached raw MBTA data; do not fetch MBTA inside this request handler.
  - Cache the `StationBoard` result for a short TTL (e.g. 10–20 seconds per stop).


### 2.4 `GET /api/vehicles/:lineOrRouteId`

**Purpose:**

- Provide a list of `VehicleSnapshot` objects for a given line or route, for map rendering.

**Response shape:**

```ts
interface GetVehiclesResponse {
  vehicles: VehicleSnapshot[];
  generatedAt: IsoTimestamp;
}
```

**Implementation notes:**

- Filter cached vehicles by route/line ID.
- Optionally compute interpolation along shapes (using predictions + shapes) before returning.


### 2.5 `GET /api/system/insights`

**Purpose:**

- Return system-level metrics and trouble segments for the Insights view.

**Response shape:**

```ts
interface GetSystemInsightsResponse {
  insights: SystemInsights;
}
```

**Implementation notes:**

- Computed periodically as part of polling loop or via a separate scheduled job.
- Frontend typically refreshes this on a slower interval (e.g. 60–120 seconds).


### 2.6 `POST /api/trip-lens`

**Purpose:**

- Accept a `TripLensRequest` and return `TripLensOption[]` for station-to-station reliability-aware trip choices.

**Request shape:**

```ts
interface TripLensRequestBody extends TripLensRequest {}
```

**Response shape:**

```ts
interface TripLensResponse {
  options: TripLensOption[];
  generatedAt: IsoTimestamp;
}
```

**Implementation notes:**

- Uses cached predictions, schedules, and line/segment models.
- For v1, keep routing logic simple (1–2 transfer options max).


### 2.7 `GET /api/meta/config`

**Purpose:**

- Provide metadata and configuration used by the frontend (e.g., default lines to show, zoom levels, etc.).

**Response shape:**

```ts
interface GetMetaConfigResponse {
  defaultLineId: LineId | null;
  supportedModes: Mode[];
  map: {
    defaultCenter: LatLng;
    defaultZoom: number;
  };
}
```

**Implementation notes:**

- Static or rarely changing values; can be loaded from config files or environment variables.


## 3. Polling strategy (backend → MBTA)

The backend runs polling loops for the MBTA V3 API. These loops:

- Use **filters** to narrow data (by route, stop, etc.).
- Run at different **intervals** depending on resource type.
- Update in-memory caches and derived models.

### 3.1 General polling design

- Each poller is a small module with:
  - `intervalMs`: how often it runs.
  - `fetchFn()`: fetches from MBTA API.
  - `updateCacheFn()`: merges/normalizes data.
- Pollers are started at server boot:
  - They schedule `setInterval` or use a central scheduler.
- On error:
  - Log error with context.
  - Do not wipe existing cache; keep last-known-good data if available.
  - Optionally track last successful update time for health checks.


### 3.2 Static bootstrapping pollers

These can run once on startup and occasionally refresh (e.g., every few hours or once per day).

- `routes`:
  - Endpoint: `GET /routes`
  - Interval: on startup + every 6–24 hours.
- `lines`:
  - Endpoint: `GET /lines`
  - Interval: on startup + every 6–24 hours.
- `stops`:
  - Endpoint: `GET /stops`
  - Interval: on startup + every 6–24 hours.
- `shapes`:
  - Endpoint: `GET /shapes` (possibly by route or route_pattern).
  - Interval: on startup + every 6–24 hours.
- `route_patterns`:
  - Endpoint: `GET /route_patterns`
  - Interval: on startup + every 6–24 hours.
- `facilities`:
  - Endpoint: `GET /facilities`
  - Interval: on startup + every 6–24 hours.

These populate baseline topology and facility metadata caches.


### 3.3 Real-time pollers

**Predictions poller:**

- **Endpoint:** `GET /predictions`
- **Filters:** `filter[route]=...` (comma-separated list of selected routes, or all MBTA subway routes as a starting point).
- **Interval:** 10–20 seconds (configurable).
- **Behavior:**
  - Fetch predictions for all targeted routes.
  - Normalize into a structure keyed by `stopId`, `tripId`, and `routeId`.
  - Store in cache with `generatedAt` timestamp.
  - Trigger recomputation of:
    - Headway metrics (per segment and per line).
    - Preliminary inputs for `LineOverview` and `StationBoard` generation.

**Vehicles poller:**

- **Endpoint:** `GET /vehicles`
- **Filters:** `filter[route]=...` similar to predictions poller.
- **Interval:** 15–30 seconds (configurable).
- **Behavior:**
  - Fetch vehicle positions for the same set of routes.
  - Normalize into `MbtaVehicle` map keyed by `vehicleId`.
  - Attach `tripId` and `routeId` relations for mapping to predictions and shapes.
  - Optionally compute `VehicleSnapshot` objects immediately or lazily on request.

**Alerts poller:**

- **Endpoint:** `GET /alerts`
- **Filters:** none or optionally filter by route types.
- **Interval:** 60–120 seconds (configurable).
- **Behavior:**
  - Fetch all current alerts.
  - Normalize them into a structure keyed by `routeId`, `stopId`, and `facilityId` using informed entities.
  - Feed into line/segment/station alert summaries.

**Live facilities poller:**

- **Endpoint:** `GET /live_facilities`
- **Filters:** none or filtered by facility type if supported.
- **Interval:** 60–300 seconds (configurable).
- **Behavior:**
  - Fetch current statuses for facilities (especially parking).
  - Map them to facilities/stations for `StationBoard` and accessibility layers.

**Optional future pollers:**

- `occupancies` if MBTA exposes crowding as a separate resource.
- Additional resources as needed.


## 4. Caching strategy

### 4.1 In-memory caches

For v1, in-memory caches are sufficient. Each cache:

- Is an object/map keyed by an appropriate ID (e.g., `routeId`, `stopId`, `vehicleId`).
- Stores:
  - Last fetched raw MBTA data (simplified).
  - Derived domain models (LineOverview, SystemInsights, etc.).
  - Metadata such as `generatedAt` and TTL/expiry info.

Example:

```ts
interface CacheEntry<T> {
  value: T;
  generatedAt: IsoTimestamp;
  ttlMs: number;
}

const predictionsCache: CacheEntry<NormalizedPredictions> | null = null;
const lineOverviewCache: Map<LineId, CacheEntry<LineOverview>> = new Map();
```

**TTL rules:**

- `predictions`: short TTL, e.g., 30 seconds.
- `vehicles`: short TTL, e.g., 30 seconds.
- `alerts`: medium TTL, e.g., 120 seconds.
- `live_facilities`: medium TTL, e.g., 120–300 seconds.
- `LineOverview`: same or slightly longer TTL than predictions.
- `StationBoard`: computed on demand, TTL ~10–20 seconds per stop.

### 4.2 Redis (future enhancement)

- To support multiple backend instances:
  - Replace in-memory caches with Redis-backed caches for shared state.
  - Polling can be centralized in one instance or run in all with locks to avoid duplication.


## 5. Error handling & fallbacks

### 5.1 MBTA fetch failures

- For each poller:
  - On HTTP/network error:
    - Log error (message, endpoint, filter params, timestamp).
    - Do **not** clear existing cache; keep last successful snapshot.
  - Maintain `lastSuccessfulUpdateAt` per resource family.
- Expose basic health info on an internal endpoint (e.g., `/internal/health`) for observability.

### 5.2 Partial data

- If some resources are missing (e.g., predictions but not schedules):
  - The backend should still respond with partial models where possible.
  - Mark fields like `headwayMinutes` or `predictedTime` as `null` and adjust reliability flags to `"unknown"`.
- The frontend is expected to handle missing fields gracefully and fall back to schedules-only views when needed.

### 5.3 StationBoard-specific fallbacks

- If predictions are temporarily unavailable for a stop:
  - Use schedules to provide upcoming times where possible.
  - Clearly distinguish scheduled vs predicted times in flags/labels.

### 5.4 Rate limiting and backoff

- If the MBTA API returns 429 or server errors:
  - Back off the polling interval for the affected resource.
  - Optionally use jitter to avoid synchronized retries.
  - Maintain last-known-good data in caches during backoff.


## 6. Future real-time push (SSE / WebSockets)

While v1 uses polling from the frontend → backend, the architecture is compatible with push-based updates later.

Options:

- **Server-Sent Events (SSE):**
  - Backend maintains a stream for subscribed clients.
  - Whenever a cache is updated, a minimal diff or “updatedAt” notice is sent.
  - Frontend listens and triggers local refetch for specific resources.

- **WebSockets:**
  - Backend pushes updated domain models (or partials) directly to clients.
  - Frontend updates state based on events instead of (or in addition to) polling.

For now:

- Keep the internal data structures and pub/sub patterns loosely decoupled so we can bolt SSE/WebSockets on later without rewrites.
- TanStack Query can integrate with push-based flows using `queryClient.setQueryData` when messages arrive.


## 7. Summary

- The backend exposes a **small, opinionated API** tailored to our app’s needs, hiding MBTA’s JSON:API complexity.
- It uses **centralized polling, caching, and aggregation** to keep MBTA load low and serve data quickly to many clients.
- Caches and TTLs are tuned by resource type (predictions, vehicles, alerts, facilities).
- The design anticipates future enhancements like Redis-backed caches and server-to-client push without major architectural changes.
