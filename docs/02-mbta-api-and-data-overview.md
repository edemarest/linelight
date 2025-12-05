# MBTA API & Data Overview

File: `docs/02-mbta-api-and-data-overview.md`

This document summarizes the MBTA V3 API resources that matter for this project, what they conceptually return, and how we plan to use them. It is written for humans and AI assistants and intentionally avoids raw JSON dumps in favor of clear, structured descriptions.

We assume the MBTA V3 API is available at a base URL such as:

- `https://api-v3.mbta.com`


## 1. API basics

### 1.1 JSON:API format

The MBTA V3 API uses the JSON:API convention. Typical responses look like:

- `data`: an array or single resource.
- `data[].id`: resource ID (string).
- `data[].type`: resource type name (e.g., `"route"`, `"stop"`).
- `data[].attributes`: the fields for that resource.
- `data[].relationships`: links to related resources (e.g., route ↔ trips).
- `included`: optional array of related resources when using `include` parameter.

Common query parameters used across endpoints:

- `filter[...]`: filter by route, stop, trip, direction, date, etc.
- `include`: request related resources to be included in the `included` array.
- `fields[resource]`: request only specific fields for a resource type.
- `sort`: sort by an attribute (e.g., `departure_time`, `updated_at`).
- `page[limit]`, `page[offset]`: pagination controls.


### 1.2 Static vs real‑time data

We treat MBTA data in two major categories:

- **Static / schedule / topology data**
  - Routes, lines, stops, trips, schedules, shapes, services, facilities, route patterns.
  - Derived from GTFS static feeds; changes only when service patterns change.
- **Real‑time data**
  - Predictions (arrival/departure times), vehicles (locations), alerts (disruptions), live facilities (parking/elevator status), occupancies (crowding).
  - Derived from GTFS‑Realtime feeds; updated frequently throughout the day.


## 2. Core static resources

These resources define network structure, timetables, and facilities. They change slowly (schedule changes, service adjustments).


### 2.1 `routes`

**Endpoint examples:**

- `GET /routes`
- `GET /routes/{id}`

**Concept:**

- A **route** is a service line in GTFS terms: e.g., Red Line, Orange Line, Bus Route 1.
- It describes mode, branding, and basic naming, but not the full geometry.

**Key fields we care about (attributes):**

- `id`: route identifier (e.g., `"Red"`, `"1"`).
- `type`: numeric mode type (subway, bus, commuter rail, ferry).
- `short_name`, `long_name`: route names.
- `description`: descriptive text.
- `color`, `text_color`: hex colors for display.
- `sort_order`: order for UI lists.

**How we use it:**

- Build lists of routes/lines for filters and navigation.
- Determine display colors and labels.
- Group resources by route when fetching predictions and vehicles.


### 2.2 `lines`

**Endpoint examples:**

- `GET /lines`
- `GET /lines/{id}`

**Concept:**

- A **line** is a higher‑level grouping of one or more routes (e.g., “Green Line” composed of B/C/D/E branches).
- Helps us treat multi‑branch systems as a single entity in the UI.

**Key fields:**

- `id`: line ID.
- `short_name`, `long_name`: line names.
- `color`, `text_color`.
- Relationships to member `routes`.

**How we use it:**

- Provide a single “line selector” in the UI for users (e.g., “Green Line”), even when multiple route IDs exist under the hood.
- Support line‑level dashboards and insights.


### 2.3 `stops`

**Endpoint examples:**

- `GET /stops`
- `GET /stops/{id}`

**Concept:**

- A **stop** is a distinct boarding/alighting location; some stops are part of larger stations.
- Includes latitude/longitude and accessibility indicators.

**Key fields:**

- `id`: stop ID.
- `name`: stop or station name.
- `latitude`, `longitude`.
- `description` (if present).
- `wheelchair_boarding`: accessibility status.
- `platform_code`, `platform_name`, `zone_id` (where applicable).
- Relationship to parent station (stop vs station hierarchy).

**How we use it:**

- Draw station markers on the map.
- Calculate nearest station to user location.
- Attach predictions, alerts, facilities, and trip info to physical locations.


### 2.4 `trips`

**Endpoint examples:**

- `GET /trips`
- `GET /trips/{id}`

**Concept:**

- A **trip** is a single run of a vehicle following a specific route and pattern (e.g., a particular train from Braintree to Alewife at 8:05am).
- Connects routes, stops, schedules, predictions, and vehicles.

**Key fields:**

- `id`: trip ID.
- `headsign`: destination or direction label (“Alewife”, “Forest Hills”, etc.).
- `direction_id`: direction index (0 or 1).
- `wheelchair_accessible`, `bikes_allowed`.
- Relationships to:
  - `route`
  - `service` (calendar)
  - `shape`
  - `predictions`
  - `route_pattern`
  - `stops` (via schedules/predictions)

**How we use it:**

- Bind vehicle positions and predictions to a logical journey.
- Display destination/headsings in station boards and trip views.
- Map vehicle positions onto shapes between stops.


### 2.5 `schedules`

**Endpoint examples:**

- `GET /schedules`

**Concept:**

- A **schedule** record is a scheduled arrival and departure time of a trip at a specific stop.
- Essentially a GTFS `stop_times` row exposed through the API.

**Key fields:**

- `arrival_time`, `departure_time`: scheduled times.
- `stop_sequence`: position along the trip.
- `pickup_type`, `drop_off_type`: boarding rules.
- Relationships to:
  - `route`
  - `trip`
  - `stop`
  - `service`

**How we use it:**

- Compare real‑time predictions against scheduled times to infer delays.
- Approximate expected headways when predictions are missing.
- Compute reliability metrics by comparing scheduled vs actual service.


### 2.6 `shapes`

**Endpoint examples:**

- `GET /shapes`
- `GET /shapes/{id}`

**Concept:**

- A **shape** is an ordered list of geographic points describing the path a trip follows.
- Used to draw lines on the map.

**Key fields:**

- Points along the shape with latitude, longitude.
- Distance along shape (cumulative).
- Relationship to trips that use this shape.

**How we use it:**

- Render route geometry on the map.
- “Snap” vehicle positions to the route line.
- Interpolate positions between stops using predictions and shape distances.


### 2.7 `services`

**Endpoint examples:**

- `GET /services`
- `GET /services/{id}`

**Concept:**

- A **service** represents a schedule calendar: which days a set of trips run.
- Tells us whether a trip is active on a given date.

**Key fields:**

- Service ID.
- Start and end dates.
- Day‑of‑week patterns.
- Exceptions / added/removed dates.

**How we use it:**

- Ensure we only consider trips that are valid for the current date.
- Potentially explain anomalies related to special service patterns.


### 2.8 `route_patterns`

**Endpoint examples:**

- `GET /route_patterns`
- `GET /route_patterns/{id}`

**Concept:**

- A **route pattern** describes a variant of service on a route (short turns, branches, express variants).
- Useful for lines like the Green Line where multiple patterns share tracks but diverge at branches.

**Key fields:**

- Pattern ID and name.
- Direction.
- Representative stops / shape.
- Relationship to routes and trips.

**How we use it:**

- Distinguish branches and short‑turn services in UI and insights.
- Build segment definitions for headway and slow‑segment metrics.


### 2.9 `facilities`

**Endpoint examples:**

- `GET /facilities`
- `GET /facilities/{id}`

**Concept:**

- A **facility** is a physical amenity: elevator, escalator, parking garage, bike storage, etc.
- Some facilities have real‑time status available via `live_facilities` or alerts.

**Key fields:**

- Facility ID and type (elevator, parking, etc.).
- Location and associated stops or stations.
- Descriptive metadata (name, capacity, etc.).

**How we use it:**

- Show accessibility features and parking availability for stations.
- Combine with alerts/live data to display current elevator or garage status.


## 3. Core real‑time resources

Real‑time resources are updated frequently and are the backbone of the “live” experience in the app.


### 3.1 `predictions`

**Endpoint examples:**

- `GET /predictions`

**Concept:**

- A **prediction** represents the predicted arrival and/or departure time of a trip at a specific stop.
- Combines real‑time information with schedule to estimate upcoming service.

**Key fields:**

- `arrival_time`, `departure_time`: predicted times (may be null in some edge cases).
- `status`: human‑readable status string (e.g., “On time”, “Delayed”).
- `direction_id`: direction index (0 or 1).
- `stop_sequence`: position along the trip.
- `schedule_relationship`: indicates if the stop is scheduled, skipped, etc.
- Relationships to:
  - `route`
  - `trip`
  - `stop`
  - `vehicle`
  - `schedule`
  - `alerts` (via relationships or filters)

**Common filters we will rely on:**

- `filter[route]`: limit to one or more routes.
- `filter[stop]`: limit to specific stops (for station boards).
- `filter[trip]`: predictions for a specific trip.
- `filter[direction_id]`: inbound/outbound.
- `include=route,trip,stop,vehicle` for joined views.

**How we use it:**

- Generate station boards (next trains/buses at a stop).
- Compute headways at segments and lines.
- Compare with `schedules` to infer delays.
- Support Trip Lens estimates.


### 3.2 `vehicles`

**Endpoint examples:**

- `GET /vehicles`
- `GET /vehicles/{id}`

**Concept:**

- A **vehicle** record describes the current or recent position of a specific vehicle (train, bus, etc.).
- Derived from GTFS‑Realtime vehicle positions.

**Key fields:**

- `id`: vehicle ID (often a train or bus number).
- `latitude`, `longitude`, `bearing`, `speed` (if available).
- `current_status`: STOPPED_AT, IN_TRANSIT_TO, etc.
- `current_stop_sequence`: where in the trip it is.
- `updated_at`: timestamp of last update.
- Relationships to:
  - `trip`
  - `route`
  - `stop` (current or next)

**How we use it:**

- Draw moving vehicle markers on the map.
- Interpolate positions between stops along shapes.
- Determine which segments currently have active service.


### 3.3 `alerts`

**Endpoint examples:**

- `GET /alerts`
- `GET /alerts/{id}`

**Concept:**

- An **alert** communicates service disruptions, planned work, station closures, etc.
- Alerts are tied to routes, stops, trips, facilities, or modes via their “informed entities”.

**Key fields:**

- `id`: alert ID.
- `header_text`: brief summary.
- `description_text`: detailed description.
- `cause`: reason (construction, weather, etc.).
- `effect`: type of impact (delay, detour, shuttle, etc.).
- `severity`: numeric severity level.
- `lifecycle`: NEW, ONGOING, UPCOMING, etc.
- `active_period`: one or more start/end time ranges.
- Relationships via informed entities to:
  - `routes`
  - `stops`
  - `trips`
  - `facilities`
  - Activities (e.g., BOARD, EXIT).

**How we use it:**

- Show alert badges on affected lines, segments, and stations.
- Surface succinct disruption summaries in line overviews and station boards.
- Adjust reliability scores / pain scores for lines and segments.


### 3.4 `live_facilities`

**Endpoint examples:**

- `GET /live_facilities`
- `GET /live_facilities/{id}`

**Concept:**

- A **live facility** record provides current status for certain facilities, especially parking garages and similar assets.
- Bridges static facility metadata with real‑time occupancy or status info.

**Key fields:**

- `id`: live facility ID (tied to a static facility).
- `properties`: current stats like occupied/available spaces.
- `updated_at`: last update timestamp.
- Relationships to corresponding `facility` and possibly to stops/stations.

**How we use it:**

- Show parking garage occupancy at stations.
- Provide simple visual indicators (ring fill) for parking availability.
- Extend to elevators/escalators if data is exposed in the same resource or via alerts.


### 3.5 `occupancies` (if available)

**Concept (general):**

- Describes how crowded a vehicle or trip is (seat availability, standing room, etc.).
- Usually linked to trips/vehicles in modern transit APIs.

**How we use it:**

- Add crowding indicators to vehicle markers and station boards.
- Let users quickly see which upcoming trains are likely to be crowded.


## 4. Relationships & key joins

To build our app, we will frequently join and cross‑reference resources. Important relationships:

- **Route ↔ Line**
  - Many routes can belong to a single line.
- **Route ↔ Trip**
  - Trips are instances of service on a route.
- **Trip ↔ Shape**
  - Trip geometry is defined by a shape.
- **Trip ↔ Stop** (via schedules/predictions)
  - Schedules and predictions attach stops to the trip sequence.
- **Trip ↔ Vehicle**
  - A vehicle executing a trip provides current position and status.
- **Stop ↔ Predictions**
  - Predictions give upcoming arrivals/departures at a stop.
- **Route/Stop/Trip/Facility ↔ Alerts**
  - Alerts are linked to any of these through informed entities.
- **Facility ↔ LiveFacility**
  - Facility metadata (type, location) plus real‑time stats.


## 5. Data freshness & conceptual update cadence

While exact update intervals may vary, we assume the following conceptual behavior for our design:

- **Static data (routes, stops, shapes, schedules, services, facilities)**
  - Changes only when MBTA updates timetables or network structure (days–months scale).
  - We can treat these as essentially static for the duration of a runtime session and refresh occasionally or on deploy.

- **Predictions**
  - Updated frequently throughout the day (sub‑minute typical cadence).
  - Our backend will poll predictions every ~10–30 seconds per route or route group, then cache.

- **Vehicles**
  - Vehicle positions update regularly (tens of seconds typical).
  - Our backend will poll vehicle positions on a similar cadence and merge with predictions/shapes.

- **Alerts**
  - Updated as disruptions and planned work change (irregular, but important).
  - Our backend will poll alerts on a slightly slower interval (e.g., 60–120 seconds).

- **Live facilities**
  - Updated periodically based on the underlying systems (parking sensors, etc.).
  - Our backend will poll on a moderate interval (e.g., 60–300 seconds).

These conceptual cadences are chosen to drive our **polling strategy and cache TTLs**, not as strict guarantees from MBTA. The backend will treat MBTA data as near‑real‑time and expose it to the frontend in a form that feels live without being wasteful.


## 6. How we plan to use the data

At a high level, for our app:

- **Map & geometry**
  - Use `routes`, `lines`, `shapes`, and `stops` to draw the network and station markers.
- **Live vehicles & motion**
  - Use `vehicles` + `trips` + `shapes` to place moving markers on routes.
  - Use `predictions` + `schedules` to interpolate vehicle positions between stops.
- **Headway & reliability metrics**
  - Use `predictions` + `schedules` to estimate real headways vs scheduled headways per segment.
  - Use trip consistency and gaps to rate segment reliability.
- **Station boards**
  - Use `predictions` (and `schedules` as fallback) filtered by stop to build per‑direction boards.
  - Augment with `alerts` and accessibility info from `facilities`/`live_facilities`.
- **Line and system insights**
  - Aggregate predictions, vehicles, and alerts by route/line to generate KPIs and line “pain scores”.
- **Accessibility & parking**
  - Use `facilities`, `live_facilities`, and `alerts` to show elevator/escalator status and parking occupancy.

This document should give Codex/AI assistants enough conceptual context to generate data models, API client utilities, and backend aggregation logic aligned with the MBTA V3 API and our product goals.
