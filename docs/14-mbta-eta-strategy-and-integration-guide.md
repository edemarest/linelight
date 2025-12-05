# LineLight MBTA ETA Strategy & Integration Guide (Web)

File: `docs/14-mbta-eta-strategy-and-integration-guide.md`

This document explains **how LineLight talks to the MBTA v3 API** and, most importantly,
how we compute **reliable ETAs** by blending `/predictions` and `/schedules` (and optionally
using `/vehicles` and `/alerts`).

The goal is to produce consistent, high-quality ETAs for:

- `/api/home` (Home/Nearby snapshot)
- `/api/stations/:id/board` (Stop Sheet)
- `/api/trips/:tripId/track` (Trip follow)

while handling the quirks of the underlying MBTA feeds.


## 1. Problem Statement

Raw MBTA v3 `/predictions`:

- Only exist if there is **realtime data** for a trip/stop.
- Often cover only a **window** of upcoming stops (especially on commuter rail).
- May omit many scheduled departures (they still exist in `/schedules`).

If we rely on `/predictions` alone, users will see **empty or incomplete departure boards**,
even though trains/buses are scheduled.

LineLight’s solution is to **blend `/predictions` with `/schedules`** so that:

- We always show upcoming departures within a time window, and
- We mark which ETAs are based on realtime vs schedule.


## 2. Relevant MBTA v3 Endpoints

LineLight’s backend uses these MBTA endpoints:

- `/stops` – stop locations and hierarchy.
- `/routes` – route metadata (names, colors, modes).
- `/schedules` – planned times (GTFS static).
- `/predictions` – realtime times (GTFS-Realtime TripUpdates).
- `/vehicles` – realtime vehicle positions.
- `/trips` – trip metadata (destination/headsign, direction).
- `/alerts` – service alerts.

We do **not** expose these endpoints directly to the frontend; they are only used by the backend to produce our own `/api/...` responses.


## 3. Blending `/schedules` and `/predictions`

### 3.1 General approach

For a given stop and time window (e.g., next 60–90 minutes):

1. Call `/schedules` for that stop with appropriate filters.
2. Include any related predictions (`include=prediction,trip,route` or separate `/predictions` call).
3. For each scheduled departure, if a prediction exists, **override** the scheduled time with the predicted time.
4. Compute an ETA in minutes from “now” and label the data with an `EtaSource` value:
   - `prediction` – realtime prediction time used.
   - `schedule` – no prediction available; using schedule.
   - `blended` – derived from more than one source (e.g., schedule + vehicle position).
   - `unknown` – fallback if neither is available.

We return these blended ETAs via LineLight’s own models (`StationEta`, `HomeEta`, etc.).


### 3.2 At a specific stop (StationBoard)

For `/api/stations/:id/board`:

1. Determine a **time window**, e.g.:
   - `windowStart = now`
   - `windowEnd = now + 60 minutes`
2. Query MBTA `/schedules` for that stop and window.
3. For each schedule row:
   - Find an associated prediction (either via `include=prediction` or a separate `/predictions` call).
   - If found:
     - Use `predicted_time` as the base time.
     - Set `source = "prediction"` and `status` based on MBTA fields (on time, delayed, cancelled, etc.).
   - If not found:
     - Use `arrival_time`/`departure_time` from schedules.
     - Set `source = "schedule"` and `status = "unknown"` or `status = "on_time"` (depending on how we interpret typical behavior).
4. For each resulting departure:
   - Compute `etaMinutes = (time - now)` in minutes, if within window.
   - Populate `StationDeparture` and aggregate into:
     - `StationBoardRoutePrimary` (first 1–3 ETAs per route/direction).
     - `StationBoardDetails.departures` (larger list, grouped by route/direction).

In pseudocode (conceptual):

```ts
function buildDeparturesForStop(stopId: string, now: Date): StationDeparture[] {
  const scheds = fetchSchedulesForStop(stopId, windowStart, windowEnd);
  const predsByScheduleId = indexPredictions(scheds);

  return scheds.map(sched => {
    const pred = predsByScheduleId[sched.id];

    const time = pred?.time ?? sched.time;
    const source: EtaSource = pred
      ? "prediction"
      : "schedule";

    const etaMinutes = computeMinutesDiff(now, time);

    return {
      routeId: sched.routeId,
      shortName: sched.routeShortName,
      direction: sched.directionName,
      destination: sched.headsign,
      scheduledTime: sched.time,
      predictedTime: pred?.time,
      etaMinutes,
      source,
      status: deriveStatus(pred, sched)
    };
  });
}
```


### 3.3 Home snapshot (`/api/home`)

For `/api/home`, we need **just a few ETAs per route per nearby/favorite stop**.

Strategy:

1. Determine the user’s location and find nearby stops using `/stops` (or cached stop data).

2. For each candidate stop:
   - Either:
     - Reuse blended StationBoard departures (if recently computed), or
     - Run a lighter blending process:
       - Smaller time window (e.g., next 30–45 minutes).
       - Limit to top `N` departures.

3. For each stop/route/direction pair, compute the top `K` ETAs (e.g., 3) and populate `HomeRouteSummary.nextTimes` as `HomeEta[]` with `etaMinutes`, `source`, and `status`.

4. Trim nearby stops list by distance and limit parameter.

This allows Home to remain light while still reflecting the same ETA logic as the StationBoard.


## 4. Vehicles & Trip Tracking

### 4.1 Vehicles for map context

`/vehicles` provides positional data for buses/trains:

- We do **not** need vehicles for every view.
- For initial LineLight implementation, we only need vehicles for:
  - A line overview map (optional).
  - Following a specific trip.

Backend approach:

- Expose a `TripTrackResponse` normalized from:
  - `/vehicles?filter[trip]=TRIP_ID` or `filter[route]=ROUTE_ID`.
  - `/stops` for stop locations.
  - `/predictions` or `/schedules` for ETAs for upcoming stops.

The frontend then displays a moving marker and upcoming stops with ETAs in a small panel.


### 4.2 Follow trip (`/api/trips/:tripId/track`)

Implementation outline:

1. Fetch vehicle position for the trip (if available).
2. Fetch sequence of stops for the trip (from `/stop_times` via `/schedules` or `/trips` relationships).
3. For each upcoming stop:
   - Use schedule/prediction blending as above to compute `etaMinutes`.
4. Return `TripTrackResponse` with `tripId`, `routeId`, `destination`, `vehicle`, and `upcomingStops[]`.


## 5. Alerts Integration

Alerts provide critical service disruption context but can be complex.

For LineLight MVP:

- For `StationBoard`:
  - Include only alerts that directly affect the stop or its routes.
  - Map them into `StationAlert` models with severity, header, and effect.

- For Lines/System Insights:
  - Aggregate alerts per line and surface high-severity ones.

Alerts should influence the **status** field for departures and lines where appropriate, but details can remain relatively simple at first (e.g., “Shuttle buses replacing service”).


## 6. Caching & Rate Limiting Strategy

Because MBTA v3 is shared infrastructure, we should be polite and efficient.

### 6.1 Backend caching

- Use in-memory cache (or Redis later) keyed by:
  - Stop + time window for StationBoard.
  - Origin lat/lng grid for Home.
- Cache TTL:
  - Short (e.g., 10–30 seconds) for ETAs.
  - Longer (e.g., several minutes or hours) for static stop/route metadata.

### 6.2 Polling pattern

- **Frontend**:
  - Home: React Query `refetchInterval` ~15–30s while visible.
  - Stop Sheet: similar interval.
  - TripTrack: more frequent interval (e.g., 5–10s) while user follows the trip.

- **Backend**:
  - Each frontend request can trigger fresh MBTA calls, but with cache in front.
  - Optional: prefetch in background for frequently-viewed stops/lines.

### 6.3 Error handling & degradation

If MBTA endpoints fail or rate limits occur:

- StationBoard:
  - Use cached data if available.
  - If no data, show a clear “Data temporarily unavailable” message and a retry button.

- Home:
  - Same: use cached snapshot or provide schedule-only ETAs where possible.

We should avoid showing partially inconsistent data and instead favor transparent messaging.


## 7. Implementation Locations in Backend

Suggested backend file organization:

```text
backend/src/
  mbta/
    client.ts          # thin wrapper around MBTA HTTP calls
    schedules.ts       # helpers for /schedules
    predictions.ts     # helpers for /predictions
    vehicles.ts        # helpers for /vehicles
    alerts.ts          # helpers for /alerts
  services/
    etaService.ts      # core blending logic for ETAs
    homeService.ts     # builds HomeResponse using etaService
    stationBoardService.ts # builds GetStationBoardResponse using etaService
    tripTrackService.ts    # builds TripTrackResponse using vehicles + etaService
  routes/
    apiHome.ts         # /api/home handler
    apiStations.ts     # /api/stations/:id/board handler
    apiTrips.ts        # /api/trips/:tripId/track handler
```

The **blending logic** should live in one or two focused modules (`etaService`, etc.) so it is easy to test and adjust without touching route handlers.


## 8. Frontend Implications

Because the ETA logic is backend-only, the frontend only needs to:

- Display ETAs and statuses as provided.
- Optionally show indicators for `EtaSource` (e.g., realtime vs scheduled) in a subtle way.
- Stay agnostic to MBTA endpoint quirks; it deals only with normalized LineLight models (`HomeResponse`, `GetStationBoardResponse`, etc.).


This document should be the main reference for any work involving MBTA integration, ETA computation, or changes to how LineLight surfaces realtime vs scheduled data.
