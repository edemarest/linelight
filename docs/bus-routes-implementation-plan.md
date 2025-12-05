# Bus Routes Implementation Plan

## Executive Summary
Plan to add bus route shapes to the LineLight map, rendering them in yellow when viewing bus stops, without overcrowding the default map view.

---

## Current State Analysis

### 1. Data Sources Available

#### MBTA API Resources
- **Routes API**: `filter[type]=3` returns all bus routes (type 3 = bus)
- **Shapes API**: `filter[route]=<route_id>` returns polyline-encoded paths for each route
- **Lines API**: MBTA groups some buses into "lines" but most buses are standalone routes

#### Backend Infrastructure
**Location**: `backend/src/services/lineShapes.ts`
- `buildLineShapes()` function already exists
- Fetches shapes using `client.getShapes({ "filter[route]": lineId })`
- Decodes polylines using `@mapbox/polyline`
- Returns `{ lineId, color, textColor, shapes: Coordinate[][] }`
- **Currently only called for subway lines** (Red, Orange, Blue, Green, Mattapan)

**Polling System**: `backend/src/polling/startPolling.ts`
```typescript
const TARGET_ROUTE_TYPES = [0, 1, 2, 3]; // includes bus (type 3)
```
- Already fetches ALL routes including buses every hour
- Stores in cache via `cache.setRoutes(routes)`
- Filters for subway routes only when building line shapes

**Route Type Mapping**: `backend/src/utils/routeMode.ts`
- Type 3 → "bus" mode
- Types 0,1 → "subway" mode

### 2. Frontend Rendering

#### Map Layer System
**Location**: `web/src/components/home/HomeShell.tsx`
- Uses DeckGL `PathLayer` to render route shapes
- Current implementation (lines 1094-1131):
  - Queries `fetchLineShapes(line.id)` for each line
  - Creates one PathLayer per line
  - All layers rendered simultaneously
  - **Only renders subway lines from /api/lines endpoint**

```typescript
const lineShapesQuery = useQuery({
  queryKey: ["lineShapes", "all"],
  queryFn: async () => {
    const results = await Promise.all(
      lines.filter(line => line.mode === "subway").map(line =>
        fetchLineShapes(line.id)
      )
    );
    return results.filter(Boolean);
  },
});
```

#### Design System
**Location**: `web/src/lib/designTokens.ts`
- Bus color already defined: `#F4C542` (yellow)
- `getLineToken()` identifies bus routes by:
  - Numeric-only IDs (e.g., "1", "28", "57")
  - IDs containing "bus"
- Returns token with yellow color for buses

### 3. Scale Analysis

#### How Many Bus Routes?
Based on MBTA documentation and typical operations:
- **~170-200 total bus routes** in greater Boston
- Each route has **2-6 shape variations** (outbound/inbound, branches)
- **Estimated total: 500-800 bus route shapes**

#### Performance Implications
**Current subway rendering**:
- 8 subway lines (Red, Orange, Blue, Green-B/C/D/E, Mattapan)
- ~30-40 total shapes
- Renders smoothly with DeckGL

**Adding all buses**:
- 500-800 shapes would be **20-25x more data**
- Polyline data per route: ~2-10 KB encoded, ~20-100 KB decoded coordinates
- **Total data: ~10-50 MB uncompressed**
- **Risk**: Map lag, memory issues, visual overcrowding

---

## Implementation Strategy

### Option A: On-Demand Bus Route Loading (RECOMMENDED)

#### When to Show Bus Routes
1. **User clicks on a bus stop** → Show routes serving that specific stop
2. **User selects a bus line** from filters/search → Show that line's shapes
3. **Never show by default** on main map (too cluttered)

#### Architecture

**1. Backend API Endpoint**
Create new endpoint: `GET /api/routes/:routeId/shapes`

```typescript
// backend/src/index.ts
app.get("/api/routes/:routeId/shapes", async (req, res) => {
  const { routeId } = req.params;
  const shapes = await buildLineShapes(cache, client, routeId);
  res.json(shapes);
});
```

**2. Frontend Query Hook**
```typescript
// web/src/lib/api.ts
export const fetchRouteShapes = (routeId: string): Promise<LineShapeResponse> =>
  fetch(`${API_BASE_URL}/api/routes/${routeId}/shapes`).then(r => r.json());

// web/src/components/stop/StopSheetPanel.tsx
const busRouteShapesQuery = useQuery({
  queryKey: ["routeShapes", activeBusRoutes],
  queryFn: () => Promise.all(
    activeBusRoutes.map(routeId => fetchRouteShapes(routeId))
  ),
  enabled: activeBusRoutes.length > 0 && stopSheetOpen,
});
```

**3. Conditional Layer Rendering**
```typescript
// In HomeShell.tsx
const busRouteLayers = useMemo(() => {
  if (!selectedStop || !selectedStopBusRoutes.data) return [];
  
  return selectedStopBusRoutes.data.map(route => 
    new PathLayer({
      id: `bus-route-${route.lineId}`,
      data: route.shapes,
      getPath: d => d.map(coord => [coord.lng, coord.lat]),
      getColor: hexToColor("#F4C542"), // yellow
      getWidth: 3,
      widthMinPixels: 2,
      widthMaxPixels: 6,
      jointRounded: true,
      capRounded: true,
      opacity: 0.7,
    })
  );
}, [selectedStop, selectedStopBusRoutes.data]);

// In DeckGL layers array
layers={[...pathLayers, ...busRouteLayers, ...vehicleLayers]}
```

**4. Stop Sheet Integration**
When user opens a stop sheet:
1. Extract bus route IDs from `board.details.routes` where `mode === "bus"`
2. Trigger `busRouteShapesQuery` with those route IDs
3. Add bus route layers to map
4. Highlight routes in yellow overlay
5. Remove layers when stop sheet closes

#### Performance Optimizations
- **Lazy loading**: Only fetch when needed
- **Caching**: React Query caches for 5 minutes
- **Limit**: Max 5-10 bus routes per stop (typical)
- **Debounce**: Wait 300ms after stop selection before fetching

---

### Option B: Pre-load Top Routes (Alternative)

#### Concept
Pre-load shapes for the busiest ~30 bus routes, show on demand

**Top Boston Bus Routes** (by ridership):
- 1, 15, 23, 28, 39, 57, 66, 71, 73, 77, 111, 116, 117
- Silver Line: 741 (SL1), 742 (SL2), 743 (SL3), 746 (SL4), 749 (SL5)
- Key Line: 501, 504, 505

**Implementation**:
```typescript
const TOP_BUS_ROUTES = ["1", "15", "23", "28", "39", "57", "66", "71", ...];

const topBusShapesQuery = useQuery({
  queryKey: ["busShapes", "top"],
  queryFn: () => Promise.all(
    TOP_BUS_ROUTES.map(routeId => fetchRouteShapes(routeId))
  ),
  staleTime: Infinity, // Cache forever
});
```

**Pros**: Faster for popular routes
**Cons**: Still downloads ~100-200 shapes, may not cover user's route

---

### Option C: Tile-Based Streaming (Advanced)

Use viewport bounds to fetch only visible bus routes

**Too Complex** for Phase 1 - defer to future if needed

---

## Recommended Implementation Plan

### Phase 1: Conditional Bus Route Rendering

#### Step 1: Backend Enhancement
- [x] Fix TypeScript errors in `etaBlender.ts`
- [ ] Test `buildLineShapes()` with bus route IDs (verify it works for type 3)
- [ ] Add endpoint: `GET /api/routes/:routeId/shapes`
- [ ] Add batch endpoint: `GET /api/routes/shapes?ids=1,28,39` (optional optimization)

#### Step 2: Frontend API Layer
- [ ] Add `fetchRouteShapes(routeId)` to `web/src/lib/api.ts`
- [ ] Add `useBusRouteShapes(routeIds[])` hook for conditional fetching

#### Step 3: Stop Sheet Integration
- [ ] Extract bus route IDs from active stop's board data
- [ ] Trigger shape query when stop sheet opens with bus routes
- [ ] Clear shapes when stop sheet closes
- [ ] Add loading state for route shapes

#### Step 4: Map Layer Updates
- [ ] Create `busRouteLayers` memoized array
- [ ] Use yellow color (#F4C542) at 70% opacity
- [ ] Set width 2-6 pixels, rounded joins/caps
- [ ] Insert between subway layers and vehicle markers (z-order)
- [ ] Add subtle animation on load (optional polish)

#### Step 5: Visual Polish
- [ ] Add legend indicator: "Showing route XX in yellow"
- [ ] Dim subway lines when bus routes active (reduce visual noise)
- [ ] Add toggle in stop sheet: "Show route on map" checkbox
- [ ] Consider highlighting the route in route selector when visible

### Phase 2: Enhancements (Future)
- [ ] Pre-cache top 30 bus routes
- [ ] Add route search/filter to show specific bus routes
- [ ] Add "Explore Bus Routes" mode to browse all buses
- [ ] Viewport-based loading for extreme zoom-out

---

## Data Structure Reference

### Route Shape Response
```typescript
interface LineShapeResponse {
  lineId: string;
  color: string | null;      // "#F4C542" for buses
  textColor: string | null;
  shapes: Coordinate[][];    // Array of paths (each path = array of {lat, lng})
}

interface Coordinate {
  lat: number;
  lng: number;
}
```

### Stop Board Route Data
```typescript
interface StationBoardRoutePrimary {
  routeId: string;
  shortName: string | null;
  mode: "subway" | "bus" | "commuter_rail" | "ferry";
  // ... other fields
}
```

---

## Key Files to Modify

### Backend
1. `backend/src/index.ts` - Add route shapes endpoint
2. `backend/src/services/lineShapes.ts` - Already works, no changes needed
3. Test with bus route IDs to verify

### Frontend
1. `web/src/lib/api.ts` - Add `fetchRouteShapes()`
2. `web/src/components/stop/StopSheetPanel.tsx` - Extract bus routes, trigger query
3. `web/src/components/home/HomeShell.tsx` - Add bus route layers conditionally
4. `web/src/lib/designTokens.ts` - Already has bus yellow color

---

## Testing Plan

### 1. Backend Verification
```bash
# Test shape fetch for bus route "1"
curl http://localhost:3001/api/routes/1/shapes

# Verify response has:
# - lineId: "1"
# - color: "#F4C542" (or similar yellow)
# - shapes: array of coordinate arrays
```

### 2. Frontend Testing
1. Click on a bus stop (e.g., "Harvard Square")
2. Verify route shapes query triggered
3. Check yellow lines appear on map
4. Close stop sheet → routes disappear
5. Test with multiple bus routes at same stop
6. Verify no lag or performance issues

### 3. Edge Cases
- Stop with 10+ bus routes → limit or paginate?
- Bus route with missing shapes → graceful fallback
- Rapid stop selection → debounce/cancel previous queries

---

## Performance Metrics

### Target Metrics
- **Route shape load time**: < 500ms for 5 routes
- **Map render time**: < 100ms to add bus layers
- **Memory impact**: < 5MB per 10 bus routes
- **No visual jank** when adding/removing layers

### Monitoring
- Log fetch times in dev console
- Monitor React Query cache size
- Check DeckGL layer count (max ~50 layers safe)

---

## Alternative Yellow Color Options
Current: `#F4C542` (golden yellow)

Alternatives if too bright:
- `#FDB813` (MBTA official bus yellow)
- `#E6B400` (darker gold)
- `#FFD700` (pure gold)
- `#F2A900` (amber)

Test with 70% opacity on map to ensure visibility against various map tiles.

---

## Next Actions

1. ✅ Analyze existing code and data structure
2. ✅ Document implementation plan
3. ⏭️ Test `buildLineShapes()` with bus route ID "1"
4. ⏭️ Implement backend endpoint `/api/routes/:routeId/shapes`
5. ⏭️ Add frontend query hooks
6. ⏭️ Integrate with StopSheetPanel
7. ⏭️ Add conditional map layers
8. ⏭️ Polish and test

**Ready to proceed with implementation when you give the signal!**
