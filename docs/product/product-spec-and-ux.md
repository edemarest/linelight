# Product Spec & UX – MBTA System Radar

File: `docs/product/product-spec-and-ux.md`

## 1. Project overview

**Working name:** MBTA System Radar  
**One‑liner:** A live, visually rich MBTA system map that shows how each line, segment, and station is performing *right now* — not just when the next train comes, but how reliable the network feels.

This app combines static MBTA data (routes, stops, shapes, schedules) with real‑time feeds (vehicles, predictions, alerts, facilities) to give riders and transit nerds a clean, glowing, information‑dense view of the network.

Core priorities:

- Feel fast, smooth, and modern.
- Be more informative than typical “next train” apps.
- Keep network usage light by aggregating data server‑side and polling strategically.
- Present complex data in a very clear, legible way on a map-first interface.


## 2. Goals & non‑goals

### 2.1 Goals

- **Answer “How’s my line doing right now?” at a glance.**
  - Per‑line and per‑segment status using colors, glow, and simple KPIs.
- **Make station views genuinely useful.**
  - Upcoming trains, crowding, alerts, facilities, and transfers in one place.
- **Express reliability, not just arrivals.**
  - Headway gaps, slow segments, and disruptions are visible directly on the map.
- **Deliver a polished, glowy, high‑motion UI without being visually noisy.**
  - Smooth transitions, subtle glow effects, and clean typography.
- **Make power‑user tools accessible.**
  - Insights view and Trip Lens view are advanced but still intuitive.

### 2.2 Non‑goals (v1)

(See later versions for account system, personalization, offline mode, full trip planner.)


## 3. User personas

- Wants a fast check of “Is my train/bus a mess today?”
- Likely to:
  - Search or pick a favorite station.
  - See when the next trains are coming and if there are any serious disruptions.
  - Quickly choose between multiple lines/routes at a major hub.

### 3.2 Power user / transit nerd / frequent commuter

- Cares about whole‑line health, headways, and slow zones.
- Likely to:
  - Toggle between lines and inspect segments.
  - Watch live vehicle motion.
  - Use the Insights view to see which lines are suffering the most.

### 3.3 System observer / data nerd

- Interested in system‑level performance and metrics.
- Likely to:
  - Use the Insights view, system KPIs, and historical snapshots (if added later).
  - Compare lines and modes (subway vs bus vs commuter rail).


## 4. Primary features

### 4.1 Live system map

Map-first UI with routes, stations, vehicles, and alerts. Dark minimal basemap with MBTA canonical colors. Smoothly animated vehicle markers. Segments colored by performance (headway health, slow zones).

### 4.2 Line overview dashboards

For each selected line: Key KPIs (active vehicles, headways, alerts, slow zones). Segment status strip (colored by delay/health, click to zoom). Mini trend chart (30-60 min headway reliability).

### 4.3 Station boards

Station name, connected lines, next trains/buses (destination, countdown, crowding, reliability flags). Alert icons, accessibility indicators, parking occupancy. Station-specific alerts at bottom.

### 4.4 Trip Lens view (reliability‑aware trip snapshot)

Lightweight station-to-station reality check. Select origin/destination. Returns best options with estimated travel time, reliability score, and warnings (shuttle required, long gaps). Not a full planner.

### 4.5 Insights / system health view

All lines shown with active count, pain score, delay/headway deviation. "Top trouble segments now" list. For enthusiasts and operations monitoring.

### 4.6 Accessibility & facilities layer

Toggle to highlight elevator/escalator status, parking occupancy, bike facilities.


## 5. UX flows

### 5.1 Line‑first flow (power user)

1. Open app → see system overview with all lines faintly visible.
2. Use left‑hand line selector to choose a line (e.g., Red Line).
3. Map zooms to line; other lines fade to low opacity.
4. Right panel shows line overview (KPIs, segment strip, alerts list).
5. User:
   - Clicks a segment → map zooms into that segment.
   - Clicks a station in that segment → station board opens.

### 5.2 Station‑first flow (everyday rider)

1. User searches for a station name or uses “Use my location” to select nearest station.
2. Station is highlighted on the map.
3. Station board opens with upcoming trains/buses and alerts.
4. User can:
   - Switch to a different line serving the station.
   - Open Trip Lens from a station context (set as origin).

### 5.3 Trip Lens flow

1. User opens Trip Lens (button near search bar or station view).
2. Select origin and destination stations (via search/map click).
3. App shows 1–3 best options with reliability‑aware info.
4. Selecting an option highlights that path on the map and animates through it.


## 6. Visual direction & motion language

### 6.1 General style

- Dark background (charcoal to black) with subtle texture/gradient.
- MBTA lines in their standard colors, but with a soft glow.
- Use glow to indicate “focus” or “relevance,” not everywhere.
- Clean, readable typography (sans serif with clear hierarchy).

### 6.2 Map visual rules

- Basemap: muted colors; roads/landmarks low contrast.
- Routes: solid lines with subtle outer glow; thickness adjusted by mode.
- Vehicles: pill‑shaped markers with subtle halo and directional tail.
- Alerts: distinctive icon overlays (triangles, construction icons, etc.).
- Accessibility: icons that are recognisable and consistently placed.

### 6.3 Motion & transitions

- Smooth pan/zoom when:
  - Switching lines.
  - Zooming to segments or stations.
- Gentle animated transitions for:
  - Vehicle positions updating (no popping/jumping).
  - Line status color changes (headways/slow zones).
  - Panels opening/closing and content changes.
- Use easing curves that feel “soft” (not overly bouncy).

### 6.4 Responsiveness & layout

- Desktop:
  - Left sidebar (filters & navigation), center map, right info panel.
- Tablet:
  - Collapsible sidebar; map + bottom/right info panel.
- Mobile:
  - Fullscreen map with bottom sheet for current context (station/line/trip).
  - Filters slide in from the side.

The design should feel like a premium dashboard, not a generic transit app.


## 7. Out of scope (v1)

User accounts, favorites, push notifications, offline usage, historical analytics, saved routes, full multi-modal planning.
