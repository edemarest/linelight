# Data Models & Types

File: `docs/03-data-models-and-types.md`

This document defines the core TypeScript data models used in the project. It builds on the conceptual overview in `02-mbta-api-and-data-overview.md` and focuses on:

- **Raw API shapes** we expect from the MBTA V3 API (simplified, not full specs).
- **Derived domain models** we will expose to the frontend from our backend.
- **Mapping rules** between MBTA resources and our own types.
- **Conventions** for IDs, timestamps, and enums.


## 1. Conventions

### 1.1 General TypeScript conventions

- Interfaces are `PascalCase` (`Route`, `Line`, `StationBoard`).
- Type aliases are also `PascalCase` (`LineId`, `StopId`).
- Enums are `PascalCase` (`RouteType`, `AlertEffect`).
- We lean toward simple string unions for certain small enumerations where clarity beats flexibility.

### 1.2 ID and timestamp types

- IDs (routes, stops, trips, vehicles, etc.) are all typed as `string`, with aliases for semantic meaning:

  ```ts
  type RouteId = string;
  type LineId = string;
  type StopId = string;
  type TripId = string;
  type VehicleId = string;
  type AlertId = string;
  type FacilityId = string;
  ```

- Timestamps from the MBTA API are treated as ISO strings:

  ```ts
  type IsoTimestamp = string; // e.g., "2025-01-01T12:34:56-05:00"
  ```

- We will parse them into `Date` objects only when necessary; otherwise they remain strings for cheaper transport and caching.


## 2. Simplified raw MBTA API types

These interfaces approximate the subset of MBTA fields we care about. They are not exact or exhaustive representations of the MBTA JSON:API specification.

The actual HTTP responses are JSON:API documents (with `data`, `attributes`, `relationships`, `included`). We will typically:

1. Decode them into these “raw” interfaces in the backend.
2. Map them further into our **derived domain models** before exposing them to the frontend.


### 2.1 Routes and lines

```ts
interface MbtaRouteAttributes {
  short_name: string | null;
  long_name: string;
  description: string | null;
  type: number;           // mode type (subway, bus, etc.)
  color: string | null;   // hex without leading '#', e.g. "DA291C"
  text_color: string | null;
  sort_order: number | null;
}

interface MbtaRoute {
  id: RouteId;
  type: "route";
  attributes: MbtaRouteAttributes;
}

interface MbtaLineAttributes {
  short_name: string | null;
  long_name: string;
  color: string | null;
  text_color: string | null;
}

interface MbtaLine {
  id: LineId;
  type: "line";
  attributes: MbtaLineAttributes;
  // relationships.routes will link to MbtaRoute ids
}
```


### 2.2 Stops

```ts
interface MbtaStopAttributes {
  name: string;
  description: string | null;
  latitude: number;
  longitude: number;
  wheelchair_boarding: number | null; // 0/1/2 per GTFS
  platform_code?: string | null;
  platform_name?: string | null;
  zone_id?: string | null;
}

interface MbtaStop {
  id: StopId;
  type: "stop";
  attributes: MbtaStopAttributes;
  // relationships.parent_station may refer to a parent stop id
}
```


### 2.3 Trips

```ts
interface MbtaTripAttributes {
  headsign: string | null;
  direction_id: 0 | 1;
  wheelchair_accessible?: number | null;
  bikes_allowed?: number | null;
}

interface MbtaTrip {
  id: TripId;
  type: "trip";
  attributes: MbtaTripAttributes;
  // relationships.route, relationships.service, relationships.shape, etc.
}
```


### 2.4 Schedules

```ts
interface MbtaScheduleAttributes {
  arrival_time: IsoTimestamp | null;
  departure_time: IsoTimestamp | null;
  stop_sequence: number;
  pickup_type?: number | null;
  drop_off_type?: number | null;
}

interface MbtaSchedule {
  id: string;
  type: "schedule";
  attributes: MbtaScheduleAttributes;
  // relationships.route, relationships.trip, relationships.stop, relationships.service
}
```


### 2.5 Shapes

For shapes, we rarely need the JSON:API representation; instead we focus on the list of points.

```ts
interface MbtaShapeAttributes {
  // Each point is typically represented by multiple attributes in GTFS;
  // in our backend we may normalize it into a simpler array structure.
  polyline?: string | null; // if provided; otherwise, individual points
}

interface MbtaShape {
  id: string;
  type: "shape";
  attributes: MbtaShapeAttributes;
  // We will likely expand to a concrete list of coordinates.
}
```


### 2.6 Services

```ts
interface MbtaServiceAttributes {
  start_date: string; // yyyymmdd
  end_date: string;   // yyyymmdd
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
  // Exceptions live in related objects; we may ignore them for now.
}

interface MbtaService {
  id: string;
  type: "service";
  attributes: MbtaServiceAttributes;
}
```


### 2.7 Route patterns

```ts
interface MbtaRoutePatternAttributes {
  name: string;
  typicality: number | null;  // how representative it is
  direction_id: 0 | 1;
}

interface MbtaRoutePattern {
  id: string;
  type: "route_pattern";
  attributes: MbtaRoutePatternAttributes;
  // relationships.route, relationships.representative_trip, etc.
}
```


### 2.8 Facilities and live facilities

```ts
interface MbtaFacilityAttributes {
  name: string | null;
  description: string | null;
  type: string; // elevator, escalator, parking, etc.
  latitude?: number | null;
  longitude?: number | null;
}

interface MbtaFacility {
  id: FacilityId;
  type: "facility";
  attributes: MbtaFacilityAttributes;
  // relationships.stop, relationships.station, etc.
}

interface MbtaLiveFacilityAttributes {
  properties: Record<string, unknown>; // e.g., { available: number, capacity: number }
  updated_at: IsoTimestamp;
}

interface MbtaLiveFacility {
  id: string;
  type: "live_facility";
  attributes: MbtaLiveFacilityAttributes;
  // relationships.facility
}
```


### 2.9 Predictions

```ts
type ScheduleRelationship = "SCHEDULED" | "SKIPPED" | "ADDED" | "CANCELED" | "NO_DATA" | string;

interface MbtaPredictionAttributes {
  arrival_time: IsoTimestamp | null;
  departure_time: IsoTimestamp | null;
  status: string | null; // human-readable
  direction_id: 0 | 1;
  stop_sequence: number | null;
  schedule_relationship?: ScheduleRelationship | null;
}

interface MbtaPrediction {
  id: string;
  type: "prediction";
  attributes: MbtaPredictionAttributes;
  // relationships.route, relationships.trip, relationships.stop, relationships.vehicle, relationships.schedule
}
```


### 2.10 Vehicles

```ts
type VehicleCurrentStatus = "IN_TRANSIT_TO" | "STOPPED_AT" | "INCOMING_AT" | string;

interface MbtaVehicleAttributes {
  latitude: number | null;
  longitude: number | null;
  bearing: number | null;
  speed: number | null;
  current_status: VehicleCurrentStatus | null;
  current_stop_sequence: number | null;
  updated_at: IsoTimestamp;
}

interface MbtaVehicle {
  id: VehicleId;
  type: "vehicle";
  attributes: MbtaVehicleAttributes;
  // relationships.trip, relationships.route, relationships.stop
}
```


### 2.11 Alerts

```ts
type AlertLifecycle = "NEW" | "ONGOING" | "UPCOMING" | "LIFTED" | string;

interface MbtaAlertActivePeriod {
  start?: IsoTimestamp | null;
  end?: IsoTimestamp | null;
}

interface MbtaAlertAttributes {
  header_text: string | null;
  description_text: string | null;
  cause: string | null;
  effect: string | null;
  severity: number | null;
  lifecycle: AlertLifecycle | null;
  active_period: MbtaAlertActivePeriod[];
}

interface MbtaAlert {
  id: AlertId;
  type: "alert";
  attributes: MbtaAlertAttributes;
  // relationships.informed_entity will tell us which routes/stops/trips/facilities are affected
}
```


## 3. Derived domain models

These types represent the **clean, frontend-facing** view our backend will expose. They hide JSON:API details and bundle together all related MBTA resources into directly usable models.


### 3.1 Basic IDs and enums

```ts
type Mode = "subway" | "bus" | "commuter_rail" | "ferry" | "other";

interface LatLng {
  lat: number;
  lng: number;
}
```


### 3.2 Line overview and segment status

```ts
interface LineOverview {
  lineId: LineId;
  displayName: string;       // "Red Line"
  color: string;             // "#DA291C"
  mode: Mode;
  activeVehicles: number;
  expectedVehicles: number | null; // if we can estimate from schedules
  typicalHeadwayMinutes: number | null; // e.g., 6
  alerts: LineAlertSummary[];
  segments: SegmentStatus[];
  updatedAt: IsoTimestamp;
}

interface LineAlertSummary {
  alertId: AlertId;
  header: string;
  severity: number | null;
  effect: string | null;
  lifecycle: AlertLifecycle | null;
}

type SegmentHealth = "good" | "minor_issues" | "major_issues" | "no_service";

interface SegmentStatus {
  segmentId: string;
  fromStopId: StopId;
  toStopId: StopId;
  // Geometry indices or coordinates to render on the map
  polyline: string | null;     // encoded polyline or null if we use raw coords
  headwayMinutes: number | null;
  headwayDeviationMinutes: number | null; // actual vs scheduled
  averageSpeedKph: number | null;
  alerts: LineAlertSummary[];
  health: SegmentHealth;
}
```


### 3.3 Station board

```ts
interface StationBoard {
  stopId: StopId;
  name: string;
  location: LatLng;
  linesServed: LineId[];
  // Upcoming departures grouped by line and direction
  departuresByLine: LineDepartures[];
  alerts: LineAlertSummary[];
  accessibility: StationAccessibilitySummary;
  parking: StationParkingSummary | null;
  updatedAt: IsoTimestamp;
}

interface LineDepartures {
  lineId: LineId;
  directionId: 0 | 1;
  directionLabel: string; // "Inbound" / "Outbound" or similar
  departures: DeparturePrediction[];
}

interface DeparturePrediction {
  tripId: TripId;
  vehicleId: VehicleId | null;
  destination: string; // from trip headsign
  scheduledTime: IsoTimestamp | null;
  predictedTime: IsoTimestamp | null;
  countdownSeconds: number | null;
  crowdingLevel: "low" | "medium" | "high" | "unknown";
  reliabilityFlag: "normal" | "delayed" | "gap" | "unknown";
}

interface StationAccessibilitySummary {
  wheelchairBoarding: "unknown" | "not_accessible" | "partial" | "full";
  elevatorOutages: number;
  escalatorOutages: number;
  otherNotes: string[];
}

interface StationParkingSummary {
  facilityId: FacilityId;
  capacity: number | null;
  available: number | null;
  updatedAt: IsoTimestamp;
}
```


### 3.4 Vehicle snapshot

```ts
interface VehicleSnapshot {
  vehicleId: VehicleId;
  routeId: RouteId;
  lineId: LineId | null;
  mode: Mode;
  position: LatLng | null;
  bearing: number | null;
  speedKph: number | null;
  tripId: TripId | null;
  destination: string | null; // from trip headsign
  currentStatus: VehicleCurrentStatus | null;
  currentStopId: StopId | null;
  nextStopId: StopId | null;
  // Derived for rendering
  interpolatedOnShape: boolean;
  lastUpdate: IsoTimestamp;
  crowdingLevel: "low" | "medium" | "high" | "unknown";
}
```


### 3.5 System insights

```ts
interface SystemInsights {
  generatedAt: IsoTimestamp;
  lines: LineInsight[];
  topTroubleSegments: SegmentTroubleSummary[];
}

interface LineInsight {
  lineId: LineId;
  displayName: string;
  mode: Mode;
  painScore: number;               // composite metric (0–100)
  averageDelayMinutes: number | null;
  headwayVarianceMinutes: number | null;
  activeAlerts: number;
  activeVehicles: number;
}

interface SegmentTroubleSummary {
  lineId: LineId;
  segmentId: string;
  fromStopName: string;
  toStopName: string;
  description: string;             // e.g., "Long gap outbound between X and Y"
  severity: number;                // 1–10 or similar
}
```


### 3.6 Trip Lens models

```ts
interface TripLensRequest {
  originStopId: StopId;
  destinationStopId: StopId;
  // Future: time-of-day or date overrides
}

interface TripLensOption {
  optionId: string;
  description: string;   // e.g., "Red Line → Orange Line at Downtown Crossing"
  segments: TripLensSegment[];
  estimatedTravelTimeMinutes: number | null;
  travelTimeRangeMinutes: [number, number] | null;
  reliabilityScore: number | null; // 0–100
  primaryIssues: string[];         // user-facing reasons if reliability is low
}

interface TripLensSegment {
  lineId: LineId;
  fromStopId: StopId;
  toStopId: StopId;
  directionId: 0 | 1;
  scheduledTravelTimeMinutes: number | null;
  predictedTravelTimeMinutes: number | null;
  alerts: LineAlertSummary[];
}
```


## 4. Mapping rules

This section summarizes how we transform MBTA resources into our domain models.


### 4.1 Routes and lines → LineOverview

- Group MBTA `routes` into lines using `lines` relationships or configuration.
- For each line:
  - Use `routes` and `shapes` to determine geometry and segments.
  - Use `predictions` and `schedules` (filtered by those routes) to compute:
    - Active vehicles (from `vehicles`).
    - Typical headway per branch or aggregated.
    - Headway deviation from schedules.
  - Use `alerts` filtered by those routes to populate line alert summaries.
  - Derive `SegmentStatus` per defined segment along the shape(s).


### 4.2 Stops, predictions, schedules, alerts → StationBoard

- For a given stop/station:
  - Fetch `predictions` filtered by `stop` and `routes` serving that stop.
  - Group predictions by line and direction.
  - For each prediction:
    - Attach `trip` headsign to use as destination.
    - Attach `vehicle` (if available) and any occupancy/crowding info.
    - Compare predicted vs scheduled times for reliability flags.
  - Fetch `alerts` that apply to this stop or its routes.
  - Fetch `facilities` and `live_facilities` to derive accessibility and parking summaries.
  - Compose everything into a single `StationBoard` model.


### 4.3 Vehicles, trips, shapes, predictions → VehicleSnapshot

- For each `vehicle`:
  - Attach `trip`, `route`, and `line` from relationships.
  - Retrieve `shape` for the trip to know the underlying geometry.
  - Use latest `predictions` for that trip (or upcoming stops) to interpolate along the shape between stops.
  - Compute crowding level from any `occupancy` info if available.
  - Emit a `VehicleSnapshot` that the frontend can render directly.


### 4.4 Aggregates → SystemInsights

- Use cached predictions, vehicles, and alerts to compute per-line metrics:
  - Average delay vs schedule.
  - Headway variance.
  - Alert severity and counts.
- Rank segments with worst headway gaps or slow speeds to produce `topTroubleSegments`.
- Package into a `SystemInsights` object.


## 5. Summary

- The **raw MBTA types** mirror only the subset of fields we care about from the V3 API.
- The **derived domain models** (`LineOverview`, `StationBoard`, `VehicleSnapshot`, `SystemInsights`, `TripLensOption`) provide clean, ready-to-render structures for the frontend.
- The mapping logic lives in the backend, which transforms JSON:API responses into these models on a regular polling cadence and exposes them through our own REST endpoints.
