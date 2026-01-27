# Trip Planner Spec

## API

### Request (GET)
`/api/trip-planner?originLat=42.373362&originLon=-71.118956&destLat=42.370800&destLon=-71.077100&departAt=2026-01-15T21:20:00Z&modes=subway,bus&maxWalkMinutes=12&maxTransfers=2`

### Response (200)
```json
{
  "generatedAt": "2026-01-15T21:20:12.123Z",
  "request": {
    "originLat": 42.373362,
    "originLon": -71.118956,
    "destLat": 42.3708,
    "destLon": -71.0771,
    "departAt": "2026-01-15T21:20:00Z",
    "modes": ["subway", "bus"],
    "maxWalkMinutes": 12,
    "maxTransfers": 2
  },
  "summary": {
    "totalMinutes": 27.0,
    "walkMinutes": 1.2,
    "waitMinutes": 10.5,
    "rideMinutes": 15.3,
    "transfers": 1,
    "confidence": "realtime"
  },
  "primary": {
    "tripId": "tripplan-20260115-001",
    "legs": [
      {
        "mode": "walk",
        "from": { "label": "Origin", "lat": 42.373362, "lon": -71.118956 },
        "to": { "stopId": "place-harsq", "name": "Harvard", "lat": 42.373362, "lon": -71.118956 },
        "distanceMeters": 120,
        "durationMinutes": 1.0,
        "style": "walk"
      },
      {
        "mode": "subway",
        "routeId": "Red",
        "lineId": "line-Red",
        "directionId": 0,
        "headsign": "Ashmont/Braintree",
        "from": { "stopId": "place-harsq", "name": "Harvard" },
        "to": { "stopId": "place-pktrm", "name": "Park Street" },
        "departureTime": "2026-01-15T21:23:10Z",
        "arrivalTime": "2026-01-15T21:24:10Z",
        "waitMinutes": 3.1,
        "rideMinutes": 1.0,
        "source": "prediction",
        "shape": { "type": "line", "lineId": "line-Red", "segmentStopIds": ["place-harsq", "place-pktrm"] }
      },
      {
        "mode": "subway",
        "routeId": "Green-D",
        "lineId": "line-Green",
        "directionId": 1,
        "headsign": "Union Square",
        "from": { "stopId": "place-pktrm", "name": "Park Street" },
        "to": { "stopId": "place-lech", "name": "Lechmere" },
        "departureTime": "2026-01-15T21:30:20Z",
        "arrivalTime": "2026-01-15T21:44:40Z",
        "waitMinutes": 7.4,
        "rideMinutes": 14.3,
        "source": "prediction",
        "shape": { "type": "line", "lineId": "line-Green", "segmentStopIds": ["place-pktrm", "place-lech"] }
      },
      {
        "mode": "walk",
        "from": { "stopId": "place-lech", "name": "Lechmere" },
        "to": { "label": "Destination", "lat": 42.3708, "lon": -71.0771 },
        "distanceMeters": 250,
        "durationMinutes": 1.2,
        "style": "walk"
      }
    ],
    "map": {
      "bounds": [[42.3700, -71.1215], [42.3740, -71.0770]],
      "walkPolyline": "encoded-polyline-gray",
      "lineShapes": [
        { "lineId": "line-Red", "color": "#DA291C", "polyline": "encoded-red" },
        { "lineId": "line-Green", "color": "#00843D", "polyline": "encoded-green" }
      ]
    }
  },
  "alternates": [
    {
      "tripId": "tripplan-20260115-002",
      "totalMinutes": 31.4,
      "transfers": 2,
      "legs": []
    }
  ],
  "warnings": [
    { "code": "fallback_headway", "message": "Used scheduled headway for 1 leg." }
  ]
}
```

### Response (error)
```json
{
  "error": "no_route",
  "message": "No valid path found within constraints.",
  "requestId": "req-abc123"
}
```

## Component Tree

### Entry Point
- `web/src/components/home/HomeShell.tsx`
  - `TripPlannerCTAButton`
  - `TripPlannerModal` (portal)

### Modal
- `web/src/components/trip/TripPlannerModal.tsx`
  - `TripPlannerHeader`
  - `TripPlannerForm`
    - `TripInputField` (Start)
    - `TripInputField` (Destination)
    - `SwapButton`
    - `ModeFilters`
    - `PlanTripButton`
  - `TripPlannerBody`
    - `TripPlannerMap`
      - `TripMapBase`
      - `LineShapeLayer`
      - `WalkLayer` (gray dashed)
      - `StopMarkersLayer`
    - `TripPlannerResults`
      - `PrimaryTripCard`
        - `TripSummaryRow`
        - `TripLegList`
          - `TripLegRow`
      - `AlternateTripsList`
        - `AlternateTripCard`
  - `TripPlannerFooter`
    - `CloseButton`
    - `SaveTripButton` (future)

## Frontend Types (Proposed)

### View Models
```ts
type TripModeState =
  | "HOME"
  | "TRIP_EDITING"
  | "TRIP_PLANNING"
  | "TRIP_READY"
  | "TRIP_ERROR"
  | "TRIP_FOLLOW_LEG";

type TripPoint = {
  label: string;
  lat: number;
  lon: number;
  stopId?: string | null;
};

type TripPlanView = {
  tripId: string;
  label: "Best route" | `Alternate ${number}`;
  totalMinutes: number;
  transfers: number;
  walkMinutes: number;
  waitMinutes: number;
  rideMinutes: number;
  confidence: "realtime" | "fallback" | "estimate";
  legs: TripPlannerLeg[];
  map: TripPlan["map"];
};

type TripPlannerViewModel = {
  origin: TripPoint | null;
  destination: TripPoint | null;
  activeTripId: string | null;
  plans: TripPlanView[];
  summary: TripPlannerResponse["summary"] | null;
  warnings: string[];
};
```

### Suggestions
```ts
type Suggestion = {
  id: string;
  kind: "saved" | "stop" | "search";
  label: string;
  lat: number;
  lon: number;
  stopId?: string | null;
};
```

### Component Props (Trip Planner on Home)
```ts
type TripPlannerInputRowProps = {
  mode: TripModeState;
  originInput: string;
  destinationInput: string;
  origin: TripPoint | null;
  destination: TripPoint | null;
  isPlanning: boolean;
  error?: string | null;
  summary?: TripPlannerResponse["summary"] | null;
  onOriginInputChange: (value: string) => void;
  onDestinationInputChange: (value: string) => void;
  onOriginSelect: (point: TripPoint) => void;
  onDestinationSelect: (point: TripPoint) => void;
  onSwap: () => void;
  onSubmit: () => void;
  onCancel: () => void;
  suggestions: {
    origin: Suggestion[];
    destination: Suggestion[];
  };
  loadingSuggestions: {
    origin: boolean;
    destination: boolean;
  };
  suggestionError: {
    origin?: string | null;
    destination?: string | null;
  };
};

type TripRouteOptionsListProps = {
  activeTripId: string | null;
  plans: TripPlanView[];
  onSelectTrip: (tripId: string) => void;
};

type TripDetailsSheetProps = {
  trip: TripPlanView | null;
  summary?: TripPlannerResponse["summary"] | null;
  warnings?: string[];
  onTrackLeg: (legId: string) => void;
  onStopFollow: () => void;
  isFollowMode: boolean;
};

type TripLegListProps = {
  legs: TripPlannerLeg[];
  onTrackLeg: (legId: string) => void;
};

type TripMapLayersProps = {
  activeTrip: TripPlanView | null;
  baseLinesEnabled: boolean;
  mapReady: boolean;
};

type TripPlannerOverlayProps = {
  mode: TripModeState;
  error?: string | null;
  warnings?: string[];
};
```

### Mapping (API -> View Model)
```ts
const mapTripPlannerResponse = (resp: TripPlannerResponse): TripPlannerViewModel => {
  const toPlan = (trip: TripPlan, label: TripPlanView["label"]): TripPlanView => ({
    tripId: trip.tripId,
    label,
    totalMinutes: trip.totalMinutes ?? resp.summary.totalMinutes,
    transfers: trip.transfers ?? resp.summary.transfers,
    walkMinutes: resp.summary.walkMinutes,
    waitMinutes: resp.summary.waitMinutes,
    rideMinutes: resp.summary.rideMinutes,
    confidence: resp.summary.confidence,
    legs: trip.legs,
    map: trip.map,
  });

  return {
    origin: null,
    destination: null,
    activeTripId: resp.primary.tripId,
    plans: [
      toPlan(resp.primary, "Best route"),
      ...resp.alternates.map((trip, idx) => toPlan(trip, `Alternate ${idx + 1}`)),
    ],
    summary: resp.summary,
    warnings: resp.warnings ?? [],
  };
};
```

## Implementation Phases

1) Backend trip planner service + endpoint
2) Backend caching + data fetch strategy
3) Backend tests (unit + contract)
4) Shared types + schema validation
5) Frontend data hook
6) Frontend UI entry + modal
7) Map preview layers
8) Results UI (primary + alternates)
9) UX state handling
10) Integration tests
11) Performance + error handling
12) End-to-end verification
