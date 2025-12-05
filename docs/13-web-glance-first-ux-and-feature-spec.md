# LineLight Web Glance-First UX & Feature Spec

File: `docs/13-web-glance-first-ux-and-feature-spec.md`

This document defines the **user experience and feature design** for the *web-only* version
of LineLight, optimized for a **glance-first** workflow:

> “Open the site, see what’s coming near me, tap a stop for details, and leave.”

The goal is to feel **lighter and clearer** than typical transit dashboards and existing MBTA apps,
while still supporting curious/power users with line and system views.


## 1. Product Goals (Web)

### 1.1 Primary goal

Make it **effortless** for someone to:

1. Open LineLight in a browser.
2. Instantly see nearby departures that matter (for subway, bus, or commuter rail).
3. Click one stop to see a focused, readable stop sheet.
4. Decide what to do and close the tab.

### 1.2 Secondary goals

- Provide **Favorites** so the user can quickly access key stops (home, work, etc.).
- Offer a **Lines view** for line health and higher-level insight.
- Optionally offer a **System Insights** view for more global status.

### 1.3 Non-goals (for MVP)

- Full trip planning / routing UI (Trip Lens can be added later).
- Very heavy analytics dashboards on the main screen.
- Advanced GIS tools (custom layers, complex overlays, etc.).


## 2. Primary Flows

The UX is structured around a few core flows:

1. **Check nearby departures**
   - User visits `/` (Home).
   - Browser asks for location (or user manually sets an area).
   - A **list of nearby stops** appears, with ETAs per route.
   - Optional map shows where those stops are.

2. **Check a specific stop**
   - From Home or search, the user selects a stop.
   - A **Stop Sheet** appears (page or panel) with upcoming departures and any alerts.
   - The user can quickly see multiple ETAs and deeper details if desired.

3. **Use favorites for routine trips**
   - User marks a stop as a favorite.
   - Favorites appear at the top of Home and/or a dedicated Favorites section.
   - User can quickly jump between favorite stops.

4. **Inspect a line**
   - User opens Lines view.
   - Sees each subway/CR/bus line with a simple health/status indicator.
   - Selects a line to see segments, issues, headways, and optionally a line map.

5. **Scan overall system (optional, power)**
   - User visits Insights view.
   - Sees a system-wide summary: worst lines/segments, overall status.

Only flows **1–3** are required for MVP; Lines and Insights can follow once the glance-first base is solid.


## 3. Screen & Layout Specifications (Web)

### 3.1 Home / Nearby Screen

**Route:** `/`

**Purpose:** Fast, legible overview of nearby and favorite stops with upcoming departures.

#### 3.1.1 Layout (desktop)

A responsive two-column layout:

- **Header bar (top)**
  - Left: LineLight logo + text.
  - Center: optional location label (e.g., “Near Davis Square”) and a small **refresh / locate** button.
  - Right: navigation links: `Favorites`, `Lines`, `Insights` (optional), plus a theme toggle if desired.

- **Left column (primary content)**
  - Section A: **Favorites preview**
    - Optional heading: “Favorites”.
    - Small list of favorite stops with very compact ETAs (1–2 per route).
    - Click = open Stop Sheet.
  - Section B: **Nearby stops**
    - Heading: “Nearby”.
    - List of **HomeStopSummary** rows from `/api/home`:
      - Stop name.
      - Distance (e.g., “250 m”).
      - Chip/badges for routes.
      - For each route, compact ETAs (e.g., `3, 8, 14 min`).
      - Small icon indicating mode (subway/bus/CR).
    - Filter controls above list:
      - Mode filter: `All | Subway | Bus | CR` (client-side filter based on `modes`).
      - Optionally a simple route filter field.

- **Right column (map)**
  - Dark basemap centered on user location.
  - Markers for nearby stops (from `/api/home.nearby`).
  - Hover/tap marker highlights corresponding row in the list (and vice versa).

#### 3.1.2 Layout (narrow/mobile-width)

- Header fixed at top.
- Under header:
  - Nearby list first.
  - Collapsible map section below (“Show map” toggle).
- Same data, stacked instead of two-column.

#### 3.1.3 Data dependencies

- Frontend calls `GET /api/home?lat=...&lng=...` and uses `HomeResponse`.
- React Query used to poll at a light interval (e.g., 15–30 seconds) while Home is visible.

#### 3.1.4 Interactions

- Clicking a stop row → navigates to Stop Sheet (`/stops/:id`).
- Clicking a map marker → reveals a small tooltip and a “View stop” button.
- Clicking a star icon on a row → toggles favorite status (frontend + backend or local store).


### 3.2 Stop Sheet Screen

**Route:** `/stops/[id]`

**Purpose:** Provide a focused, readable view of a single stop’s upcoming departures, alerts, and facilities.

#### 3.2.1 Layout (desktop, modal or full page)

Two layout options are acceptable:

1. **Full page**
   - The Stop Sheet occupies the main content area, with Home accessible via header navigation.
2. **Map + panel**
   - Page shows map background with a **Stop Sheet panel** sliding in from the right.

We should support both with a responsive approach; MVP can start with a full page.

**Core content (above the fold):**

- Header row:
  - Stop name (large, clear).
  - Favorite toggle (star icon).
  - Distance/walk estimate if `lat,lng` provided (`distanceMeters`, `walkMinutes`).

- Primary route cards (one per `StationBoardRoutePrimary`):
  - Route badge + direction label.
  - Large primary ETA (`primaryEta.etaMinutes` or “Now / Due / —”).
  - Small line of extra ETAs (`extraEtas`).
  - Status pill (e.g., “On time”, “Delayed”).

**Below-the-fold details:**

- **Departures list** (from `StationBoardDetails.departures`):
  - Grouped by route and direction.
  - Each row shows scheduled vs predicted time, ETA, status, and “source” (prediction vs schedule) indicated via subtle UI (e.g., dot or label).

- **Alerts** (from `StationBoardDetails.alerts`):
  - Cards with severity-coded styles.
  - Show header + brief description.

- **Facilities**:
  - List of elevators/escalators/parking statuses, if available.

Optional actions:

- “View on map” – pans the main map to this stop and highlights it.
- “View line” – navigates to `Lines` screen focusing on the relevant route.
- “Follow trip” – when clicking on a specific departure (wires to `/api/trips/:tripId/track`).

#### 3.2.2 Data dependencies

- Frontend calls `GET /api/stations/:id/board`.
- React Query used with periodic refresh while on the page (e.g., 15–30 seconds).


### 3.3 Favorites Screen (or Favorites section)

**Route:** `/favorites` or integrated into Home.

**Purpose:** Make routine commuting behavior very fast.

**Layout:**

- List of favorite stops with layout similar to Nearby rows:
  - Stop name.
  - Routes with compact ETAs.
  - Last refreshed time.


### 3.4 Lines Screen

**Route:** `/lines` and `/lines/[id]`

**Purpose:** Provide line-level health and context for users who care about the overall system.

**Lines list:**

- One row per `LineSummary`:
  - Line color/marker.
  - Name (“Red Line”, “1 Bus”).
  - Status pill: `good`, `minor`, `major`, `unknown`.
- Clicking a line opens `/lines/[id]` with `LineOverview`.

**Line detail (/[id]):**

- Header: line name, mode, high-level status.
- A horizontal segment strip visualizing `LineSegmentHealth` statuses along the line.
- Headway summary (from `HeadwaySummary`).
- Alerts relevant to the line.

Map integration (optional): a toggle to show a map with the line path and recent vehicles.


### 3.5 Insights Screen (Optional)

**Route:** `/insights`

**Purpose:** Show system-wide reliability and “worst segments” for power users.

**Content:**

- Overall system note (from `SystemInsights.notes`).
- Cards for:
  - “Most disrupted lines”.
  - “Worst segments” (list of `LineSegmentHealth` entries).

This screen is optional and can be added later.


## 4. Components & Data Mapping

### 4.1 Home Components

- `HomePage`
  - Uses `useHome()` hook (React Query) to fetch `/api/home`.
- `NearbyStopList`
  - Maps `HomeResponse.nearby` to `NearbyStopRow`.
- `FavoriteStopList`
  - Maps `HomeResponse.favorites` to `FavoriteStopRow`.
- `NearbyStopRow`
  - Displays `HomeStopSummary` and a subset of `HomeRouteSummary.nextTimes`.
- `HomeMap`
  - Renders markers for stops and user location.

### 4.2 Stop Sheet Components

- `StopSheetPage` or `StopSheetPanel`
  - Uses `useStationBoard(id)` hook to fetch `/api/stations/:id/board`.
- `StationPrimaryRoutes`
  - Maps `primary.routes` to route cards.
- `StationDeparturesList`
  - Renders `details.departures` with schedule/prediction indicators.
- `StationAlerts`
  - Renders `details.alerts` as cards.
- `StationFacilities`
  - Renders `details.facilities`.

### 4.3 Lines & Insights Components

- `LinesPage` → `useLines()` → `LineSummaryList`.
- `LineDetailPage` → `useLineOverview(id)` → `LineSegmentStrip`, `LineAlerts`.
- `InsightsPage` → `useSystemInsights()` → `WorstSegmentsList`.


## 5. Performance & Interaction Guidelines

- **Glance-first priority**
  - Home must load quickly; `/api/home` and minimal map only.
  - Stop Sheet above-the-fold must be ready with `primary` routes as soon as possible.

- **Lazy heavy data**
  - Detailed departures, alerts, facilities can be rendered after the primary block (same request but visually lower priority).

- **Polling**
  - Use moderate refetch intervals (15–30 seconds) and `staleTime` to avoid overpolling.
  - Only poll while the relevant screen is visible.

- **Caching**
  - Client-side React Query cache should keep recent data for quick back/forward navigation.
  - Backend can implement short-lived caches to minimize MBTA API calls (described in another doc).


## 6. Accessibility & UX Guardrails (Web)

- All primary functions (view nearby stops, open a Stop Sheet) must work using **keyboard only**.
- The Stop Sheet must be navigable with screen readers:
  - Use semantic headings and lists.
  - Clearly label times and statuses.
- Map interactions are **optional** and must not gate the core experience.
- Maintain high contrast for text and primary icons, even with glows and gradients.
- Keep above-the-fold content clean—no giant tables or dense filters.


## 7. Visual Style Notes

While implementation details live in CSS/Tailwind, keep these design themes in mind:

- Dark background with subtle gradients.
- Soft glows around active elements (selected stop, primary ETA).
- Smooth micro-interactions (hover/focus states, panel transitions) without heavy animations that hurt performance.
- Route colors echo MBTA branding but with LineLight’s own twist (e.g., white/teal/cyan accents).


This spec should guide the frontend implementation and ensure that the web app stays focused on the **open → glance → act → close** loop, while still making room for deeper exploration via Lines and Insights.
