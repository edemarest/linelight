# Frontend UI Layout & Map Layers

File: `docs/06-frontend-ui-layout-and-map-layers.md`

This document describes the frontend UI structure, layout, key components, and how the map and its layers work together. It complements the architecture and data model docs by focusing on **what the user sees and interacts with**.


## 1. Overall layout

The app is **map-first**, with UI panels arranged around the map. We target:

- Desktop: left sidebar (filters), center map, right panel (context/details).
- Mobile: full-screen map with a bottom sheet for context and slide-in filters.

### 1.1 Desktop layout

High-level structure:

```
+-------------------------------------------------------+
| Sidebar (left) |           Map (center)              | Context (right) |
|                |                                     |                 |
+-------------------------------------------------------+
```

- **Sidebar (left):**
  - App logo/title.
  - Mode filters (Subway, Bus, Commuter Rail, Ferry).
  - Line selector list.
  - Search box for stations/lines.
  - Layer toggles (headway heatmap, alerts, accessibility, parking).

- **Map (center):**
  - MapLibre canvas for base map.
  - deck.gl overlays for lines, vehicles, stations, alerts.
  - Always visible; interactions (click/hover) update the context panel.

- **Context panel (right):**
  - Content depends on current context:
    - Line overview.
    - Station board.
    - Trip Lens options.
    - System insights (optionally full-width or within the panel).


### 1.2 Mobile layout

On smaller screens, we optimize for map + minimal UI:

- **Top bar:**
  - App title.
  - Icon buttons for search and filters.

- **Map (full-screen):**
  - Primary interaction surface.
  - Tap stations/vehicles/segments.

- **Bottom sheet:**
  - Slides up to show:
    - Station board (when a station is selected).
    - Line overview (when filtering by line).
    - Trip Lens results.
    - System insights (via dedicated control).

- **Filters panel:**
  - Slides in from the side for mode/line/layer toggles.


## 2. Major screens / modes

Technically, the app is a single page with different “modes” driven by state.

### 2.1 System Map mode

Default mode:

- Shows all relevant lines (faint for unselected).
- Sidebar lists all lines with at-a-glance health indicators.
- Context panel idle state: “Pick a line or station to begin” + a mini system summary.

### 2.2 Line view

When a line is selected:

- Map focuses on the chosen line’s extent.
- Only that line is fully saturated; others fade.
- Context panel shows `LineOverview`:
  - Large line title.
  - KPIs (active trains, headway, alerts, slow segments).
  - Segment strip showing health along the line.
  - List of alerts for this line.

### 2.3 Station view

When a station is selected (via search or clicking a stop marker):

- Station marker is emphasized (pulse/glow).
- Context panel or bottom sheet shows `StationBoard`.
- The board groups departures by line and direction.

### 2.4 Trip Lens view

When user opens Trip Lens:

- UI assists user in selecting origin/destination stops (search or map clicks).
- Context panel shows a small list of `TripLensOption` cards.
- Map highlights the chosen path with emphasis on the line segments and transfer points.

### 2.5 Insights view

Optional mode presented either:

- As a dedicated tab in the context panel, or
- As a full-width page reachable via navigation.

Shows:

- SystemInsights summary cards per line.
- List of top trouble segments, potentially with clickable entries that focus the map.


## 3. React component hierarchy (high-level)

A possible structure (names are suggestions):

```tsx
<AppShell>
  <Layout>
    <Sidebar>
      <Logo />
      <ModeFilter />
      <LineList />
      <SearchBox />
      <LayerToggles />
    </Sidebar>

    <MapContainer>
      <BaseMap />         // MapLibre
      <DeckGlLayers />    // deck.gl overlays
      <MapOverlays />     // tooltips, selected markers
    </MapContainer>

    <ContextPanel>
      <ContextSwitcher>
        {/* Renders one of these based on app state */}
        <LineOverviewPanel />
        <StationBoardPanel />
        <TripLensPanel />
        <InsightsPanel />
        <EmptyStatePanel />
      </ContextSwitcher>
    </ContextPanel>
  </Layout>
</AppShell>
```

**State management:**
- Shared app state (selected line, selected station, active mode, filters) can be kept in:
  - A React context (`AppStateContext`).
  - Combined with URL query params for shareable deep links later.

**Data fetching:**
- Each panel uses TanStack Query hooks calling the backend:
  - `useLines()`, `useLineOverview(lineId)`, `useStationBoard(stopId)`, etc.
  - Map layers also use queries, but we avoid duplication via shared query keys.


## 4. Map implementation & layers

The map is built from three main pieces:

1. **Map container** (MapLibre GL JS).
2. **Vector tile basemap** styled for a dark theme.
3. **deck.gl layers** for MBTA-specific overlays.

### 4.1 Base map (MapLibre)

- MapLibre GL instance initialized with:
  - Dark style URL or inline style.
  - Starting center (e.g., downtown Boston) and zoom.
- Exposes:
  - Camera control (pan/zoom, flyTo).
  - Event hooks for clicks, move, zoom, etc.

Example responsibilities:

- Centering and zooming when a line/segment/station is selected.
- Propagating viewport state to deck.gl.


### 4.2 deck.gl layer strategy

Core layers we expect to use:

1. **RouteLineLayer (LineLayer subclass)**
   - Renders polylines for each route/line.
   - Per-segment coloring based on `SegmentStatus.health` and metrics like headway deviation.
   - Uses glowy styling:
     - Thicker base stroke in the line’s color.
     - Slight outer glow effect via additional stroke or blur-like styling.

2. **VehicleLayer (ScatterplotLayer or IconLayer)**
   - Renders vehicle markers (pills) at positions from `VehicleSnapshot.position`.
   - Encodes direction (rotation) from `bearing` and health/crowding from color/halo.
   - Smoothly animates position updates (see animation section).

3. **StationLayer (ScatterplotLayer/IconLayer)**
   - Renders station markers with station-specific icons.
   - Highlights selected station with larger size and glow.

4. **AlertOverlayLayer**
   - Draws icons or styled shapes at affected segments or stations.
   - Might only show for significant alerts to avoid clutter.

5. **Heat/HeadwayLayer (optional)**
   - Visualizes headway/gap issues as colored overlays or thicker segments.

**Layer composition:**

- All layers are combined into a single `DeckGL` component whose `viewState` is synced with the MapLibre camera.
- We keep the number of layers modest but expressive; each layer has a clear responsibility.

### 4.3 Map interactions

- Clicking station markers:
  - Update `selectedStationId`, open StationBoardPanel.
  - Fly the map to the station with smooth animation.
- Clicking route segments:
  - Select the line and segment, focusing the map and context panel on that segment.
- Hover behavior:
  - Show tooltips for stations, vehicles, and segments.
  - Subtle hover glows or size changes on markers.


## 5. Animation & interaction design

### 5.1 Vehicle motion

We want vehicle motion to feel smooth and alive:

- **Backend:** attaches an “expected position” per polling cycle using predictions + shapes.
- **Frontend:** uses interpolation between the last and next positions:
  - We keep previous and next coordinates in component state.
  - Over the polling interval (e.g., 15 seconds), animate marker movement with linear or eased interpolation.
- When a vehicle “jumps” (e.g., teleport due to new trip segment), we snap more quickly to avoid weird trails.

### 5.2 Line status transitions

- When a segment’s `health` changes (e.g., good → minor_issues → major_issues):
  - Animate color changes over ~250–400ms.
  - Optionally use a subtle pulse when a segment first becomes problematic.

### 5.3 Panel transitions

- Use Motion/Framer Motion for:
  - Sliding context panel in/out on mobile.
  - Crossfading content when switching between LineOverviewPanel and StationBoardPanel.
  - Hover & tap states for chips, buttons, and cards.

Recommended basics:

- Animations should feel responsive but not frantic (200–300ms durations, ease-in-out).


## 6. Layers & filter toggles

### 6.1 Layer toggles in UI

Sidebar (desktop) or filters panel (mobile) includes switches for:

- **Headway heatmap**: show/hide segment headway coloring.
- **Alerts overlay**: show/hide alert icons and color cues.
- **Accessibility & parking**: show/hide elevator/parking markers.
- **Vehicles**: show/hide vehicle markers for more static overview.

Each toggle maps to boolean flags that conditionally include or configure deck.gl layers.


### 6.2 Mode and line filters

- Mode filter (Subway/Bus/Commuter Rail/Ferry):
  - Controls which lines appear in the line list and which route geometries are drawn.
- Line filter:
  - Primary line selection drives:
    - Which line is visually emphasized on the map.
    - Which data is fetched for `LineOverview` and `VehicleSnapshot`.


## 7. Accessibility & responsiveness

### 7.1 Visual accessibility

- Use sufficient color contrast for all text and critical map elements.
- Avoid relying solely on color to convey segment health:
  - Add patterns or small icons for “major issues” segments.
- Provide accessible labels and descriptions for:
  - Stations (e.g., tooltip content available to screen readers).
  - Lines and segments (e.g., “Red Line northbound between X and Y”).

### 7.2 Keyboard interaction

- Allow navigation via keyboard:
  - Focus management: line list, station search results, focusable map overlay controls.
  - Keyboard shortcuts for toggling views or selecting the “next” station in the list.

### 7.3 Responsive breakpoints

- Define Tailwind breakpoints for:
  - `sm`: small phones (map + simple bottom sheet).
  - `md`: larger phones/tablets (slightly bigger sheet, optional sidebars).
  - `lg` and up: full desktop layout with persistent sidebar + context panel.

The map should remain usable and legible at all breakpoints, with a focus on the most important information for that screen size.


## 8. Summary

- The frontend is structured around a **central map** with contextual panels and filters.
- React components and TanStack Query hooks cleanly separate UI state from data fetching.
- MapLibre + deck.gl provide a powerful canvas for glowing lines, smooth vehicle motion, and rich overlays.
- Thoughtful animation and interaction design helps users understand system health at a glance without overwhelming them.
- Accessibility, responsiveness, and clear layout ensure the tool is usable across devices and by a wide range of riders.
