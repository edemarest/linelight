# LineLight Data Layer & API Reference (Web-Only, Glance-First)

File: `docs/11-data-layer-and-api-reference.md`

This document defines the **data layer** and **API routes** for the web-only, glance-first LineLight
architecture. It is the contract between the backend and the web frontend.

LineLight wraps the MBTA v3 API behind a small set of **normalized, opinionated** endpoints.

- We **blend MBTA `/predictions` and `/schedules`** (and optionally `/vehicles`, `/alerts`) to compute
  robust ETAs.
- The frontend **never calls MBTA directly**; it only talks to these LineLight endpoints.
- All types here should be represented in a shared TypeScript module (e.g. `@linelight/core`).


## 1. Core Concepts & Models

The main conceptual entities are:

- **Home snapshot** – lightweight data for the Home/Nearby screen.
- **StationBoard** – stop-centric view with primary ETAs and deeper details.
- **TripTrack** – data to follow a specific trip.
- **LineOverview** – line-level health and headway metrics (for Lines view).
- **SystemInsights** – optional system-wide analytics (for Insights view).

ETAs in these models may come from **realtime predictions, static schedules, or a blend of both**.
Where relevant we expose the **source** of the ETA.


### 1.1 Common types

```ts
export type Mode = "subway" | "bus" | "commuter_rail" | "ferry" | "other";

export interface LatLng {
  lat: number;
  lng: number;
}

export type IsoTimestamp = string; // ISO-8601
```


### 1.2 ETA source & status

```ts
export type EtaSource = "prediction" | "schedule" | "blended" | "unknown";

export type ServiceStatus =
  | "on_time"
  | "delayed"
  | "cancelled"
  | "skipped"
  | "no_service"
  | "unknown";
```


## 2. Home Snapshot Types

Used by: `GET /api/home`


```ts
export interface HomeResponse {
  favorites: HomeStopSummary[];
  nearby: HomeStopSummary[];
  generatedAt: IsoTimestamp;
}

export interface HomeStopSummary {
  stopId: string;
  name: string;
  distanceMeters: number;
  modes: Mode[];
  routes: HomeRouteSummary[];
}

export interface HomeRouteSummary {
  routeId: string;       // e.g. "1", "Red"
  shortName: string;     // display name (e.g. "1", "Red Line")
  direction: string;     // "to Harvard Square"
  nextTimes: HomeEta[];  // up to ~3 ETAs
}

export interface HomeEta {
  etaMinutes: number | null; // minutes from now, rounded
  source: EtaSource;         // prediction vs schedule
  status: ServiceStatus;     // on_time, delayed, etc.
}
```


## 3. StationBoard Types

Used by: `GET /api/stations/:id/board`


```ts
export interface GetStationBoardResponse {
  primary: StationBoardPrimary;
  details?: StationBoardDetails;
}

export interface StationBoardPrimary {
  stopId: string;
  stopName: string;
  distanceMeters?: number;
  walkMinutes?: number;
  routes: StationBoardRoutePrimary[];
}

export interface StationBoardRoutePrimary {
  routeId: string;
  shortName: string;
  direction: string;           // e.g. "to Braintree"
  primaryEta: StationEta | null;
  extraEtas: StationEta[];     // additional upcoming departures
}

export interface StationEta {
  etaMinutes: number | null;
  scheduledTime?: IsoTimestamp;   // from /schedules
  predictedTime?: IsoTimestamp;   // from /predictions
  source: EtaSource;
  status: ServiceStatus;
}
```

Below-the-fold details (lazy or same payload, rendered later):

```ts
export interface StationBoardDetails {
  departures: StationDeparture[];
  alerts: StationAlert[];
  facilities: StationFacility[];
}

export interface StationDeparture {
  routeId: string;
  shortName: string;
  direction: string;
  destination: string;
  scheduledTime?: IsoTimestamp;
  predictedTime?: IsoTimestamp;
  etaMinutes?: number | null;
  source: EtaSource;
  status: ServiceStatus;
}

export interface StationAlert {
  id: string;
  severity: "minor" | "moderate" | "major";
  header: string;
  description?: string;
  effect: string; // e.g. "station_closure", "shuttle_bus"
}

export interface StationFacility {
  id: string;
  type: "elevator" | "escalator" | "parking" | "other";
  status: "available" | "unavailable" | "limited" | "unknown";
  description?: string;
  capacity?: number;
  available?: number;  // e.g. parking spaces
}
```


## 4. TripTrack Types

Used by: `GET /api/trips/:tripId/track` (for “follow this vehicle/trip”).

```ts
export interface TripTrackResponse {
  tripId: string;
  routeId: string;
  destination: string;
  vehicle?: TripVehicle;
  upcomingStops: TripUpcomingStop[];
}

export interface TripVehicle {
  id: string;
  position: LatLng;
  bearing?: number;
  lastUpdated: IsoTimestamp;
}

export interface TripUpcomingStop {
  stopId: string;
  stopName: string;
  etaMinutes: number | null;
  source: EtaSource;
}
```


## 5. Lines & System Insights Types

Used by: `/api/lines`, `/api/lines/:id/overview`, `/api/system/insights`


```ts
export interface LineSummary {
  id: string;            // "Red"
  shortName: string;     // "Red Line"
  mode: Mode;
  status: "good" | "minor" | "major" | "unknown";
}

export interface LineOverview {
  line: LineSummary;
  segments: LineSegmentHealth[];
  headwaySummary: HeadwaySummary;
  alerts: StationAlert[];
}

export interface LineSegmentHealth {
  segmentId: string;
  fromStopId: string;
  toStopId: string;
  status: "good" | "minor" | "major" | "unknown";
  notes?: string;
}

export interface HeadwaySummary {
  typicalHeadwayMinutes: number | null;
  observedHeadwayMinutes: number | null;
  reliabilityScore?: number; // 0–1
}

export interface SystemInsights {
  generatedAt: IsoTimestamp;
  lines: LineSummary[];
  worstSegments: LineSegmentHealth[];
  notes?: string;
}
```


## 6. Endpoint Index

All endpoints are under `/api`.

- **Primary glance-first endpoints**
  - `GET /api/home` – Home/Nearby snapshot.
  - `GET /api/stations/:id/board` – StationBoard for a stop.
  - `GET /api/trips/:tripId/track` – TripTrack (follow trip).

- **Lines & insights (secondary)**
  - `GET /api/lines` – list of lines.
  - `GET /api/lines/:id/overview` – detailed line health.
  - `GET /api/system/insights` – optional system-wide summary.

- **Trip planner (optional)**
  - `POST /api/trip-lens` – suggested trips + reliability context (not required for MVP).


## 7. Endpoint Specifications

### 7.1 `GET /api/home`

**Purpose**  
Return a **small snapshot** for the Home screen: nearby and favorite stops with a few upcoming ETAs per route.

**Query params**

- `lat` (required) – user latitude.
- `lng` (required) – user longitude.
- `radius` (optional) – search radius in meters.
- `limit` (optional) – max nearby stops (default ~10).

**Response**

- `200 OK` → `HomeResponse`
- `400 Bad Request` if lat/lng missing/invalid.
- `500 Internal Server Error` on unexpected errors.

**Implementation notes (backend)**

- Internally uses MBTA `/stops`, `/schedules`, `/predictions` to compute ETAs (see doc 14).  
- Should cache results for a short window to reduce MBTA load.


### 7.2 `GET /api/stations/:id/board`

**Purpose**  
Provide the Stop Sheet view for a given stop, with primary ETAs and optional details.

**Route params**

- `id` – stop ID (aligned with MBTA `stop_id` or parent station).

**Query params (optional)**

- `lat`, `lng` – if provided, used to compute `distanceMeters`, `walkMinutes`.

**Response**

- `200 OK` → `GetStationBoardResponse`
- `404 Not Found` if stop unknown.
- `500 Internal Server Error` for unexpected errors.

**Implementation notes**

- Above-the-fold: populate `primary.routes` as quickly as possible.  
- Below-the-fold: `details` can be computed at the same time or lazily, but belongs in this response.  
- Uses blended ETA logic; see doc 14 for schedule/prediction strategy.


### 7.3 `GET /api/trips/:tripId/track`

**Purpose**  
Provide data to follow a specific trip/vehicle on the map or in a banner.

**Route params**

- `tripId` – MBTA trip_id.

**Response**

- `200 OK` → `TripTrackResponse`
- `404 Not Found` if trip cannot be resolved.
- `500` on internal errors.

**Implementation notes**

- Relies on MBTA `/predictions` + `/vehicles` + `/stops`.  
- Intended for **short-lived polling** only when user is actively following a trip.


### 7.4 `GET /api/lines`

**Purpose**  
Return a list of lines for the Lines view.

**Response**

- `200 OK` → `LineSummary[]`


### 7.5 `GET /api/lines/:id/overview`

**Purpose**  
Return an overview of a line’s health, headways, and issues.

**Route params**

- `id` – line/route ID.

**Response**

- `200 OK` → `LineOverview`
- `404` if line unknown.


### 7.6 `GET /api/system/insights`

**Purpose**  
Optional system-wide status view; not required for the initial MVP.

**Response**

- `200 OK` → `SystemInsights`


### 7.7 `POST /api/trip-lens` (optional)

**Purpose**  
Suggest itineraries between origin and destination with reliability context.

**Body**

```ts
interface TripLensRequest {
  origin: LatLng | { stopId: string };
  destination: LatLng | { stopId: string };
  departureTime?: IsoTimestamp;
}
```

**Response**

- List of candidate trips (schema can be defined later).


## 8. Error Handling & Response Shape

All error responses should use a consistent structure:

```ts
export interface ErrorResponse {
  error: string;   // short code, e.g. "bad_request", "not_found"
  message?: string; // human-readable detail
}
```

Use appropriate HTTP status codes:

- `400` – invalid or missing parameters.
- `404` – unknown stop/line/trip.
- `429` – optional, if we rate-limit per client.
- `500` – internal errors, MBTA outages, etc.


## 9. Versioning & Extensibility

- Prefer adding **optional fields** to models instead of breaking existing fields.  
- If a breaking change is unavoidable, introduce `/api/v2/...` endpoints.  
- All models should live in a shared TypeScript module (e.g. `@linelight/core`) used by both backend and frontend.

This document is the **source of truth** for the backend API and the types consumed by the LineLight web frontend.
