# Design System & Visual Style

File: `docs/07-design-system-and-visual-style.md`

This document defines the visual language of the MBTA System Radar app. It should guide both human designers and AI-assisted code generation when creating components, Tailwind classes, and motion patterns.

Goals:

- Dark, modern, “dashboard-grade” UI.
- Strong but tasteful use of **glow** and **motion**.
- Clear visual hierarchy and legible typography.
- Consistent representation of lines, status, and alerts.


## 1. Color palette

Colors are expressed in hex. Tailwind customization will mirror these choices with semantic names (e.g., `primary`, `bg-elevated`, `accent-glow`).

### 1.1 Neutrals (background & surfaces)

- **Background base:** `#05070B` (near-black, used for app background).
- **Background elevated:** `#0B1017` (panels, cards).
- **Background subtle:** `#121924` (hovered or focused cards/panels).
- **Border subtle:** `#1B2430`.
- **Divider lines:** `#212B36`.

### 1.2 Text

- **Primary text:** `#F5F7FA`.
- **Secondary text:** `#B1B9C7`.
- **Muted text:** `#6C7685`.
- **On-accent text (dark background):** `#FFFFFF`.

### 1.3 MBTA line colors (approximate)

These should be used for route lines, chips, and related UI:

- **Red Line:** `#DA291C`.
- **Orange Line:** `#ED8B00`.
- **Blue Line:** `#003DA5`.
- **Green Line (branches):**
  - General / shared: `#00843D`.
  - B/C/D/E variants can use the same green with subtle differentiators (patterns or slightly varied tints).
- **Silver Line / BRT:** `#7C878E`.
- **Commuter Rail:** `#80276C` (purple).

### 1.4 Status & alerts

- **Good / on-time:** `#00C48C` (teal green).
- **Minor issues:** `#FFC857` (amber).
- **Major issues:** `#FF4B5C` (red/pink).
- **Unknown / neutral:** `#6C7685`.

These are applied to line segments, badges, and text indicators. Always ensure sufficient contrast against backgrounds.


## 2. Typography

We assume a modern sans-serif font stack such as:

- Primary: `"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`

### 2.1 Font sizes & roles (approximate)

- **Page title / app title:** 24–28px, semibold.
- **Section title (panel headers):** 18–20px, semibold.
- **Body text:** 14–16px, normal weight.
- **Caption / meta text:** 12–13px, medium or normal.

### 2.2 Weights

- Headings: `600` (semibold).
- Body: `400`.
- Labels / chips: `500`.

Text should be high-contrast against the dark background, with slightly higher letter-spacing for small text.


## 3. Components & visual patterns

This section defines visual patterns for key components.

### 3.1 Line chips

Used in the sidebar to represent lines:

- Shape: Rounded pill (`rounded-full`).
- Background: low-opacity line color (e.g., `bg-[rgba(lineColor,0.15)]`).
- Border: 1px outline in line color at ~40–60% opacity.
- Text: line name (`"Red Line"`) in primary text color.
- Selected state:
  - Stronger background (e.g., ~30–40% opacity of line color).
  - Inner glow or subtle drop shadow.
  - Slight scale up on hover/focus via motion.


### 3.2 Station markers

On the map:

- Base: small circle with:
  - Fill: `#F5F7FA` or muted line-specific tint.
  - Outline: `#0B1017` or background color.
- Selected station:
  - Larger circle with halo/glow using the line color.
  - Slight pulsing animation to draw attention.
  - Tooltip or label showing station name on hover/click.

For clusters of stops at a major station, markers should still feel coherent and not overload the map.


### 3.3 KPI cards

Used in LineOverviewPanel and InsightsPanel:

- Container:
  - Background: `#0B1017` (`bg-elevated`).
  - Border: 1px `#1B2430`.
  - Corner radius: `0.75rem` or `xl`.
  - Padding: `1rem`–`1.25rem`.
- Title:
  - Small, uppercase label (e.g., “HEADWAY (MIN)”).
  - Color: secondary text.
- Value:
  - Large numeral (e.g., 24px, semibold).
  - Color: primary text, optionally tinted by status.
- Status indicator:
  - Small tag, e.g., green for “normal”, amber/red for issues.
- Hover:
  - Slight elevation & subtle glow at edges.
  - Quick scale increase (~1.03).


### 3.4 Alert badges

- Shape: pill or rounded rectangle.
- Background: gradient from dark red to lighter red/orange depending on severity.
- Icon: triangle exclamation or construction / shuttle bus icon.
- Text: short header (“Signal issue”, “Shuttle bus”) with truncated detail.

Severity mapping:

- Minor: more subdued amber with slim border.
- Major: bright red background with white icon/text.


## 4. Glow & motion language

Glow and motion are deliberate tools, not decorations everywhere.


### 4.1 Glow usage

Use glow to indicate:

- Current focus (selected line, station, or segment).
- Active/hovered actions (buttons, chips, markers).

Avoid glow for:

- Background static labels.
- Non-interactive decorations.

Examples:

- Selected line segment:
  - Core stroke: solid line color.
  - Outer glow: softer version of line color, blurred out 2–4px.
- Selected station marker:
  - Halo ring with subtle blur + brightness.


### 4.2 Motion principles

- **Durations:** 150–300ms for most UI transitions.
- **Easing:** standard `ease-out` / `ease-in-out` curves (slight overshoot only for big transitions).
- **Continuity:** state changes should animate smoothly rather than jump:
  - Line color changes fade over time.
  - Cards/panels slide or fade in/out rather than appear/disappear.

Representative motion patterns:

- Panel slide-in: from 16–24px offset at 0% opacity → final position at full opacity.
- Hover scale: 1.00 → 1.03 with slight shadow increase.
- Vehicle update: smooth interpolation along route over the polling interval.


## 5. Tailwind conventions

Tailwind is our primary styling tool. We customize it with:

- Root colors configured in `tailwind.config.js` under semantic names:
  - `colors.bg.base`, `colors.bg.elevated`, `colors.text.primary`, etc.
  - `colors.line.red`, `colors.line.orange`, etc.
  - `colors.status.good`, `colors.status.minor`, `colors.status.major`.

### 5.1 Utility patterns

Common container pattern for cards/panels:

```txt
bg-bg-elevated border border-border-subtle rounded-xl p-4
```

Map of utility concepts:

- Panels: `bg-bg-elevated border border-border-subtle rounded-xl shadow-sm`.
- Chips: `inline-flex items-center gap-2 rounded-full px-3 py-1`.
- Headings: `text-lg font-semibold text-text-primary`.
- Secondary text: `text-sm text-text-secondary`.
- Muted captions: `text-xs text-text-muted uppercase tracking-wide`.


### 5.2 Layout helpers

- `flex` + `gap-4` for panel layouts and toolbars.
- `grid` + `gap-4` for KPI card grids.
- `min-h-[X]` constraints for panels to keep them visually balanced.


## 6. Motion / animation with Motion/Framer Motion

We use Motion/Framer Motion (or similar) to orchestrate animations.

### 6.1 Basic component patterns

Panel container variants:

- `hidden` → `visible`:
  - Initial: `opacity: 0`, `y: 16`.
  - Animate: `opacity: 1`, `y: 0`, duration 0.2–0.3s.

Hover effect for cards:

- While hover:
  - Scale: `1.03`.
  - Box-shadow: stronger, slightly colored by line/status.

Tab transitions (e.g., switching between line and station views):

- Crossfade content with a quick fade out + fade in.
- Optional slide or blur for added depth.


### 6.2 Vehicle marker updates

- Each vehicle marker can be rendered as a component that:
  - Receives `from` and `to` positions plus `updatedAt` from backend.
  - Interpolates `(lat, lng)` between `from` and `to` over the poll interval.
- Use continuous transitions for position changes; abrupt jumps only on major route changes.


## 7. Iconography

Icons should be simple, clear, and line-based where possible.

Suggested approach:

- Use a React icon library (e.g., Heroicons or Lucide) for UI icons.
- Keep icons at 16–24px for most usage.
- Use line-color tints on map-related icons to tie them visually to the network.


## 8. Putting it all together

- Dark, minimal background keeps focus on the MBTA network and data visualizations.
- MBTA line colors provide instant recognition and visual grouping.
- Glow and motion highlight **what matters**, not everything.
- Tailwind utilities + design tokens ensure consistent styling across components.
- Motion/Framer Motion patterns provide a cohesive feel as users move between lines, stations, and system views.

This design system should be used as the reference for building React components, Tailwind classes, and map visualizations that look and feel coherent throughout the MBTA System Radar app.
