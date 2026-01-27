# LineLight Web Refactor – UI/UX TODO Plan (Glance‑First)

This document is a prioritized, detailed TODO list for refactoring the LineLight
web UI into a **glance‑first**, map‑aware experience. It is written for an AI
engineer (or human) to implement in clear, testable chunks.

---

## PHASE 0 – Quick Wins / Correctness

### 0.1 Make stops on the map clickable

**Goal:** Clicking a stop marker opens the Stop Sheet for that stop and syncs with the Nearby list.

**Implementation details:**

- Find the map component that renders stop markers.
- Ensure each marker has the stop’s **LineLight stopId** (the one used in `/api/stations/:id/board`).
- Add a click handler that:
  - Updates global/UI state with `selectedStopId`.
  - Triggers navigation or state change so the Stop Sheet opens for that `selectedStopId`.
- In the Nearby list component:
  - When a card is clicked, also set `selectedStopId`.
  - Optionally scroll/flash the corresponding card when `selectedStopId` changes.

**Definition of done:**

- Clicking a map stop opens the Stop Sheet for that stop.
- Clicking a Nearby card opens the same Stop Sheet.
- The marker and the card for the active stop both show a “selected” style (glow/border).

---

### 0.2 Fix negative ETAs

**Goal:** Never show `-4m` etc as the main ETA.

**Implementation details:**

- In the ETA formatting function (frontend or shared core):
  - Accept the raw `etaMinutes` (number | null).
  - If `etaMinutes === null`: show `—`.
  - If `etaMinutes <= 0`:
    - Show `Due` or `Now` instead of a negative value.
- If you want “departed X minutes ago”:
  - Add an *optional secondary* field, but do not use negative values in the main ETA.

**Definition of done:**

- No UI text ever shows negative minutes.
- Departures at or past their time show “Due”/“Now” instead of `-Xm`.

---

### 0.3 Show ETA source (prediction vs schedule)

**Goal:** User can see whether a time is realtime or schedule-based.

**Implementation details:**

- Use `EtaSource` from the backend (`prediction | schedule | blended | unknown`).
- In the primary ETA component:
  - Add a small icon + label:
    - For `prediction` or `blended`: ⚡ + `Live`.
    - For `schedule`: 🕒 + `Sched`.
    - For `unknown`: optional `Est.`.
- Use small, subtle styling (10–12px) near the ETA.

**Definition of done:**

- Every primary ETA (top banner + main route cards) shows a small “Live” or “Sched” indicator.
- No ETA‑source logic is re‑implemented in the frontend; it only uses the API field.

---

## PHASE 1 – Stop Sheet Layout & Map Context

### 1.1 Desktop: Stop Sheet slides in from side, map always visible

**Goal:** On desktop widths, Stop Sheet appears as a side panel that slides in over the Nearby/Favorites column, not over the map.

**Implementation details:**

- Introduce layout state: `selectedStopId` + `isStopSheetOpen`.
- For desktop (e.g. `min-width: 1024px`):
  - Base layout:
    - Left: vertical column with Location + Favorites + Nearby.
    - Right: map panel, full height.
  - Stop Sheet:
    - Overlay positioned on top of the **left column only**.
    - Animated in/out using CSS transitions (slide from left or right).
    - Width: roughly the same as the column it covers.
- Optionally add a dimmed backdrop or drop shadow behind the sheet over the left column.

**Dismissal:**

- “Close” button in the Stop Sheet header.
- Clicking any dimmed area behind the sheet (if present).
- Pressing `Esc`.

**Definition of done:**

- On desktop, selecting a stop brings in a sliding panel over the left column.
- The map on the right never disappears when the Stop Sheet is open.
- The sheet is dismissible via Close button, ESC, and (if implemented) clicking outside.

---

### 1.2 Mobile: Stop Sheet as a bottom sheet

**Goal:** On mobile widths, Stop Sheet appears as a bottom sheet that slides up; the map remains at the top.

**Implementation details:**

- For narrow viewports (e.g. `< 1024px`):
  - Layout:
    - Top: header + small location summary.
    - Middle: map (fixed portion of viewport height).
    - Bottom: bottom sheet when a stop is selected.
  - Bottom sheet:
    - `position: fixed; bottom: 0; left: 0; right: 0;` with rounded top corners.
    - Default height ~50–60% of viewport, internal scroll for content.
- Add a visible “grip” bar and Close button at top of the sheet.

**Dismissal:**

- Tapping Close.
- Tapping the dimmed area above the sheet (if added).

**Definition of done:**

- On mobile, opening a stop reveals a bottom sheet without hiding the map.
- The sheet scrolls internally and can be dismissed easily.

---

### 1.3 “Currently viewing” indicator + selected marker styling

**Goal:** Keep the user oriented about which stop they’re viewing.

**Implementation details:**

- Add a small label near the top of the Stop Sheet or near the map:
  - `Viewing: Government Center` (or other stop name).
- On the map:
  - Mark `selectedStopId` with a special style:
    - Larger marker size.
    - Glow or halo ring.
    - Optional unique icon.

**Definition of done:**

- The active stop name is clearly visible outside detailed list content.
- The selected stop marker visually stands out from all others.

---

## PHASE 2 – Map Behavior & Line Filters

### 2.1 Initial map zoom & recenter behavior

**Goal:** Map opens zoomed to the user’s area plus nearest stops, not the full system.

**Implementation details:**

- Once user coordinates are known:
  - Use the Nearby data (or a dedicated helper) to find N nearest stops.
  - Build a bounding box including user location + these stops.
  - Call `fitBounds` (or equivalent) with padding to set center/zoom.
- Add a “Recenter” / “Use my location” button on the map:
  - On click, re-run the same fitBounds logic.

**Definition of done:**

- After location is resolved, the map zooms to a neighborhood‑scale view around the user.
- Clicking “Recenter” restores this view.

---

### 2.2 Thinner base lines and focused selection behavior

**Goal:** Lines feel light by default; selected lines stand out clearly.

**Implementation details:**

- Adjust map styling:
  - Default line stroke width ~1–2px.
  - Low opacity/saturation for base state.
- Create UI state `selectedRoutes: string[]`.
- Behavior:
  - Default `selectedRoutes = []` → all lines visible but light.
  - Clicking a line chip:
    - Adds/removes the route id to/from `selectedRoutes`.
- Map rendering:
  - For routes in `selectedRoutes`:
    - Slightly thicker line width (e.g. 2–3px).
    - Higher opacity and subtle glow.
  - For all other routes:
    - Remain thin and slightly faded.

**Definition of done:**

- With no chips selected, all lines are faint but visible.
- Selecting chips emphasizes those lines and fades others.
- Multiple lines can be selected simultaneously.

---

### 2.3 Clear filter chip state

**Goal:** Chip styling clearly shows which lines are active.

**Implementation details:**

- Chip styles:
  - **Selected:**
    - Filled background in the line’s color.
    - High‑contrast text.
    - Small outer glow.
  - **Unselected:**
    - Transparent/dark background.
    - Border in line color or neutral gray.
- Include hover and keyboard focus visual states.

**Definition of done:**

- It is immediately obvious which chips are active vs inactive.
- Toggling a chip changes both its visual state and map content in sync.

---

### 2.4 Hook “Follow trip” to vehicle display

**Goal:** “Follow trip” actually tracks a moving vehicle on the map.

**Implementation details:**

- When user clicks “Follow trip” for a departure:
  - Store `followedTripId` in global/front‑end state.
- Add React Query hook for `/api/trips/:tripId/track` to get:
  - Vehicle position.
  - Upcoming stops.
- On the map:
  - Render a distinct vehicle marker for `followedTripId`.
  - Fit map view to show vehicle + next 1–2 stops.
- UI feedback:
  - Show a pill like `Following Green‑D to Park Street` with a `Stop` button.

**Definition of done:**

- Clicking “Follow trip” shows a vehicle icon and re‑centers map appropriately.
- Vehicle position updates periodically while following.
- “Stop” returns map behavior to normal and hides/tones down vehicle marker.

---

## PHASE 3 – Stop Sheet Readability & Content

### 3.1 Redesign top ETA banner

**Goal:** The top area clearly communicates the next departure for the focused route.

**Implementation details:**

- Choose the earliest upcoming departure for the currently focused route/direction.
- Banner includes:
  - Small label: `Next departure`.
  - Large text: `1 min` / `3 min` / `Due`.
  - Subtext: `Green‑D • Inbound to Park Street`.
  - Small `Live`/`Sched` tag.
- Use consistent padding and a single cohesive visual style.

**Definition of done:**

- Users can instantly see when the next train/bus is, which route/direction it is, and if it’s realtime.

---

### 3.2 Make primary route card useful

**Goal:** Use the primary card under the banner to present key route details and ETAs.

**Implementation details:**

- Inside the card:
  - Left area:
    - Route badge colored by line (e.g., Green‑D).
    - Route name + branch string.
    - Direction text.
  - Bottom or center row:
    - 2–3 chips for upcoming times (e.g., `1m`, `10m`, `21m`).
  - Right area:
    - Status pill: `On time`, `Delayed 5m`, etc.
- Reduce excess vertical padding but keep rounded style.

**Definition of done:**

- The primary route card clearly shows:
  - Route, direction, next few times, and status.
- No large empty areas feel like placeholders.

---

### 3.3 Normalize departures list layout

**Goal:** Departures list is scannable as a structured table.

**Implementation details:**

- Implement a flex or CSS grid layout for each row with columns:
  - Route
  - Destination/Direction
  - Time (scheduled or predicted)
  - ETA
  - Status
- Ensure rows use consistent heights and aligned text.
- Reuse the same ETA formatting, status pill style, and source icon logic.

**Definition of done:**

- All rows align visually by column.
- Scanning down the list clearly shows “which trip / when / status”.

---

### 3.4 Improve status indicators

**Goal:** “On time” becomes low‑noise; issues stand out.

**Implementation details:**

- Map status values to visual types:
  - `on_time` → subtle check icon or small pill.
  - `delayed` → yellow/orange pill + `Delayed +5m`.
  - `cancelled` → red pill + `Cancelled`.
  - `no_service` → gray pill + `No service`.
- Prefer simple rules (use delay difference between prediction and schedule) for text like `+5m`.

**Definition of done:**

- Normal service doesn’t spam bright pills.
- Any disruption is clearly visible.

---

### 3.5 Alerts & Facilities cleanup

**Goal:** Bottom sections feel intentional and informative, not placeholder‑ish.

**Implementation details:**

- Alerts:
  - If there are alerts:
    - Show cards with severity icons/colors and short copy.
  - If none:
    - Show `✅ No active alerts for this stop.`
- Facilities:
  - If there’s no data:
    - Hide or show very light text like `No facilities data available.`
  - If present:
    - List items such as Elevators, Escalators, Parking with status tags.

**Definition of done:**

- Alerts clearly communicate presence or absence of problems.
- Facilities section is either helpful or minimally unobtrusive.

---

## PHASE 4 – Home / Nearby & Favorites Simplification

### 4.1 Simplify location controls

**Goal:** Location is clear but not overwhelming on first glance.

**Implementation details:**

- Collapsed default state:
  - Single line like `Location: Using your location near {area}.` plus buttons `[Use my location] [Change]`.
- Expanded state (after `Change`):
  - Show Lat/Lng inputs and `Apply`.
  - Optionally add a text field for address/area search.

**Definition of done:**

- Most users only see a simple, human‑readable location summary.
- Power users can explicitly expand to set coordinates.

---

### 4.2 Clean Nearby cards & interaction

**Goal:** Nearby cards are simple, aggregated by station, and clearly clickable.

**Implementation details:**

- Aggregate nearby results so there is **one card per station**.
- Card content:
  - Top‑left: station name.
  - Top‑right: distance (smaller font).
  - Middle: route chips with primary ETAs (`Green‑B 5m`, `Green‑C 7m`, etc.).
- Interaction:
  - Entire card is clickable (pointer cursor, hover effect).
  - Clicking card sets `selectedStopId` and opens Stop Sheet.
- Remove redundant `View board` buttons inside cards.

**Definition of done:**

- Nearby list shows unique station cards.
- Clicking any card opens the corresponding Stop Sheet.

---

### 4.3 Clarify Favorites behavior

**Goal:** Users understand how to favorite stops and use the Favorites section.

**Implementation details:**

- Empty state text:
  - `You haven’t favorited any stops yet. Click ★ on a stop in Nearby or in a Stop Sheet to pin it here.`
- When favorites exist:
  - Show them above Nearby using same card layout.
- Ensure star icons on cards/sheets toggle favorite state and lists update immediately.

**Definition of done:**

- It’s obvious how to add/remove favorites.
- Favorites feel like a quick‑access section for routine stops.

---

## PHASE 5 – Visual & Accessibility Polish

### 5.1 Standardize type scale & spacing

**Goal:** Typography and spacing feel cohesive across all screens.

**Implementation details:**

- Define a type scale and map to classes (e.g., `h1`, `h2`, `h3`, `body`, `caption`). Apply consistently:
  - Stop names → `h2`.
  - Section headings → `h3`.
  - Primary ETAs → larger, medium/semibold text.
  - Secondary info → body or caption.
- Normalize horizontal & vertical padding for cards and panels.

**Definition of done:**

- No random font sizes; repeated elements look consistent.
- Overall rhythm feels calm and readable.

---

### 5.2 Better interaction feedback & keyboard nav

**Goal:** The app is pleasant and functional with keyboard and pointer.

**Implementation details:**

- Add clear hover + focus styles for:
  - Nearby/Favorite cards.
  - Filter chips.
  - Important buttons.
- Ensure tabbing can:
  - Reach cards and chips.
  - Open/close the Stop Sheet via Enter/Space and ESC.

**Definition of done:**

- Users can navigate, open boards, and adjust filters by keyboard only.
- Interactive elements visually acknowledge focus/hover.

---

### 5.3 Touch target sizing (mobile)

**Goal:** Controls are easily tappable on mobile devices.

**Implementation details:**

- For all small buttons/chips (line filters, location actions, star icons):
  - Ensure effective touch size ≈ 44x44px or more.
  - Increase padding where needed.

**Definition of done:**

- No obviously tiny tap targets remain in mobile layout.
- Buttons and chips are comfortable to hit with a thumb.

---

## PHASE 6 – Diagnostics & Station Mapping (Bonus)

### 6.1 Station hierarchy sanity check

**Goal:** Ensure LineLight uses boardable stops (stations/platforms), not entrances, for ETAs.

**Implementation details:**

- In backend MBTA integration:
  - Use MBTA stop metadata (`location_type`, `parent_station`) to classify stops as `station`, `platform`, or `entrance`.
  - Add a helper to check stop “kind” and resolve a boardable stop if needed.
- Update ETA logic:
  - Target station/platform stops for ETAs.
  - Avoid requesting ETAs on pure entrances.

**Definition of done:**

- No ETAs are computed for entrance‑only nodes.
- There is a reusable helper to resolve MBTA stop types.

---

### 6.2 ETA diagnostics/report

**Goal:** Be able to inspect how ETA blending behaves on real data.

**Implementation details:**

- Add a dev‑only endpoint or CLI:
  - Input: stop id + time window.
  - Output: JSON/CSV with rows including schedule time, prediction time, final ETA, source, and status.
- Optionally render a simple internal HTML table for quick inspection.

**Definition of done:**

- A developer can run one command or hit a protected endpoint to view raw vs blended ETAs for a given stop.
- This tooling does not affect production UI behavior.

---

This whole plan is meant to be executed incrementally. After finishing one phase, run the app, verify behavior, and then proceed to the next.
