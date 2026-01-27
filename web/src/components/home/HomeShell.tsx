"use client";

// Primary UI shell for the map: owns trip planning, stop sheets, and follow mode state.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import MapGL, { Layer, Marker, Source, type MapLayerMouseEvent, type MapRef, type ViewState } from "react-map-gl/maplibre";
import type { GeoJSONSource, StyleSpecification } from "maplibre-gl";
import { Fragment } from "react";
import maplibregl from "maplibre-gl";
import { envConfig } from "@/lib/config";
import {
  fetchHome,
  fetchLineShapes,
  fetchStations,
  fetchTripTrack,
  fetchTripPlanner,
  type LineShapeResponse,
  type StationPlatformMarker,
  type StationSummary,
} from "@/lib/api";
import type { HomeStopSummary, HomeResponse, Mode, TripPlannerLeg } from "@linelight/core";
import { StopSheetPanel } from "@/components/stop/StopSheetPanel";
import {
  FiMapPin,
  FiCrosshair,
  FiStar,
  FiZap,
  FiSearch,
  FiEdit,
  FiTrash2,
  FiBookmark,
  FiArrowRight,
  FiMap,
  FiList,
  FiChevronDown,
  FiClock,
  FiSmile,
  FiX,
  FiRepeat,
  FiDownload,
} from "react-icons/fi";
import { FaStar, FaWalking } from "react-icons/fa";
import { formatEta, formatEtaChip } from "@/lib/time";
import { useAppState } from "@/state/appState";
import { EtaSourceIndicator } from "@/components/stop/EtaSourceIndicator";
import { getDirectionToken, getLineToken } from "@/lib/designTokens";
import type { LineToken } from "@/lib/designTokens";
import { getStopHue } from "@/lib/stopStyling";
import { DirectionArrowIcon } from "@/components/common/DirectionArrowIcon";
import { useThemeMode } from "@/hooks/useThemeMode";
import { breakpointClass, useBreakpoint } from "@/hooks/useBreakpoint";
import { useResponsiveMapHeights } from "@/hooks/useResponsiveMapHeights";
import type { TripModeState, TripPlannerViewModel, TripPoint, TripPlanView } from "@/lib/tripPlannerViewModel";
import { mapTripPlannerResponse } from "@/lib/tripPlannerViewModel";
import { useMapUiMode, useMapVisibility } from "@/hooks/useMapUiMode";
import { useMapFocusDispatcher, type FocusPoint } from "@/hooks/useMapFocusDispatcher";

const MAP_STYLE_VERSION = "2026-01-21c";
const buildCartoStyleUrl = (styleId: string) => {
  try {
    const url = new URL(`/api/map/carto/style/${styleId}`, envConfig.apiBaseUrl);
    url.searchParams.set("v", MAP_STYLE_VERSION);
    return url.toString();
  } catch {
    return `/api/map/carto/style/${styleId}?v=${encodeURIComponent(MAP_STYLE_VERSION)}`;
  }
};
const MAP_TILE_STYLE_DARK = buildCartoStyleUrl("dark-matter-gl-style");
const MAP_TILE_STYLE_LIGHT = buildCartoStyleUrl("positron-gl-style");
const MAP_TILE_STYLE_RASTER: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [
    {
      id: "osm",
      type: "raster",
      source: "osm",
    },
  ],
};
const MAP_TILE_STYLE_DEBUG: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "debug-bg",
      type: "background",
      paint: {
        "background-color": "#7c2d12",
      },
    },
  ],
};
const MAP_STYLE_OPTIONS = [
  { id: "dark", label: "dark-matter", value: MAP_TILE_STYLE_DARK },
  { id: "light", label: "positron", value: MAP_TILE_STYLE_LIGHT },
  { id: "raster", label: "osm-raster", value: MAP_TILE_STYLE_RASTER },
  { id: "debug", label: "debug-bg", value: MAP_TILE_STYLE_DEBUG },
] as const;

const STATION_MARKER_LAYER_ID = "station-markers";
const STATION_MARKER_SELECTED_LAYER_ID = "station-markers-selected";
const STATION_MARKER_HOVER_LAYER_ID = "station-markers-hover";
const TRIP_MARKER_LAYER_ID = "trip-markers";
const TRIP_MARKER_PRIMARY_LAYER_ID = "trip-markers-primary";
const isNonBoardableStopId = (stopId: string | null | undefined) =>
  Boolean(
    stopId &&
      (stopId.startsWith("node-") ||
        stopId.startsWith("entrance-") ||
        stopId.startsWith("door-") ||
        stopId.startsWith("elevator-")),
  );
const TRIP_LABEL_MIN_ZOOM = 11;
const LINE_SEGMENT_GRID_SIZE = 0.01;
const LINE_SELECT_THROTTLE_MS = 200;
const DROPDOWN_FADE_MS = 140;

const useDropdownVisibility = (open: boolean, durationMs = DROPDOWN_FADE_MS) => {
  const [render, setRender] = useState(open);
  const [visible, setVisible] = useState(open);
  const timerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (open) {
      rafRef.current = requestAnimationFrame(() => {
        setRender(true);
        setVisible(true);
        rafRef.current = null;
      });
      return;
    }
    rafRef.current = requestAnimationFrame(() => {
      setVisible(false);
      rafRef.current = null;
    });
    timerRef.current = window.setTimeout(() => {
      setRender(false);
      timerRef.current = null;
    }, durationMs);
  }, [open, durationMs]);

  useEffect(() => {
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
      }
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  return { render, visible };
};


const DEFAULT_POSITION = {
  lat: envConfig.defaultMap.lat,
  lng: envConfig.defaultMap.lng,
};

const FOLLOW_RIBBON_HEIGHT = 240;
const BASE_MAP_PADDING = { top: 40, right: 40, bottom: 40, left: 40 };
const FOLLOW_SAFE_AREA = FOLLOW_RIBBON_HEIGHT + 80;

const RAINBOW_CONIC = "conic-gradient(#DC2626 0deg, #F59E0B 120deg, #10B981 240deg, #DC2626 360deg)";
const RAINBOW_LINE = "linear-gradient(135deg, #DC2626, #F59E0B, #10B981)";
const RAINBOW_SPINNER_STYLE: CSSProperties = {
  background: RAINBOW_CONIC,
  WebkitMask: "radial-gradient(farthest-side, transparent 55%, black 56%)",
  mask: "radial-gradient(farthest-side, transparent 55%, black 56%)",
};
const RAINBOW_OUTLINE_STYLE: CSSProperties = {
  border: "1px solid transparent",
  backgroundImage: `linear-gradient(var(--surface), var(--surface)), ${RAINBOW_LINE}`,
  backgroundOrigin: "border-box",
  backgroundClip: "padding-box, border-box",
};

const SAVED_LOCATIONS_KEY = "linelight:savedLocations";
const RECENT_TRIPS_KEY = "linelight:recentTrips";
const DEVICE_LOCATION_PREF_KEY = "linelight:deviceLocation";
const TRIP_MODE_PREF_KEY = "linelight:tripModeFilters";
type DeviceLocationPreference = "off" | "on";

const generateId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;

interface SavedLocation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  stopId?: string | null;
  lines?: LineOptionId[] | null;
}

interface RecentTrip {
  id: string;
  origin: TripPoint;
  destination: TripPoint;
  lineIds?: string[] | null;
  createdAt: number;
}

type TripLabelKind = "start" | "end" | "transfer" | "walk";
type TripLabelPoint = {
  id: string;
  lat: number;
  lon: number;
  label: string;
  kind: TripLabelKind;
  fromColor?: string;
  toColor?: string;
};

type LocationSearchResult = {
  id: string;
  label: string;
  lat: number;
  lon: number;
};

type MapPickMode = "origin" | "destination" | null;
type MapUiState = {
  tripMode: TripModeState;
  mapPickMode: MapPickMode;
  mapPickLoading: boolean;
  mapPickPulse: boolean;
  mapPickError: string | null;
};

type TripModeFilter = "subway" | "bus" | "commuter_rail";

type MapUiAction =
  | { type: "setTripMode"; mode: TripModeState }
  | { type: "setMapPickMode"; mode: MapPickMode }
  | { type: "setMapPickLoading"; value: boolean }
  | { type: "setMapPickPulse"; value: boolean }
  | { type: "setMapPickError"; value: string | null };

const mapUiReducer = (state: MapUiState, action: MapUiAction): MapUiState => {
  switch (action.type) {
    case "setTripMode":
      return { ...state, tripMode: action.mode };
    case "setMapPickMode":
      return { ...state, mapPickMode: action.mode };
    case "setMapPickLoading":
      return { ...state, mapPickLoading: action.value };
    case "setMapPickPulse":
      return { ...state, mapPickPulse: action.value };
    case "setMapPickError":
      return { ...state, mapPickError: action.value };
    default:
      return state;
  }
};

type StationMarker = {
  markerKey: string;
  markerStopId: string;
  stopId: string;
  platformStopIds: string[];
  name: string;
  latitude: number;
  longitude: number;
  color: string;
  dotStyle?: CSSProperties;
  isSelected: boolean;
  routesServing: string[];
  zIndex: number;
  isBusOnly: boolean;
};

const BusIcon = ({ className, color = "#facc15" }: { className?: string; color?: string }) => (
  <svg
    aria-hidden="true"
    focusable="false"
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    style={{ color }}
  >
    <rect x="5" y="4" width="14" height="12" rx="3" />
    <line x1="5" y1="11" x2="19" y2="11" />
    <line x1="8" y1="7" x2="16" y2="7" />
    <circle cx="10" cy="17" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="14" cy="17" r="1.3" fill="currentColor" stroke="none" />
  </svg>
);

const TrainIcon = ({ className, color = "#f87171" }: { className?: string; color?: string }) => (
  <svg
    aria-hidden="true"
    focusable="false"
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    style={{ color }}
  >
    <rect x="7" y="3" width="10" height="14" rx="3" />
    <line x1="7" y1="12" x2="17" y2="12" />
    <line x1="9" y1="7" x2="15" y2="7" />
    <circle cx="10" cy="18" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="14" cy="18" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

const MODE_OPTIONS = [
  { id: "subway" as TripModeFilter, label: "Subway", icon: TrainIcon },
  { id: "bus" as TripModeFilter, label: "Bus", icon: BusIcon },
  { id: "commuter_rail" as TripModeFilter, label: "Commuter Rail", icon: TrainIcon },
] as const;

const INITIAL_VIEW_STATE: ViewState = {
  latitude: DEFAULT_POSITION.lat,
  longitude: DEFAULT_POSITION.lng,
  zoom: envConfig.defaultMap.zoom,
  bearing: 0,
  pitch: 0,
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
};

const LINE_OPTIONS = [
  { id: "Red", label: "Red" },
  { id: "Orange", label: "Orange" },
  { id: "Blue", label: "Blue" },
  { id: "Green-B", label: "Green B" },
  { id: "Green-C", label: "Green C" },
  { id: "Green-D", label: "Green D" },
  { id: "Green-E", label: "Green E" },
  { id: "Mattapan", label: "Mattapan" },
  { id: "CommuterRail", label: "Commuter Rail" },
] as const;

const SUBWAY_LINE_IDS: LineOptionId[] = [
  "Red",
  "Orange",
  "Blue",
  "Green-B",
  "Green-C",
  "Green-D",
  "Green-E",
  "Mattapan",
];

const LINE_PRIORITY_ORDER: Record<string, number> = {
  Red: 3,
  "Green-B": 2,
  CommuterRail: 2,
  Bus: 1,
};

const getLinePriority = (token: LineToken): number => LINE_PRIORITY_ORDER[token.id] ?? 0;

const buildDotStyle = (colors: string[]): CSSProperties | undefined => {
  const unique = Array.from(new Set(colors));
  if (unique.length <= 1) return undefined;
  const segments = unique
    .map((color, index) => {
      const start = (index / unique.length) * 100;
      const end = ((index + 1) / unique.length) * 100;
      return `${color} ${start}% ${end}%`;
    })
    .join(", ");
  return {
    backgroundColor: unique[0],
    backgroundImage: `conic-gradient(${segments})`,
    backgroundSize: "100% 100%",
  };
};

const logMapDebug = (event: string, details: Record<string, unknown>) => {
  if (typeof window === "undefined") return;
  if (window.localStorage?.getItem("map-debug") !== "1") return;
  void { event, details };
};

const useLocationSearch = (
  query: string,
  center: { lat: number; lon: number } | null,
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null,
  options?: { limit?: number; minLength?: number },
) => {
  const [results, setResults] = useState<LocationSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const cacheRef = useRef<Map<string, { timestamp: number; results: LocationSearchResult[] }>>(new Map());

  useEffect(() => {
    const trimmed = query.trim();
    const minLength = options?.minLength ?? 3;
    const limit = options?.limit ?? 8;
    if (trimmed.length < minLength) {
      setResults([]);
      setIsLoading(false);
      setError(null);
      setHasSearched(false);
      abortRef.current?.abort();
      return;
    }

    const boundsKey = bounds
      ? `${bounds.minLat.toFixed(3)},${bounds.minLon.toFixed(3)},${bounds.maxLat.toFixed(3)},${bounds.maxLon.toFixed(3)}`
      : "none";
    const cacheKey = `${trimmed.toLowerCase()}|${boundsKey}`;
    const cached = cacheRef.current.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 2 * 60_000) {
      setResults(cached.results);
      setIsLoading(false);
      setError(null);
      setHasSearched(true);
      return;
    }

    const cachedPrefixes = Array.from(cacheRef.current.entries())
      .map(([key, value]) => {
        const [cachedQuery, cachedBounds] = key.split("|");
        return { cachedQuery, cachedBounds, results: value.results };
      })
      .filter((entry) => entry.cachedBounds === boundsKey && trimmed.toLowerCase().startsWith(entry.cachedQuery ?? ""))
      .sort((a, b) => (b.cachedQuery?.length ?? 0) - (a.cachedQuery?.length ?? 0));
    if (cachedPrefixes.length > 0) {
      const next = cachedPrefixes[0]?.results ?? [];
      const filtered = next.filter((entry) => entry.label.toLowerCase().includes(trimmed.toLowerCase()));
      if (filtered.length > 0) {
        setResults(filtered);
      }
    }

    setIsLoading(true);
    setError(null);
    setHasSearched(true);
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const timeout = window.setTimeout(async () => {
      try {
        const url = new URL("/api/geocode", envConfig.apiBaseUrl);
        url.searchParams.set("q", trimmed);
        url.searchParams.set("limit", String(limit));
        if (center) {
          url.searchParams.set("centerLat", center.lat.toString());
          url.searchParams.set("centerLon", center.lon.toString());
        }
        if (bounds) {
          url.searchParams.set("minLat", bounds.minLat.toString());
          url.searchParams.set("maxLat", bounds.maxLat.toString());
          url.searchParams.set("minLon", bounds.minLon.toString());
          url.searchParams.set("maxLon", bounds.maxLon.toString());
        }
        const response = await fetch(url.toString(), {
          headers: {
            "Accept-Language": "en-US",
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("Search failed");
        }
        const payload = (await response.json()) as { results: Array<{ id: string; label: string; lat: number; lon: number }> };
        const next: LocationSearchResult[] = (payload.results ?? [])
          .map((entry) => ({
            id: String(entry.id),
            label: entry.label,
            lat: Number(entry.lat),
            lon: Number(entry.lon),
          }))
          .filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lon));
        cacheRef.current.set(cacheKey, { timestamp: Date.now(), results: next });
        setResults(next);
        setIsLoading(false);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setIsLoading(false);
        setError("Location search unavailable");
      }
    }, Math.max(120, Math.min(220, trimmed.length <= 3 ? 150 : 100)));

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [query, center, bounds, options?.limit, options?.minLength]);

  return { results, isLoading, error, hasSearched };
};

const formatMinutes = (value: number | null | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  return `${hours}h ${minutes}m`;
};
const formatMinutesOptional = (value?: number | null) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  return `${hours}h ${minutes}m`;
};
const isTransferLeg = (leg: TripPlannerLeg) => leg.routeId === "__transfer__" || leg.lineId === "__transfer__";
const getLegDisplayMode = (leg: TripPlannerLeg) => (isTransferLeg(leg) ? "walk" : leg.mode);
const getLegLabel = (leg: TripPlannerLeg) => {
  if (isTransferLeg(leg)) return "Transfer";
  if (leg.mode === "walk") return "Walk";
  return leg.routeId ?? (leg.lineId ? leg.lineId.replace("line-", "") : "Line");
};
const getLegTitle = (leg: TripPlannerLeg) => {
  const label = getLegLabel(leg);
  if (isTransferLeg(leg)) return "Transfer walk";
  if (leg.mode === "walk") return "Walk";
  if (leg.mode === "bus") return `Bus ${label}`;
  if (leg.mode === "commuter_rail") return `Commuter Rail ${label}`;
  if (leg.mode === "ferry") return `Ferry ${label}`;
  if (leg.mode === "subway") return `${label} Line`;
  return label;
};
const getLegIcon = (leg: TripPlannerLeg, color: string) => {
  if (isTransferLeg(leg) || leg.mode === "walk") return <FiMap className="h-4 w-4" />;
  if (leg.mode === "bus") return <BusIcon className="h-4 w-4" color={color} />;
  return <TrainIcon className="h-4 w-4" color={color} />;
};
const formatStopLabel = (stop?: { name?: string; label?: string } | null) => stop?.name ?? stop?.label ?? null;
const formatWalkDistanceMiles = (meters?: number | null) => {
  if (typeof meters !== "number" || !Number.isFinite(meters)) return null;
  const miles = meters / 1609.34;
  if (miles < 0.1) return null;
  const decimals = miles < 1 ? 2 : 1;
  return `${miles.toFixed(decimals)} mi`;
};
const MODE_LABELS: Record<TripModeFilter, string> = {
  subway: "Subway",
  bus: "Bus",
  commuter_rail: "Commuter Rail",
};
const formatModeSelection = (modes: TripModeFilter[]) => {
  if (modes.length === 0) return "the selected modes";
  const labels = modes.map((mode) => MODE_LABELS[mode]).filter(Boolean);
  if (labels.length === 1) return `${labels[0]} only`;
  if (labels.length === 2) return `${labels[0]} + ${labels[1]}`;
  return labels.join(", ");
};
const buildNoRouteMessage = (modes: TripModeFilter[]) => {
  const selection = formatModeSelection(modes);
  const missing = (Object.keys(MODE_LABELS) as TripModeFilter[]).filter((mode) => !modes.includes(mode));
  const missingLabels = missing.map((mode) => MODE_LABELS[mode]).filter(Boolean);
  const addSuggestion = missingLabels.length > 0
    ? `Try adding ${missingLabels.join(" or ")} or adjust your start/end.`
    : "Try adjusting your start/end or choosing closer points.";
  return `No route found with ${selection}. ${addSuggestion}`;
};

// Reusable map annotation component (simple Marker wrapper).
const MapAnnotation = ({
  latitude,
  longitude,
  label,
  colors,
  onClose,
}: {
  latitude: number;
  longitude: number;
  label: string;
  colors?: string[];
  onClose?: () => void;
}) => {
  const backgroundStyle: CSSProperties = colors && colors.length > 1 ? buildDotStyle(colors) ?? {} : { background: colors?.[0] ?? "var(--card)" };
  return (
    <Marker latitude={latitude} longitude={longitude}>
      <div style={{ transform: "translate(-50%, -130%)" }}>
        <div
          className="rounded-full px-3 py-1 text-sm font-semibold shadow-md"
          style={{
            color: "var(--foreground)",
            border: "1px solid color-mix(in srgb, var(--border-strong) 70%, transparent)",
            boxShadow: "0 6px 14px rgba(15, 23, 42, 0.16)",
            ...backgroundStyle,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ whiteSpace: "nowrap" }}>{label}</span>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="ml-2 rounded-full p-1"
              style={{ background: "rgba(0,0,0,0.08)", color: "var(--foreground)" }}
              aria-label="Close annotation"
            >
              ×
            </button>
          )}
        </div>
      </div>
    </Marker>
  );
};

type LineOptionId = (typeof LINE_OPTIONS)[number]["id"];
const GREEN_LINE_GROUP: LineOptionId[] = ["Green-B", "Green-C", "Green-D", "Green-E"];

const canonicalizeLineKey = (value?: string | null) =>
  value?.toLowerCase().replace(/line/g, "").replace(/[^a-z0-9]/g, "") ?? "";

const candidateMatchesLineId = (candidate: string | null | undefined, lineId: LineOptionId) => {
  if (!candidate) return false;
  if (lineId === "CommuterRail") {
    return /^CR-/i.test(candidate) || candidate.toLowerCase().includes("commuter");
  }
  const normalizedCandidate = canonicalizeLineKey(candidate);
  const normalizedLine = canonicalizeLineKey(lineId);
  if (!normalizedCandidate || !normalizedLine) return false;
  return (
    normalizedCandidate === normalizedLine ||
    normalizedCandidate.startsWith(normalizedLine) ||
    normalizedLine.startsWith(normalizedCandidate)
  );
};

const routeMatchesLine = (route: HomeStopSummary["routes"][number], lineId: LineOptionId) =>
  candidateMatchesLineId(route.routeId, lineId) || candidateMatchesLineId(route.shortName, lineId);

const routeLooksLikeBus = (routeId?: string | null) => {
  if (!routeId) return false;
  return /^\d/.test(routeId) || routeId.toLowerCase().includes("bus");
};

const stopSupportsSelectedLines = (stop: HomeStopSummary, selectedLines: LineOptionId[]) => {
  if (selectedLines.length === 0) return true;
  return stop.routes.some((route) => selectedLines.some((lineId) => routeMatchesLine(route, lineId)));
};

const stationSupportsSelectedLines = (routes: string[], selectedLines: LineOptionId[]) => {
  if (selectedLines.length === 0) return true;
  return routes.some((routeId) => selectedLines.some((lineId) => candidateMatchesLineId(routeId, lineId)));
};

const isLineOptionId = (id: string): id is LineOptionId => LINE_OPTIONS.some((line) => line.id === id);
const toLineOptionIds = (ids?: string[]) => (ids ?? []).filter(isLineOptionId);
type LineShapeWithId = LineShapeResponse & { id: LineOptionId };

const decodePolyline = (encoded: string): [number, number][] => {
  let index = 0;
  let lat = 0;
  let lon = 0;
  const coordinates: [number, number][] = [];

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const deltaLon = result & 1 ? ~(result >> 1) : result >> 1;
    lon += deltaLon;

    coordinates.push([lon / 1e5, lat / 1e5]);
  }

  return coordinates;
};

const formatDistance = (meters: number | null | undefined): string => {
  if (meters == null) return "";
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)} km`;
  }
  return `${Math.round(meters)} m`;
};

const toRadians = (value: number): number => (value * Math.PI) / 180;

const metersBetween = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const earthRadius = 6_371_000;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
};

const approxPointToSegmentDistance = (
  point: { lat: number; lng: number },
  start: { lat: number; lng: number },
  end: { lat: number; lng: number },
): number => {
  let min = Infinity;
  const samples = 5;
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const lat = start.lat + (end.lat - start.lat) * t;
    const lng = start.lng + (end.lng - start.lng) * t;
    const distance = metersBetween(point.lat, point.lng, lat, lng);
    if (distance < min) {
      min = distance;
    }
  }
  return min;
};

const SectionDivider = () => <div className="mt-5 h-px w-full" style={{ background: "var(--border)" }} />;

const SectionHeader = ({ icon, title, action }: { icon: ReactNode; title: string; action?: ReactNode }) => (
  <div className="flex items-center justify-between gap-2">
    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.35em]" style={{ color: "var(--muted)" }}>
      <span className="text-base">{icon}</span>
      <span>{title}</span>
    </div>
    {action}
  </div>
);

const StopSummaryCard = ({
  stop,
  isFavorite,
  onToggleFavorite,
  onSelectStop,
  selected,
  isRefreshing = false,
}: {
  stop: HomeStopSummary;
  isFavorite: boolean;
  onToggleFavorite: (stopId: string) => void;
  onSelectStop: (stopId: string, meta: { name: string; lineIds: string[]; platformStopIds?: string[] }) => void;
  selected: boolean;
  isRefreshing?: boolean;
}) => {
  const { mode: themeMode } = useThemeMode();
  const routeGroupMap = new Map<string, { routeId: string; shortName: string; directions: HomeStopSummary["routes"] }>();
  stop.routes.forEach((route) => {
    const entry = routeGroupMap.get(route.routeId);
    if (entry) {
      entry.directions.push(route);
    } else {
      routeGroupMap.set(route.routeId, { routeId: route.routeId, shortName: route.shortName, directions: [route] });
    }
  });
  const routeGroups = Array.from(routeGroupMap.values());
  const stopHue = useMemo(
    () => getStopHue(routeGroups.map((group) => group.routeId), themeMode),
    [routeGroups, themeMode],
  );

  const cleanDestination = (text?: string | null) => {
    if (!text) return null;
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;
    return trimmed;
  };

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border px-3 py-3 transition ${
        selected ? "ring-2 ring-cyan-300/40" : ""
      }`}
      data-stop-card={stop.stopId}
      style={{
        background: stopHue.background,
        borderColor: selected ? "rgba(14,165,233,0.65)" : stopHue.borderColor,
      }}
    >
      <div className="relative z-10">
        <button
          type="button"
          className={`focus-outline absolute right-2 top-2 rounded-full text-xl ${
            isFavorite ? "text-amber-400" : "text-slate-400/80"
          }`}
          onClick={(evt) => {
            evt.stopPropagation();
            onToggleFavorite(stop.stopId);
          }}
          aria-label={isFavorite ? "Remove favorite" : "Add favorite"}
          aria-pressed={isFavorite}
          title={isFavorite ? "Favorited" : "Favorite this stop"}
          style={{ filter: isFavorite ? "drop-shadow(0 6px 16px rgba(251,191,36,0.45))" : undefined }}
        >
          {isFavorite ? <FaStar /> : <FiStar />}
        </button>
        <button
          type="button"
          className="focus-outline w-full text-left"
          onClick={() =>
            onSelectStop(stop.stopId, {
              name: stop.name,
              lineIds: stop.routes.map((route) => route.routeId),
              platformStopIds: stop.platformStopIds,
            })
          }
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-base font-semibold truncate">{stop.name}</p>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                {formatDistance(stop.distanceMeters)} away
              </p>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {routeGroups.map((group) => {
              const lineToken = getLineToken(group.routeId, themeMode);
              const directionEntry = group.directions[0];
              const destinationLabel = cleanDestination(
                directionEntry.destination ?? directionEntry.direction,
              );
              const directionToken = getDirectionToken(
                directionEntry.directionId,
                directionEntry.direction,
                themeMode,
              );
              const eta =
                directionEntry.nextTimes.find((eta) => Number.isFinite(eta?.etaMinutes ?? NaN)) ??
                directionEntry.nextTimes[0] ??
                null;
              const hasEta = Number.isFinite(eta?.etaMinutes ?? NaN);
              const showEtaLoading = isRefreshing || !hasEta;
              return (
                <div
                  key={`${stop.stopId}-${group.routeId}`}
                  className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm font-semibold"
                  style={{
                    background: lineToken.tint,
                    borderColor: lineToken.border,
                    color: lineToken.textOnTint,
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-flex h-2.5 w-2.5 rounded-full"
                      style={{ background: lineToken.color }}
                    />
                    <span>{group.shortName ?? group.routeId}</span>
                    {destinationLabel && (
                      <span className="text-[11px] uppercase tracking-[0.35em]" style={{ color: "var(--muted)" }}>
                        {destinationLabel}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[11px]" style={{ color: "var(--foreground)" }}>
                    <DirectionArrowIcon token={directionToken} size="sm" />
                    {showEtaLoading ? (
                      <div className="h-4 w-12 animate-pulse rounded bg-white/40" />
                    ) : (
                      <span className="font-semibold">{formatEtaChip(eta?.etaMinutes ?? null)}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </button>
      </div>
    </div>
  );
};

export const HomeShell = () => <HomeShellContent />;

  const HomePanels = ({
    favorites,
    nearby,
    searchResults,
    addressResults,
    addressLoading,
    addressError,
    isFetching,
    error,
    favoriteIds,
    onToggleFavorite,
    onSelectStop,
    onSelectAddress,
    selectedStopId,
    favoritesFilteredOut,
    nearbyFilteredOut,
    searchActive,
    searchQuery,
    stationsLoading,
    isCompactLayout,
  }: {
    favorites: HomeStopSummary[];
    nearby: HomeStopSummary[];
    searchResults: HomeStopSummary[];
    addressResults: LocationSearchResult[];
    addressLoading: boolean;
    addressError: string | null;
    isFetching: boolean;
    error: Error | null;
    favoriteIds: string[];
    onToggleFavorite: (stopId: string) => void;
    onSelectStop: (stopId: string, meta: { name: string; lineIds: string[]; platformStopIds?: string[] }) => void;
    onSelectAddress: (result: LocationSearchResult) => void;
    selectedStopId: string | null;
    favoritesFilteredOut: boolean;
    nearbyFilteredOut: boolean;
    searchActive: boolean;
    searchQuery: string;
    stationsLoading: boolean;
    isCompactLayout: boolean;
  }) => {
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const filteredSearchResults = useMemo(() => {
    if (!searchActive || normalizedSearchQuery.length < 2) return [];
    return searchResults.filter((stop) => stop.name.toLowerCase().includes(normalizedSearchQuery));
  }, [normalizedSearchQuery, searchActive, searchResults]);
  const [favoritesExpanded, setFavoritesExpanded] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(!isCompactLayout);
  const [nearbyOpen, setNearbyOpen] = useState(!isCompactLayout);
  const searchCap = isCompactLayout ? 6 : 10;
  const searchToShow = filteredSearchResults.slice(0, searchCap);
  const addressToShow = addressResults.slice(0, searchCap);
	  const favoritesToShow = favoritesExpanded ? favorites : favorites.slice(0, 3);
    const nearbyCap = isCompactLayout ? 6 : 8;
	  const nearbyToShow = nearby.slice(0, nearbyCap);
	  const showingSuggestedNearby = useMemo(() => {
	    if (nearby.length === 0) return false;
	    const minDistance = nearby.reduce((best, stop) => Math.min(best, stop.distanceMeters), Number.POSITIVE_INFINITY);
	    return Number.isFinite(minDistance) && minDistance > 50_000;
	  }, [nearby]);
	  useEffect(() => {
	    if (!selectedStopId) return;
	    const card = document.querySelector<HTMLElement>(`[data-stop-card="${selectedStopId}"]`);
	    if (!card) return;
	    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("ring-4", "ring-cyan-300");
    const timeout = window.setTimeout(() => {
      card.classList.remove("ring-4", "ring-cyan-300");
    }, 1500);
    return () => window.clearTimeout(timeout);
  }, [selectedStopId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFavoritesOpen(!isCompactLayout);
    setNearbyOpen(!isCompactLayout);
  }, [isCompactLayout]);

  const showFavoritesSection = favoriteIds.length > 0 || favoritesFilteredOut;

  return (
    <div className={isCompactLayout ? "space-y-4" : "space-y-6"}>
      {searchActive && (
        <section>
          <SectionHeader icon={<FiSearch />} title="All stops" />
          <SectionDivider />
          <div className="mt-3 space-y-3">
            {stationsLoading ? (
              <div className="text-sm" style={{ color: "var(--muted)" }}>
                Searching stops…
              </div>
            ) : searchToShow.length === 0 ? (
              <div className="text-sm" style={{ color: "var(--muted)" }}>
                No stops match &ldquo;{searchQuery}&rdquo;.
              </div>
            ) : (
              searchToShow.map((stop) => (
                <StopSummaryCard
                  key={`search-${stop.stopId}`}
                  stop={stop}
                  isFavorite={favoriteIds.includes(stop.stopId)}
                  onToggleFavorite={onToggleFavorite}
                  onSelectStop={onSelectStop}
                  selected={stop.stopId === selectedStopId}
                  isRefreshing={isFetching}
                />
              ))
            )}
          </div>
          <div className="mt-4">
            <SectionHeader icon={<FiMapPin />} title="Addresses" />
            <SectionDivider />
            <div className="mt-3 space-y-3">
              {addressLoading ? (
                <div className="text-sm" style={{ color: "var(--muted)" }}>
                  Searching addresses…
                </div>
              ) : addressError ? (
                <div className="text-sm" style={{ color: "var(--muted)" }}>
                  Address search is unavailable right now.
                </div>
              ) : addressToShow.length === 0 ? (
                <div className="text-sm" style={{ color: "var(--muted)" }}>
                  No addresses match &ldquo;{searchQuery}&rdquo;.
                </div>
              ) : (
                addressToShow.map((result) => (
                  <button
                    key={`address-${result.id}`}
                    type="button"
                    className="search-dropdown-item flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left"
                    data-interactive="ghost"
                    style={{ borderColor: "var(--border)" }}
                    onClick={() => onSelectAddress(result)}
                  >
                    <div>
                      <div className="text-sm font-semibold" style={{ color: "var(--foreground)" }}>
                        {result.label}
                      </div>
                      <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                        {result.lat.toFixed(5)}, {result.lon.toFixed(5)}
                      </div>
                    </div>
                    <FiMapPin className="text-(--muted)" />
                  </button>
                ))
              )}
            </div>
          </div>
        </section>
      )}
      {showFavoritesSection && (
        <section>
          {isCompactLayout ? (
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left"
              style={{ borderColor: "var(--border)" }}
              onClick={() => setFavoritesOpen((prev) => !prev)}
              aria-expanded={favoritesOpen}
            >
              <div className="flex items-center gap-3">
                <FiStar />
                <span className="font-semibold">
                  Favorites {favorites.length > 0 ? `• ${favorites.length}` : ""}
                </span>
              </div>
              <FiChevronDown className={`transition ${favoritesOpen ? "rotate-180" : ""}`} />
            </button>
          ) : (
            <>
              <SectionHeader
                icon={<FiStar />}
                title="Favorites"
                action={
                  favorites.length > 3 && (
                    <button
                      type="button"
                      className="btn btn-ghost touch-target px-3 py-1 text-[11px]"
                      data-interactive="ghost"
                      onClick={() => setFavoritesExpanded((prev) => !prev)}
                    >
                      {favoritesExpanded ? "Show fewer" : `Show all (${favorites.length})`}
                    </button>
                  )
                }
              />
              <SectionDivider />
            </>
          )}
          <div
            className={`${isCompactLayout ? "mt-2" : "mt-3"} space-y-3 transition-[max-height,opacity] duration-200 ${
              favoritesOpen ? "max-h-[1200px] opacity-100" : "max-h-0 opacity-0"
            } ${favoritesOpen ? "" : "pointer-events-none"}`}
          >
            {error ? (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                We couldn&apos;t load your favorites just now.
              </p>
            ) : favorites.length === 0 ? (
              favoritesFilteredOut ? (
                <p className="text-sm" style={{ color: "var(--muted)" }}>
                  No favorites match your filters. Clear the chips above the map to see them again.
                </p>
              ) : null
            ) : (
              favoritesToShow.map((stop) => (
        <StopSummaryCard
          key={`fav-${stop.stopId}`}
          stop={stop}
          isFavorite
          onToggleFavorite={onToggleFavorite}
          onSelectStop={onSelectStop}
          selected={stop.stopId === selectedStopId}
          isRefreshing={isFetching}
        />
              ))
            )}
          </div>
        </section>
      )}
      <section>
        {!isCompactLayout && (
          <>
            <SectionHeader icon={<FiMapPin />} title="Nearby" />
            <SectionDivider />
          </>
        )}
	        <div
	          className={`${isCompactLayout ? "mt-2" : "mt-3"} space-y-3 transition-[max-height,opacity] duration-200 ${
	            isCompactLayout || nearbyOpen ? "max-h-[1200px] opacity-100" : "max-h-0 opacity-0"
	          } ${isCompactLayout || nearbyOpen ? "" : "pointer-events-none"}`}
	        >
	          {nearby.length > 0 && showingSuggestedNearby && (
	            <p className="text-sm" style={{ color: "var(--muted)" }}>
	              You&apos;re far from MBTA service — showing suggested hubs.
	            </p>
	          )}
	          {error ? (
	            <p className="text-sm" style={{ color: "var(--muted)" }}>
	              Nearby stops failed to load. Please try again.
	            </p>
          ) : nearby.length === 0 ? (
            nearbyFilteredOut ? (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                Your filters hide nearby stops. Reset them to see everything around you.
              </p>
            ) : isFetching ? (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                Loading nearby stops…
              </p>
            ) : (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                No nearby stops detected.
              </p>
            )
          ) : (
            nearbyToShow.map((stop) => (
        <StopSummaryCard
          key={stop.stopId}
          stop={stop}
          isFavorite={favoriteIds.includes(stop.stopId)}
          onToggleFavorite={onToggleFavorite}
          onSelectStop={onSelectStop}
          selected={stop.stopId === selectedStopId}
          isRefreshing={isFetching}
        />
            ))
          )}
        </div>
      </section>
    </div>
  );
};

const HomeShellContent = () => {
  const searchParams = useSearchParams();
  const router = useRouter();
  const perfRenderStartRef = useRef<number | null>(null);
  const perfRenderCountRef = useRef(0);
  if (typeof window !== "undefined") {
    perfRenderStartRef.current = performance.now();
  }
  const mapRef = useRef<MapRef | null>(null);
  const viewStateRef = useRef<ViewState>({ ...INITIAL_VIEW_STATE });
  const preferStopZoomRef = useRef<boolean>(false);
  const prevSelectedLinesRef = useRef<LineOptionId[] | null>(null);
  const lastStopRouteFocusRef = useRef<string | null>(null);
  const lastSelectedStopCoordsRef = useRef<{ lat: number; lng: number } | null>(null);
  const userMapInteractedRef = useRef<boolean>(false);
  const lastLineSelectAtRef = useRef<number>(0);
  const hoverRafRef = useRef<number | null>(null);
  const hoveredMarkerPendingRef = useRef<string | null>(null);
  const originAutoSetRef = useRef<boolean>(false);
  const deepLinkAppliedRef = useRef(false);
  const deepLinkSegmentAppliedRef = useRef(false);
  const suggestedHubsFocusAppliedRef = useRef(false);
  const mapViewBeforeSheetRef = useRef<{
    center: [number, number];
    zoom: number;
    bearing: number;
    pitch: number;
  } | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapStyleId, setMapStyleId] = useState<(typeof MAP_STYLE_OPTIONS)[number]["id"]>("dark");
  const [isClient, setIsClient] = useState(false);
  const mapSectionRef = useRef<HTMLDivElement | null>(null);
  const followPanelRef = useRef<HTMLDivElement | null>(null);
  const tripTimelineRef = useRef<HTMLDivElement | null>(null);
  const [viewState, setViewState] = useState<ViewState>(() => ({
    ...INITIAL_VIEW_STATE,
  }));
  const lineShapeLayerIdsRef = useRef<{ sourceId: string; layerId: string }>({
    sourceId: "line-shapes",
    layerId: "line-shapes-layer",
  });
  const tripLineLayerIdsRef = useRef<{ sourceId: string; layerId: string }>({
    sourceId: "trip-lines",
    layerId: "trip-lines-layer",
  });
  const [position, setPosition] = useState(DEFAULT_POSITION);
  const [deviceLocationPref, setDeviceLocationPref] = useState<DeviceLocationPreference>("off");
  const [geoPermissionState, setGeoPermissionState] = useState<PermissionState | "unknown">("unknown");
  const [isDeviceLocationModalOpen, setIsDeviceLocationModalOpen] = useState(false);
  const mapStyleOption = useMemo(() => MAP_STYLE_OPTIONS.find((opt) => opt.id === mapStyleId) ?? MAP_STYLE_OPTIONS[0], [mapStyleId]);



  const [mapUiState, dispatchMapUi] = useReducer(mapUiReducer, {
    tripMode: "HOME" as TripModeState,
    mapPickMode: null,
    mapPickLoading: false,
    mapPickPulse: false,
    mapPickError: null,
  });
  const createEmptyTripPlanView = useCallback(
    (): TripPlannerViewModel => ({
      origin: null,
      destination: null,
      activeTripId: null,
      plans: [],
      summary: null,
      warnings: [],
    }),
    [],
  );
  const tripMode = mapUiState.tripMode;
  const [tripPlanView, setTripPlanView] = useState<TripPlannerViewModel>(createEmptyTripPlanView);
  const originWasManualRef = useRef(false);
  const lastPlannedKeyRef = useRef<string | null>(null);
  const mapPickMode = mapUiState.mapPickMode;
  const mapPickLoading = mapUiState.mapPickLoading;
  const mapPickPulse = mapUiState.mapPickPulse;
  const mapPickError = mapUiState.mapPickError;
  const [showFiltersPanel, setShowFiltersPanel] = useState(true);
  const originInputRef = useRef<HTMLInputElement | null>(null);
  const destinationInputRef = useRef<HTMLInputElement | null>(null);
  const originFieldRef = useRef<HTMLDivElement | null>(null);
  const destinationFieldRef = useRef<HTMLDivElement | null>(null);
  const [tripPlanError, setTripPlanError] = useState<string | null>(null);
  const [tripPlanNotice, setTripPlanNotice] = useState<string | null>(null);
  const [tripOriginInput, setTripOriginInput] = useState("");
  const [tripDestinationInput, setTripDestinationInput] = useState("");
  const [tripFocusedField, setTripFocusedField] = useState<"origin" | "destination" | null>(null);
  const originDropdown = useDropdownVisibility(tripFocusedField === "origin");
  const destinationDropdown = useDropdownVisibility(tripFocusedField === "destination");
  const [tripModeFilters, setTripModeFilters] = useState<TripModeFilter[]>([
    "subway",
    "bus",
    "commuter_rail",
  ]);
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
  const modeDropdown = useDropdownVisibility(modeDropdownOpen);

  useEffect(() => {
    logMapDebug("map-debug:enabled", { href: window.location.href });
  }, []);

  useEffect(() => {
    return () => {
      if (hoverRafRef.current != null) {
        cancelAnimationFrame(hoverRafRef.current);
      }
    };
  }, []);

  const scheduleHoverUpdate = useCallback((nextId: string | null) => {
    hoveredMarkerPendingRef.current = nextId;
    if (hoverRafRef.current != null) return;
    hoverRafRef.current = requestAnimationFrame(() => {
      hoverRafRef.current = null;
      const pending = hoveredMarkerPendingRef.current;
      setHoveredMarkerId((prev) => (prev === pending ? prev : pending));
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage?.getItem("perf-debug") !== "1") return;
    const start = perfRenderStartRef.current;
    perfRenderCountRef.current += 1;
    if (!start) return;
    requestAnimationFrame(() => {
      void (performance.now() - start);
    });
  });
  const setTripMode = useCallback((mode: TripModeState) => dispatchMapUi({ type: "setTripMode", mode }), []);
  const requestTripEditing = useCallback(
    (nextOrigin: TripPoint | null, nextDestination: TripPoint | null) => {
      if (tripMode !== "HOME") {
        setTripMode("TRIP_EDITING");
        return;
      }
      if (nextOrigin && nextDestination) {
        setTripMode("TRIP_EDITING");
      }
    },
    [setTripMode, tripMode],
  );
  const setMapPickMode = useCallback((mode: MapPickMode) => dispatchMapUi({ type: "setMapPickMode", mode }), []);
  const setMapPickLoading = useCallback((value: boolean) => dispatchMapUi({ type: "setMapPickLoading", value }), []);
  const setMapPickPulse = useCallback((value: boolean) => dispatchMapUi({ type: "setMapPickPulse", value }), []);
  const setMapPickError = useCallback((value: string | null) => dispatchMapUi({ type: "setMapPickError", value }), []);
  const [deviceLocationError, setDeviceLocationError] = useState<string | null>(null);
  const [isRequestingDeviceLocation, setIsRequestingDeviceLocation] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [favoriteIdsLoaded, setFavoriteIdsLoaded] = useState(false);
  const { selectedStopId, setSelectedStopId, isStopSheetOpen, setIsStopSheetOpen } = useAppState();
  const [selectedPlatformStopIds, setSelectedPlatformStopIds] = useState<string[] | null>(null);
  const { mode: themeMode } = useThemeMode();
  const [activeTripId, setActiveTripId] = useState<string | null>(null);

  useEffect(() => {
    if (themeMode === "light" && mapStyleId === "dark") {
      setMapStyleId("light");
    }
    if (themeMode === "dark" && mapStyleId === "light") {
      setMapStyleId("dark");
    }
  }, [mapStyleId, themeMode]);
  const isFollowingTrip = Boolean(activeTripId);
  const isTripPlanning = tripMode === "TRIP_PLANNING";
  const tripPlanAbortRef = useRef<AbortController | null>(null);
  const mapUiMode = useMapUiMode({
    tripMode,
    mapPickMode,
    isFollowingTrip,
    isStopSheetOpen,
  });
  const [selectedLines, setSelectedLines] = useState<LineOptionId[]>([]);
  const [hasCenteredMap, setHasCenteredMap] = useState(false);
  const [selectedStopName, setSelectedStopName] = useState<string | null>(null);
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null);
  const [hoveredSavedLocationId, setHoveredSavedLocationId] = useState<string | null>(null);
  const [stopSearch, setStopSearch] = useState("");
  const [followStartError, setFollowStartError] = useState<string | null>(null);
  const [followStartLoading, setFollowStartLoading] = useState(false);
  const breakpointInfo = useBreakpoint();
  const { isDesktop } = breakpointInfo;
  const { isMobile } = breakpointInfo;
  useEffect(() => {
    setShowFiltersPanel(true);
    setShowSavedLocationsPanel(isDesktop);
  }, [isDesktop]);
  const getMapPadding = useCallback(
    (following: boolean) => {
      const base = !isDesktop
        ? { top: 24, right: 24, bottom: 24, left: 24 }
        : BASE_MAP_PADDING;
      const followPad = following ? FOLLOW_SAFE_AREA / 2 : 0;
      return {
        top: base.top + followPad,
        bottom: base.bottom + followPad,
        left: base.left,
        right: base.right,
      };
    },
    [isDesktop],
  );
  const layoutBreakpoint = breakpointClass(breakpointInfo);
  const [savedLocations, setSavedLocations] = useState<SavedLocation[]>([]);
  const [savedLocationsLoaded, setSavedLocationsLoaded] = useState(false);
  const [recentTrips, setRecentTrips] = useState<RecentTrip[]>([]);
  const [recentTripsLoaded, setRecentTripsLoaded] = useState(false);
  const [showRecentTrips, setShowRecentTrips] = useState(false);
  const [isSavingLocation, setIsSavingLocation] = useState(false);
  const [newLocationName, setNewLocationName] = useState("");
  const [newLocationIncludeLines, setNewLocationIncludeLines] = useState(false);
  const [editingLocationId, setEditingLocationId] = useState<string | null>(null);
  const [editingLocationValue, setEditingLocationValue] = useState("");
  const [showSavedLocationsPanel, setShowSavedLocationsPanel] = useState(true);
  const [isTripTimelineOpen, setIsTripTimelineOpen] = useState(true);
  const [mobileFocusMode, setMobileFocusMode] = useState<"map" | "details">("details");
  const [followResumeContext, setFollowResumeContext] = useState<{
    stopId: string | null;
    name: string | null;
    platformStopIds: string[] | null;
  } | null>(null);
  const lastVehicleLocationRef = useRef<{ lat: number; lng: number } | null>(null);
  const followPanelTokens = useMemo(() => {
    if (themeMode === "dark") {
      return {
        background: "rgba(10,17,30,0.92)",
        border: "rgba(94,234,212,0.3)",
        text: "#f8fafc",
        subtext: "rgba(203,213,225,0.9)",
        card: "rgba(13,22,38,0.85)",
        cardBorder: "rgba(148,163,184,0.25)",
        cardAccent: "linear-gradient(135deg, rgba(14,165,233,0.3), rgba(59,130,246,0.1))",
        cardAccentBorder: "rgba(125,211,252,0.7)",
        cardShadow: "0 18px 32px rgba(7,25,43,0.45)",
        cardShadowMuted: "0 12px 24px rgba(2,6,23,0.45)",
        stopName: "#e2e8f0",
        etaText: "#f8fafc",
        etaSubtext: "rgba(148,163,184,0.85)",
        nextIconBackground: "rgba(56,189,248,0.25)",
        nextIconBorder: "rgba(14,165,233,0.65)",
        nextIconColor: "#fdfdfd",
      };
    }
    return {
      background: "rgba(255,255,255,0.95)",
      border: "rgba(148,163,184,0.4)",
      text: "#0f172a",
      subtext: "rgba(71,85,105,0.9)",
      card: "rgba(248,250,252,0.95)",
      cardBorder: "rgba(148,163,184,0.4)",
      cardAccent: "linear-gradient(135deg, rgba(14,165,233,0.18), rgba(248,250,252,1))",
      cardAccentBorder: "rgba(59,130,246,0.45)",
      cardShadow: "0 14px 26px rgba(14,116,144,0.18)",
      cardShadowMuted: "0 10px 20px rgba(15,23,42,0.12)",
      stopName: "#0f172a",
      etaText: "#0f172a",
      etaSubtext: "rgba(71,85,105,0.85)",
      nextIconBackground: "rgba(14,165,233,0.2)",
      nextIconBorder: "rgba(14,165,233,0.45)",
      nextIconColor: "#0369a1",
    };
  }, [themeMode]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(DEVICE_LOCATION_PREF_KEY);
      if (stored === "on" || stored === "off") {
        setDeviceLocationPref(stored);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(DEVICE_LOCATION_PREF_KEY, deviceLocationPref);
    } catch {
      // ignore
    }
  }, [deviceLocationPref]);

  useEffect(() => {
    if (!("permissions" in navigator) || typeof navigator.permissions?.query !== "function") {
      setGeoPermissionState("unknown");
      return;
    }

    let permissionStatus: PermissionStatus | null = null;
    const handleChange = () => {
      if (!permissionStatus) return;
      setGeoPermissionState(permissionStatus.state);
    };

    navigator.permissions
      .query({ name: "geolocation" as PermissionName })
      .then((status) => {
        permissionStatus = status;
        setGeoPermissionState(status.state);
        status.addEventListener("change", handleChange);
      })
      .catch(() => {
        setGeoPermissionState("unknown");
      });

    return () => {
      permissionStatus?.removeEventListener("change", handleChange);
    };
  }, []);

  useEffect(() => {
    if (deepLinkAppliedRef.current) return;
    if (selectedLines.length > 0) return;

    const raw = searchParams.get("line") ?? searchParams.get("lineId");
    if (!raw) return;
    const normalized = raw.trim();
    if (!normalized) return;

    const lower = normalized.toLowerCase();
    if (lower.includes("green") && !normalized.includes("-")) {
      setSelectedLines(GREEN_LINE_GROUP);
      deepLinkAppliedRef.current = true;
      return;
    }

    const matched =
      (isLineOptionId(normalized) ? normalized : null) ??
      LINE_OPTIONS.find((line) => candidateMatchesLineId(normalized, line.id))?.id ??
      null;

    if (matched) {
      setSelectedLines([matched]);
      deepLinkAppliedRef.current = true;
    }
  }, [searchParams, selectedLines.length, setSelectedLines]);
  const stopSheetBackdropRef = useRef<HTMLDivElement | null>(null);
  const stopSheetSafeRefs = useMemo(
    () => [followPanelRef, stopSheetBackdropRef],
    [followPanelRef, stopSheetBackdropRef],
  );
  const stopSheetRootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("linelight:favorites");
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        setFavoriteIds(parsed.filter((id): id is string => typeof id === "string"));
      }
    } catch {
      // ignore
    } finally {
      setFavoriteIdsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!favoriteIdsLoaded) return;
    try {
      window.localStorage.setItem("linelight:favorites", JSON.stringify(favoriteIds));
    } catch {
      // ignore
    }
  }, [favoriteIds, favoriteIdsLoaded]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SAVED_LOCATIONS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const cleaned: SavedLocation[] = [];
      parsed.forEach((entry) => {
        if (!entry || typeof entry !== "object") return;
        if (typeof entry.lat !== "number" || typeof entry.lng !== "number") return;
        cleaned.push({
          id: typeof entry.id === "string" ? entry.id : generateId(),
          name: typeof entry.name === "string" ? entry.name : "Saved location",
          lat: entry.lat,
          lng: entry.lng,
          stopId: typeof entry.stopId === "string" ? entry.stopId : null,
          lines: Array.isArray(entry.lines) ? toLineOptionIds(entry.lines) : null,
        });
      });
      setSavedLocations(cleaned);
    } catch {
      // ignore
    } finally {
      setSavedLocationsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!savedLocationsLoaded) return;
    try {
      window.localStorage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify(savedLocations));
    } catch {
      // ignore
    }
  }, [savedLocations, savedLocationsLoaded]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RECENT_TRIPS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const cleaned: RecentTrip[] = [];
      parsed.forEach((entry) => {
        if (!entry || typeof entry !== "object") return;
        if (!entry.origin || !entry.destination) return;
        if (typeof entry.origin.lat !== "number" || typeof entry.origin.lon !== "number") return;
        if (typeof entry.destination.lat !== "number" || typeof entry.destination.lon !== "number") return;
        const lineIds = Array.isArray((entry as { lineIds?: unknown }).lineIds)
          ? ((entry as { lineIds: string[] }).lineIds || []).filter((lineId) => typeof lineId === "string")
          : null;
        cleaned.push({
          id: typeof entry.id === "string" ? entry.id : generateId(),
          origin: {
            label: typeof entry.origin.label === "string" ? entry.origin.label : "Start",
            lat: entry.origin.lat,
            lon: entry.origin.lon,
            stopId: typeof entry.origin.stopId === "string" ? entry.origin.stopId : null,
          },
          destination: {
            label: typeof entry.destination.label === "string" ? entry.destination.label : "Destination",
            lat: entry.destination.lat,
            lon: entry.destination.lon,
            stopId: typeof entry.destination.stopId === "string" ? entry.destination.stopId : null,
          },
          lineIds: lineIds && lineIds.length > 0 ? lineIds : null,
          createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
        });
      });
      setRecentTrips(cleaned.slice(0, 6));
    } catch {
      // ignore
    } finally {
      setRecentTripsLoaded(true);
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(TRIP_MODE_PREF_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const cleaned = parsed.filter(
        (entry): entry is TripModeFilter => entry === "subway" || entry === "bus" || entry === "commuter_rail",
      );
      if (cleaned.length > 0) {
        setTripModeFilters(Array.from(new Set(cleaned)));
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(TRIP_MODE_PREF_KEY, JSON.stringify(tripModeFilters));
    } catch {
      // ignore
    }
  }, [tripModeFilters]);

  useEffect(() => {
    if (!recentTripsLoaded) return;
    try {
      window.localStorage.setItem(RECENT_TRIPS_KEY, JSON.stringify(recentTrips));
    } catch {
      // ignore
    }
  }, [recentTrips, recentTripsLoaded]);

  const activeModeFilters = useMemo(() => {
    const modeSet = new Set(tripModeFilters);
    if (modeSet.size === 0) {
      return new Set<TripModeFilter>(["subway", "bus", "commuter_rail"]);
    }
    return modeSet;
  }, [tripModeFilters]);
  const modeDropdownControl = (
    <div className="relative">
      <button
        type="button"
        className="mode-dropdown-trigger mode-dropdown-trigger--large rounded-full border px-4 py-2 text-sm font-medium"
        style={{ borderColor: "var(--border)", color: "var(--foreground)", background: "var(--surface)" }}
        onClick={() => setModeDropdownOpen((prev) => !prev)}
        aria-haspopup="true"
        aria-expanded={modeDropdownOpen}
        aria-label="Select modes"
        data-interactive="ghost"
      >
        <span className="inline-flex items-center gap-2">
          <span className="mode-trigger-label">
            {tripModeFilters.length === MODE_OPTIONS.length ? "All modes" : "Modes"}
          </span>
          <span className="inline-flex items-center gap-1">
            {MODE_OPTIONS.filter((mode) => tripModeFilters.includes(mode.id)).map((mode) => {
              const token =
                mode.id === "bus"
                  ? getLineToken("Bus", themeMode)
                  : mode.id === "commuter_rail"
                    ? getLineToken("CommuterRail", themeMode)
                    : getLineToken("Red", themeMode);
              const Icon = mode.icon;
              return <Icon key={mode.id} className="h-5 w-5" color={token?.color ?? "currentColor"} />;
            })}
          </span>
          <FiChevronDown className={`transition ${modeDropdownOpen ? "rotate-180" : ""}`} />
        </span>
      </button>
      {modeDropdown.render && (
        <div
          className={`mode-dropdown-menu absolute right-0 top-full z-[80] mt-2 min-w-[320px] rounded-2xl border bg-(--card) p-3 shadow-lg ${
            modeDropdown.visible ? "mode-dropdown-menu--open" : ""
          }`}
          style={{ borderColor: "var(--border)" }}
        >
          <div className="mode-dropdown-section">
            <div className="mode-dropdown-title">Modes</div>
            <div className="space-y-1">
              {MODE_OPTIONS.map((mode) => {
                const active = tripModeFilters.includes(mode.id);
                const token =
                  mode.id === "bus"
                    ? getLineToken("Bus", themeMode)
                    : mode.id === "commuter_rail"
                      ? getLineToken("CommuterRail", themeMode)
                      : getLineToken("Red", themeMode);
                const Icon = mode.icon;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    className={`mode-dropdown-item flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${
                      active ? "mode-dropdown-item--active" : ""
                    }`}
                    onClick={() => toggleTripModeFilter(mode.id)}
                    aria-pressed={active}
                    data-interactive="ghost"
                  >
                    <span
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full border"
                      style={{
                        borderColor: token?.color ?? "var(--border)",
                        background: `color-mix(in srgb, ${token?.color ?? "var(--foreground)"} 14%, var(--surface))`,
                      }}
                    >
                      <Icon className="h-5 w-5" color={token?.color ?? "currentColor"} />
                    </span>
                    <span className="flex-1 font-semibold">{mode.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
          {(activeModeFilters.has("subway") || activeModeFilters.has("bus")) && (
            <div className="mode-dropdown-section">
              <div className="mode-dropdown-title">Lines</div>
              <div className="mode-line-dots">
                {activeModeFilters.has("subway") &&
                  SUBWAY_LINE_IDS.map((lineId) => {
                    const line = LINE_OPTIONS.find((entry) => entry.id === lineId);
                    if (!line) return null;
                    const token = getLineToken(line.id, themeMode);
                    const hasFilter = selectedLines.length > 0;
                    const isActive = hasFilter ? selectedLines.includes(line.id) : true;
                    const greenBranchLabel = line.id.startsWith("Green-") ? line.id.split("-")[1] : null;
                    return (
                    <button
                      key={line.id}
                      type="button"
                      className={`mode-line-dot ${isActive ? "active" : ""}`}
                      onClick={() => {
                        if (selectedLines.length === 0) {
                          setSelectedLines([line.id]);
                          return;
                        }
                        toggleLineFilterSingle(line.id);
                      }}
                      aria-pressed={isActive}
                      title={line.label}
                      data-interactive="chip"
                    >
                        <span className="sr-only">{line.label}</span>
                        <span className="line-dot" style={{ background: token.color }} />
                        {greenBranchLabel && (
                          <span className="mode-line-letter" aria-hidden="true">
                            {greenBranchLabel}
                          </span>
                        )}
                      </button>
                    );
                  })}
                {(() => {
                  const busToken = getLineToken("Bus", themeMode);
                  const isActive = activeModeFilters.has("bus");
                  return (
                    <button
                      type="button"
                      className={`mode-line-dot mode-line-dot--icon ${isActive ? "active" : ""}`}
                      onClick={() => toggleTripModeFilter("bus")}
                      aria-pressed={isActive}
                      title="Bus"
                      data-interactive="chip"
                    >
                      <span className="sr-only">Bus</span>
                      <span className="line-dot" style={{ background: busToken.color }} />
                      <BusIcon className="mode-line-icon" color="#1f2933" />
                    </button>
                  );
                })()}
              </div>
            </div>
          )}
          {activeModeFilters.has("commuter_rail") && (
            <div className="mode-dropdown-section">
              <div className="mode-dropdown-title">Commuter Rail</div>
              <div className="mode-line-dots">
                {(() => {
                  const token = getLineToken("CommuterRail", themeMode);
                  const hasFilter = selectedLines.length > 0;
                  const isActive = hasFilter ? selectedLines.includes("CommuterRail") : true;
                  return (
                    <button
                      type="button"
                      className={`mode-line-dot ${isActive ? "active" : ""}`}
                      onClick={() => {
                        if (selectedLines.length === 0) {
                          setSelectedLines(["CommuterRail"]);
                          return;
                        }
                        toggleLineFilterSingle("CommuterRail");
                      }}
                      aria-pressed={isActive}
                      title="Commuter Rail"
                      data-interactive="chip"
                    >
                      <span className="sr-only">Commuter Rail</span>
                      <span className="line-dot" style={{ background: token.color }} />
                    </button>
                  );
                })()}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  // Calculate search radius based on zoom level
  // Zoom 14+: 1.2km (walkable distance)
  // Zoom 11-13: 5km (neighborhood scale)
  // Zoom 9-10: 25km (regional scale, includes most CR endpoints)
  // Zoom <9: 50km (very wide view, shows all major CR endpoints)
  const searchRadius = useMemo(() => {
    if (viewState.zoom >= 14) return 1200;
    if (viewState.zoom >= 11) return 5000;
    if (viewState.zoom >= 9) return 25000;
    return 50000;
  }, [viewState.zoom]);

  const searchLimit = useMemo(() => {
    if (viewState.zoom >= 14) return 12;
    if (viewState.zoom >= 11) return 30;
    if (viewState.zoom >= 9) return 60;
    return 100;
  }, [viewState.zoom]);

  const homeQuery = useQuery<HomeResponse, Error>({
    queryKey: ["home", position, searchRadius, searchLimit],
    queryFn: () =>
      fetchHome({
        lat: position.lat,
        lng: position.lng,
        radiusMeters: searchRadius,
        limit: searchLimit,
      }),
    retry: false,
    refetchInterval: 30_000,
    placeholderData: (previousData) => previousData,
  });

  const lineShapesQuery = useQuery({
    queryKey: ["lineShapes", "all"],
    queryFn: async (): Promise<LineShapeWithId[]> => {
      const results = await Promise.allSettled(
        LINE_OPTIONS.map(async (line) => {
          const data = await fetchLineShapes(line.id);
          return { ...data, id: line.id } as LineShapeWithId;
        }),
      );
      return results
        .filter((result) => result.status === "fulfilled")
        .map((result) => (result as PromiseFulfilledResult<LineShapeWithId>).value);
    },
    staleTime: 5 * 60_000,
  });

  const allowedLineIds = useMemo(() => {
    const allowed = new Set<LineOptionId>();
    if (activeModeFilters.has("subway")) {
      SUBWAY_LINE_IDS.forEach((id) => allowed.add(id));
    }
    if (activeModeFilters.has("commuter_rail")) {
      allowed.add("CommuterRail");
    }
    return allowed;
  }, [activeModeFilters]);

  const filteredLineShapes = useMemo(
    () => (lineShapesQuery.data ?? []).filter((line) => allowedLineIds.has(line.id)),
    [allowedLineIds, lineShapesQuery.data],
  );

  const lineShapeLookup = useMemo(() => {
    const map = new Map<LineOptionId, LineShapeResponse["shapes"]>();
    filteredLineShapes.forEach((line) => {
      map.set(line.id, line.shapes);
    });
    return map;
  }, [filteredLineShapes]);

  const focusOnMapPoints = useCallback(
    (points: FocusPoint[]) => {
      if (!mapReady || !mapRef.current || points.length === 0) return;
      const map = mapRef.current.getMap();
      const canvas = map?.getCanvas?.();
      if (!canvas || canvas.clientWidth < 20 || canvas.clientHeight < 20) return;
      logMapDebug("focusOnMapPoints:start", {
        pointsCount: points.length,
        canvas: { width: canvas.clientWidth, height: canvas.clientHeight },
        preferStopZoom: preferStopZoomRef.current,
      });
      const validPoints = points.filter(
        (point) => Number.isFinite(point.lat) && Number.isFinite(point.lng),
      );
      logMapDebug("focusOnMapPoints:valid", { validPointsCount: validPoints.length });
      if (validPoints.length === 0) return;
      const clampPadding = (padding: maplibregl.PaddingOptions) => {
        const maxX = Math.max(0, Math.floor((canvas.clientWidth - 40) / 2));
        const maxY = Math.max(0, Math.floor((canvas.clientHeight - 40) / 2));
        return {
          top: Math.min(padding.top ?? 0, maxY),
          bottom: Math.min(padding.bottom ?? 0, maxY),
          left: Math.min(padding.left ?? 0, maxX),
          right: Math.min(padding.right ?? 0, maxX),
        };
      };
      const latitudes = validPoints.map((point) => point.lat);
      const longitudes = validPoints.map((point) => point.lng);
      const minLat = Math.min(...latitudes);
      const maxLat = Math.max(...latitudes);
      const minLng = Math.min(...longitudes);
      const maxLng = Math.max(...longitudes);
      if (!Number.isFinite(minLat) || !Number.isFinite(minLng)) return;
      logMapDebug("focusOnMapPoints:bounds", {
        minLat,
        maxLat,
        minLng,
        maxLng,
        pointsSample: validPoints.slice(0, 4),
      });
      const spanMeters = metersBetween(minLat, minLng, maxLat, maxLng);
      logMapDebug("focusOnMapPoints:span", { spanMeters });
      if (validPoints.length === 1 || (maxLat === minLat && maxLng === minLng)) {
        // If this focus was requested by selecting a stop, use a slightly
        // reduced zoom so surroundings are visible.
        const zoomForSingle = preferStopZoomRef.current ? 13 : 14;
        logMapDebug("focusOnMapPoints:single", {
          zoom: zoomForSingle,
          center: [validPoints[0].lng, validPoints[0].lat],
        });
        try {
          mapRef.current.flyTo({
            center: [validPoints[0].lng, validPoints[0].lat],
            zoom: zoomForSingle,
            duration: 800,
          });
        } catch {
          // ignore fly errors
        }
        // reset the preference
        preferStopZoomRef.current = false;
        return;
      }
      if (Number.isFinite(spanMeters) && spanMeters > 15_000) {
        const zoomForSingle = preferStopZoomRef.current ? 13 : 14;
        logMapDebug("focusOnMapPoints:spanFallback", {
          spanMeters,
          zoom: zoomForSingle,
          center: [validPoints[0].lng, validPoints[0].lat],
        });
        try {
          mapRef.current.flyTo({
            center: [validPoints[0].lng, validPoints[0].lat],
            zoom: zoomForSingle,
            duration: 800,
          });
        } catch {
          // ignore fly errors
        }
        preferStopZoomRef.current = false;
        return;
      }
      try {
        const padding = clampPadding({ top: 120, bottom: 160, left: 40, right: 40 });
        logMapDebug("focusOnMapPoints:fitBounds", {
          padding,
          bounds: [
            [minLng, minLat],
            [maxLng, maxLat],
          ],
        });
        if (![minLng, minLat, maxLng, maxLat].every((value) => Number.isFinite(value))) {
          return;
        }
        if (minLng === maxLng && minLat === maxLat) {
          try {
            mapRef.current.flyTo({
              center: [minLng, minLat],
              zoom: 14,
              duration: 800,
            });
          } catch {
            // ignore fly errors
          }
          preferStopZoomRef.current = false;
          return;
        }
        if (
          canvas.clientWidth - (padding.left + padding.right) < 40 ||
          canvas.clientHeight - (padding.top + padding.bottom) < 40
        ) {
          logMapDebug("focusOnMapPoints:fitBoundsSkipped", {
            reason: "insufficientCanvas",
            canvas: { width: canvas.clientWidth, height: canvas.clientHeight },
            padding,
          });
          return;
        }
        mapRef.current.fitBounds(
          [
            [minLng, minLat],
            [maxLng, maxLat],
          ],
          {
            padding,
            duration: 800,
            maxZoom: 15,
          },
        );
      } catch {
        // ignore fit bounds errors
      }
    },
    [mapReady],
  );

  const requestMapFocus = useMapFocusDispatcher({
    mapReady,
    mapPickMode,
    mapUiMode,
    mapSectionRef,
    focusOnMapPoints,
  });

  const clearMapFocus = useCallback(() => {
    requestMapFocus(null);
  }, [requestMapFocus]);
  const captureMapView = useCallback(() => {
    const mapInstance = mapRef.current?.getMap?.();
    if (!mapInstance) return;
    const center = mapInstance.getCenter();
    mapViewBeforeSheetRef.current = {
      center: [center.lng, center.lat],
      zoom: mapInstance.getZoom(),
      bearing: mapInstance.getBearing(),
      pitch: mapInstance.getPitch(),
    };
  }, []);

  const buildStopFocusPoints = useCallback(
    (lat?: number, lng?: number, lineIds?: string[]) => {
      if (lat == null || lng == null) return [];
      const basePoint: FocusPoint = { lat, lng };
      const neighborPoints: FocusPoint[] = [];
      const localLimitMeters = 6000;
      const seen = new Set<string>();
      logMapDebug("buildStopFocusPoints:start", {
        lat,
        lng,
        lineIdsCount: lineIds?.length ?? 0,
      });
      (lineIds ?? []).forEach((lineId) => {
        if (!isLineOptionId(lineId)) return;
        const shapes = lineShapeLookup.get(lineId);
        if (!shapes) return;
        shapes.forEach((path) => {
          if (!path.length) return;
          let bestIndex = 0;
          let bestDistance = Infinity;
          path.forEach((coord, index) => {
            const distance = metersBetween(lat, lng, coord.lat, coord.lng);
            if (distance < bestDistance) {
              bestDistance = distance;
              bestIndex = index;
            }
          });
          [-2, -1, 1, 2].forEach((offset) => {
            const index = bestIndex + offset;
            if (index < 0 || index >= path.length) return;
            const coord = path[index];
            const key = `${lineId}-${index}-${coord.lat}-${coord.lng}`;
            if (seen.has(key)) return;
            if (metersBetween(lat, lng, coord.lat, coord.lng) > localLimitMeters) return;
            seen.add(key);
            neighborPoints.push({ lat: coord.lat, lng: coord.lng });
          });
        });
      });
      logMapDebug("buildStopFocusPoints:summary", {
        neighborPointsCount: neighborPoints.length,
      });
      if (neighborPoints.length === 0) {
        return [basePoint];
      }
      return [basePoint, ...neighborPoints.slice(0, 6)];
    },
    [lineShapeLookup],
  );

  const fitMapToBounds = useCallback(
    (
      bounds: [[number, number], [number, number]],
      options?: {
        padding?: number | maplibregl.PaddingOptions;
        duration?: number;
        fallbackCenter?: [number, number];
        fallbackZoom?: number;
        maxZoom?: number;
      },
    ) => {
      if (!mapReady || !mapRef.current) return;
      const map = mapRef.current.getMap();
      const canvas = map?.getCanvas?.();
      if (!canvas || canvas.clientWidth < 20 || canvas.clientHeight < 20) return;
      const clampPadding = (padding: maplibregl.PaddingOptions) => {
        const maxX = Math.max(0, Math.floor((canvas.clientWidth - 40) / 2));
        const maxY = Math.max(0, Math.floor((canvas.clientHeight - 40) / 2));
        return {
          top: Math.min(padding.top ?? 0, maxY),
          bottom: Math.min(padding.bottom ?? 0, maxY),
          left: Math.min(padding.left ?? 0, maxX),
          right: Math.min(padding.right ?? 0, maxX),
        };
      };
      const [[minLng, minLat], [maxLng, maxLat]] = bounds;
      
      // Check if bounds are identical or invalid
      if (![minLng, minLat, maxLng, maxLat].every((value) => Number.isFinite(value))) {
        return;
      }
      if (minLng === maxLng && minLat === maxLat) {
        const fallbackCenter = options?.fallbackCenter ?? [minLng, minLat];
        const fallbackZoom = options?.fallbackZoom ?? 14;
        try {
          mapRef.current.flyTo({
            center: fallbackCenter as [number, number],
            zoom: fallbackZoom,
            duration: options?.duration ?? 800,
          });
        } catch {
          // ignore fly errors
        }
        return;
      }
      
      try {
        const rawPadding = options?.padding;
        const padding =
          typeof rawPadding === "number"
            ? { top: rawPadding, bottom: rawPadding, left: rawPadding, right: rawPadding }
            : rawPadding ?? { top: 140, bottom: 140, left: 140, right: 140 };
        const clamped = clampPadding(padding);
        if (
          canvas.clientWidth - (clamped.left + clamped.right) < 40 ||
          canvas.clientHeight - (clamped.top + clamped.bottom) < 40
        ) {
          return;
        }
        map.fitBounds(bounds, {
          padding: clamped,
          duration: options?.duration ?? 800,
          maxZoom: options?.maxZoom,
        });
      } catch {
        const fallbackCenter = options?.fallbackCenter;
        const fallbackZoom = options?.fallbackZoom ?? 14;
        if (fallbackCenter) {
          try {
            mapRef.current.flyTo({
              center: fallbackCenter,
              zoom: fallbackZoom,
              duration: options?.duration ?? 800,
            });
          } catch {
            // ignore fly errors
          }
        }
      }
    },
    [mapReady],
  );

  const subwayStationsQuery = useQuery({
    queryKey: ["stations", "subway"],
    queryFn: () => fetchStations("subway", 600),
    staleTime: 5 * 60_000,
    enabled: activeModeFilters.has("subway"),
  });

  const busStationsQuery = useQuery({
    queryKey: ["stations", "bus"],
    queryFn: () => fetchStations("bus", 600),
    staleTime: 5 * 60_000,
    enabled: activeModeFilters.has("bus"),
  });

  const commuterRailStationsQuery = useQuery({
    queryKey: ["stations", "commuter_rail"],
    queryFn: () => fetchStations("commuter_rail", 600),
    staleTime: 5 * 60_000,
    enabled: activeModeFilters.has("commuter_rail"),
  });

  const stationsDataRaw = useMemo(() => {
    const subway = activeModeFilters.has("subway") ? subwayStationsQuery.data ?? [] : [];
    const bus = activeModeFilters.has("bus") ? busStationsQuery.data ?? [] : [];
    const commuterRail = activeModeFilters.has("commuter_rail") ? commuterRailStationsQuery.data ?? [] : [];
    return [...subway, ...bus, ...commuterRail];
  }, [activeModeFilters, busStationsQuery.data, commuterRailStationsQuery.data, subwayStationsQuery.data]);
  const stationsLoading =
    (activeModeFilters.has("subway") && subwayStationsQuery.isLoading) ||
    (activeModeFilters.has("bus") && busStationsQuery.isLoading) ||
    (activeModeFilters.has("commuter_rail") && commuterRailStationsQuery.isLoading);

  const stationsData = useMemo(() => {
    if (!stationsDataRaw) return [];
    const merged = new Map<string, typeof stationsDataRaw[number]>();
    stationsDataRaw.forEach((station) => {
      const existing = merged.get(station.stopId);
      if (!existing) {
        merged.set(station.stopId, { ...station });
        return;
      }
      const routesServing = Array.from(new Set([...(existing.routesServing ?? []), ...(station.routesServing ?? [])]));
      const modesServed = Array.from(new Set([...(existing.modesServed ?? []), ...(station.modesServed ?? [])]));
      const platformStopIds = Array.from(
        new Set([...(existing.platformStopIds ?? []), ...(station.platformStopIds ?? [])]),
      );
      const markerMap = new Map<string, StationPlatformMarker>();
      (existing.platformMarkers ?? []).forEach((marker) => markerMap.set(marker.stopId, marker));
      (station.platformMarkers ?? []).forEach((marker) => markerMap.set(marker.stopId, marker));
      merged.set(station.stopId, {
        ...existing,
        routesServing,
        modesServed,
        platformStopIds,
        platformMarkers: Array.from(markerMap.values()),
      });
    });
    return Array.from(merged.values()).filter((station) => !isNonBoardableStopId(station.stopId));
  }, [stationsDataRaw]);
  const stationLookup = useMemo(() => {
    return new Map(stationsData.map((station) => [station.stopId, station]));
  }, [stationsData]);
  const platformStationMap = useMemo(() => {
    const map = new Map<string, { stationId: string; platformStopIds: string[] }>();
    stationsData.forEach((station) => {
      const platformStopIds = (station.platformStopIds && station.platformStopIds.length > 0
        ? station.platformStopIds
        : [station.stopId]).filter((stopId) => !isNonBoardableStopId(stopId));
      platformStopIds.forEach((platformStopId) => {
        map.set(platformStopId, { stationId: station.stopId, platformStopIds });
      });
    });
    return map;
  }, [stationsData]);

  const stopCoordLookup = useMemo(() => {
    const lookup = new Map<string, FocusPoint>();
    stationsData.forEach((station) => {
      if (station.stopId) {
        lookup.set(station.stopId, { lat: station.latitude, lng: station.longitude });
      }
      (station.platformStopIds ?? []).forEach((platformStopId) => {
        if (!platformStopId) return;
        // Some endpoints only reference platform stop ids; fall back to station coords.
        if (!lookup.has(platformStopId)) {
          lookup.set(platformStopId, { lat: station.latitude, lng: station.longitude });
        }
      });
      (station.platformMarkers ?? []).forEach((marker) => {
        if (!marker.stopId) return;
        if (marker.latitude == null || marker.longitude == null) return;
        lookup.set(marker.stopId, { lat: marker.latitude, lng: marker.longitude });
      });
    });
    return lookup;
  }, [stationsData]);

  const mapCenter = useMemo(() => {
    const lat = viewState.latitude;
    const lon = viewState.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  }, [viewState.latitude, viewState.longitude]);

  const tripOriginSearch = useLocationSearch(tripOriginInput, mapCenter, null, { limit: 8, minLength: 3 });
  const tripDestinationSearch = useLocationSearch(tripDestinationInput, mapCenter, null, { limit: 8, minLength: 3 });
  const addressSearch = useLocationSearch(stopSearch, mapCenter, null, { limit: 8, minLength: 2 });

  const normalizeSearchText = useCallback((value: string) => {
    const tokens = value
      .toLowerCase()
      .replace(/[^a-z0-9\\s]/g, " ")
      .replace(/\\s+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean);
    if (tokens.length === 0) return "";
    const replacements: Record<string, string> = {
      st: "street",
      street: "street",
      ave: "avenue",
      avenue: "avenue",
      rd: "road",
      road: "road",
      blvd: "boulevard",
      boulevard: "boulevard",
      dr: "drive",
      drive: "drive",
      ln: "lane",
      lane: "lane",
      hwy: "highway",
      highway: "highway",
      pkwy: "parkway",
      parkway: "parkway",
      pl: "place",
      place: "place",
      sq: "square",
      square: "square",
      ct: "court",
      court: "court",
      ter: "terrace",
      terrace: "terrace",
      cir: "circle",
      circle: "circle",
    };
    const normalized = tokens.map((token) => replacements[token] ?? token);
    return normalized.join(" ");
  }, []);

  const matchesWordStart = useCallback(
    (query: string, text: string) => {
      const normalizedQuery = normalizeSearchText(query);
      if (!normalizedQuery) return true;
      const normalizedText = normalizeSearchText(text);
      if (normalizedText.includes(normalizedQuery)) return true;
      const escaped = normalizedQuery.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
      const regex = new RegExp(`\\\\b${escaped}`, "i");
      return regex.test(normalizedText);
    },
    [normalizeSearchText],
  );

  const buildTripSuggestions = useCallback(
    (query: string, searchResults: LocationSearchResult[]) => {
      const normalized = query.trim().toLowerCase();
      const savedMatches = (normalized
        ? savedLocations.filter((location) => matchesWordStart(normalized, location.name))
        : savedLocations
      )
        .slice(0, 4)
        .map((location) => ({
          id: `saved-${location.id}`,
          kind: "saved" as const,
          label: location.name,
          lat: location.lat,
          lon: location.lng,
          stopId: location.stopId ?? null,
        }));

      const stopMatches =
        normalized.length >= 2
          ? stationsData
              .filter((station) => matchesWordStart(normalized, station.name))
              .slice(0, 6)
              .map((station) => ({
                id: `stop-${station.stopId}`,
                kind: "stop" as const,
                label: station.name,
                lat: station.latitude,
                lon: station.longitude,
                stopId: station.stopId,
              }))
          : [];

      const geocodeMatches = searchResults
        .filter((result) => (normalized.length >= 2 ? matchesWordStart(normalized, result.label) : true))
        .map((result) => ({
          id: result.id,
          kind: "geocode" as const,
          label: result.label,
          lat: result.lat,
          lon: result.lon,
          stopId: null,
        }));

      return [...savedMatches, ...stopMatches, ...geocodeMatches];
    },
    [matchesWordStart, savedLocations, stationsData],
  );

  const tripOriginSuggestions = useMemo(
    () => buildTripSuggestions(tripOriginInput, tripOriginSearch.results),
    [buildTripSuggestions, tripOriginInput, tripOriginSearch.results],
  );

  const tripDestinationSuggestions = useMemo(
    () => buildTripSuggestions(tripDestinationInput, tripDestinationSearch.results),
    [buildTripSuggestions, tripDestinationInput, tripDestinationSearch.results],
  );

  useEffect(() => {
    if (tripMode === "HOME") {
      originWasManualRef.current = false;
    }
    if (tripMode !== "TRIP_EDITING") return;
    if (tripPlanView.origin) return;
    if (originWasManualRef.current) return;
    if (originAutoSetRef.current) return;
    if (!mapCenter) return;
    const originPoint: TripPoint = { label: "Map center", lat: mapCenter.lat, lon: mapCenter.lon };
    setTripPlanView((prev) => ({ ...prev, origin: originPoint }));
    setTripOriginInput(originPoint.label);
    originAutoSetRef.current = true;
  }, [tripMode, tripPlanView.origin, mapCenter]);

  const reverseGeocode = useCallback(async (lat: number, lon: number) => {
    try {
      const url = new URL("/api/reverse-geocode", envConfig.apiBaseUrl);
      url.searchParams.set("lat", String(lat));
      url.searchParams.set("lon", String(lon));
      const response = await fetch(url.toString());
      if (!response.ok) throw new Error("reverse_geocode_failed");
      const payload = (await response.json()) as { label?: string };
      return payload.label ?? `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    } catch {
      return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    }
  }, []);

  const confirmMapPick = useCallback(async () => {
    if (!mapPickMode) return;
    const mapInstance = mapRef.current?.getMap?.();
    const center = mapInstance ? mapInstance.getCenter() : { lat: viewState.latitude, lng: viewState.longitude };
    if (center.lat == null || center.lng == null) return;
    setMapPickLoading(true);
    setMapPickError(null);
    const label = await reverseGeocode(center.lat, center.lng);
    const point: TripPoint = { label, lat: center.lat, lon: center.lng };
    if (mapPickMode === "origin") {
      originWasManualRef.current = true;
      const nextOrigin = point;
      const nextDestination = tripPlanView.destination ?? null;
      setTripPlanView((prev) => ({
        ...prev,
        origin: point,
        activeTripId: null,
        plans: [],
        summary: null,
        warnings: [],
      }));
      setTripOriginInput(label);
      requestTripEditing(nextOrigin, nextDestination);
      window.setTimeout(() => destinationInputRef.current?.focus(), 0);
    } else {
      const nextOrigin = tripPlanView.origin ?? null;
      const nextDestination = point;
      setTripPlanView((prev) => ({
        ...prev,
        destination: point,
        activeTripId: null,
        plans: [],
        summary: null,
        warnings: [],
      }));
      setTripDestinationInput(label);
      requestTripEditing(nextOrigin, nextDestination);
    }
    setTripPlanError(null);
    setTripPlanNotice(null);
    lastPlannedKeyRef.current = null;
    setMapPickMode(null);
    setMapPickLoading(false);
    setMapPickPulse(true);
    window.setTimeout(() => setMapPickPulse(false), 650);
  }, [
    mapPickMode,
    requestTripEditing,
    reverseGeocode,
    setMapPickError,
    setMapPickLoading,
    setMapPickMode,
    setMapPickPulse,
    setTripPlanError,
    tripPlanView.destination,
    tripPlanView.origin,
    viewState.latitude,
    viewState.longitude,
  ]);

  const applyTripPoint = useCallback(
    (point: TripPoint, preferred?: "origin" | "destination") => {
      const target = preferred ?? tripFocusedField ?? (!tripPlanView.origin ? "origin" : "destination");
      if (target === "origin") {
        originWasManualRef.current = true;
        const nextOrigin = point;
        const nextDestination = tripPlanView.destination ?? null;
        setTripPlanView((prev) => ({
          ...prev,
          origin: point,
          activeTripId: null,
          plans: [],
          summary: null,
          warnings: [],
        }));
        setTripOriginInput(point.label);
        requestTripEditing(nextOrigin, nextDestination);
        window.setTimeout(() => destinationInputRef.current?.focus(), 0);
      } else {
        const nextOrigin = tripPlanView.origin ?? null;
        const nextDestination = point;
        setTripPlanView((prev) => ({
          ...prev,
          destination: point,
          activeTripId: null,
          plans: [],
          summary: null,
          warnings: [],
        }));
        setTripDestinationInput(point.label);
        requestTripEditing(nextOrigin, nextDestination);
      }
      setTripPlanError(null);
      setTripPlanNotice(null);
      lastPlannedKeyRef.current = null;
      setTripFocusedField(null);
    },
    [requestTripEditing, setTripPlanError, setTripPlanNotice, tripFocusedField, tripPlanView.destination, tripPlanView.origin],
  );

  useEffect(() => {
    if (!mapPickMode) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void confirmMapPick();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMapPickMode(null);
        setMapPickError(null);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [confirmMapPick, mapPickMode, setMapPickError, setMapPickMode]);

  useEffect(() => {
    if (!tripFocusedField) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setTripFocusedField(null);
      }
    };
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      const originNode = originFieldRef.current;
      const destinationNode = destinationFieldRef.current;
      if (originNode?.contains(target) || destinationNode?.contains(target)) return;
      setTripFocusedField(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [tripFocusedField]);

  const swapTripPoints = useCallback(() => {
    const origin = tripPlanView.origin;
    const destination = tripPlanView.destination;
    setTripPlanView((prev) => ({
      ...prev,
      origin: destination ?? null,
      destination: origin ?? null,
      activeTripId: null,
      plans: [],
      summary: null,
      warnings: [],
    }));
    setTripOriginInput(destination?.label ?? "");
    setTripDestinationInput(origin?.label ?? "");
    setTripPlanError(null);
    setTripPlanNotice(null);
    lastPlannedKeyRef.current = null;
    requestTripEditing(destination ?? null, origin ?? null);
  }, [requestTripEditing, tripPlanView.destination, tripPlanView.origin, setTripPlanError, setTripPlanNotice]);

  const toggleTripModeFilter = useCallback(
    (mode: TripModeFilter) => {
      setTripModeFilters((prev) => {
        if (prev.includes(mode)) {
          if (prev.length === 1) return prev;
          return prev.filter((entry) => entry !== mode);
        }
        return [...prev, mode];
      });
      lastPlannedKeyRef.current = null;
      setTripPlanNotice(null);
      if (tripPlanView.origin && tripPlanView.destination) {
        requestTripEditing(tripPlanView.origin, tripPlanView.destination);
      }
    },
    [requestTripEditing, setTripPlanNotice, tripPlanView.destination, tripPlanView.origin],
  );

  const isLineVisibleForModes = useCallback(
    (lineId: LineOptionId) => {
      if (lineId === "CommuterRail") return activeModeFilters.has("commuter_rail");
      return activeModeFilters.has("subway");
    },
    [activeModeFilters],
  );

  useEffect(() => {
    setSelectedLines((prev) => prev.filter((lineId) => isLineVisibleForModes(lineId)));
  }, [isLineVisibleForModes]);

  const addRecentTrip = useCallback((origin: TripPoint, destination: TripPoint, lineIds?: string[] | null) => {
    const key = `${origin.lat},${origin.lon}-${destination.lat},${destination.lon}`;
    setRecentTrips((prev) => {
      const filtered = prev.filter((trip) => trip.id !== key);
      const next: RecentTrip[] = [
        {
          id: key,
          origin,
          destination,
          lineIds: lineIds && lineIds.length > 0 ? Array.from(new Set(lineIds)) : null,
          createdAt: Date.now(),
        },
        ...filtered,
      ];
      return next.slice(0, 6);
    });
  }, []);

  const applyRecentTrip = useCallback((trip: RecentTrip) => {
    setTripPlanView((prev) => ({
      ...prev,
      origin: trip.origin,
      destination: trip.destination,
      activeTripId: null,
      plans: [],
      summary: null,
      warnings: [],
    }));
    setTripOriginInput(trip.origin.label ?? "");
    setTripDestinationInput(trip.destination.label ?? "");
    setTripPlanError(null);
    setTripPlanNotice(null);
    lastPlannedKeyRef.current = null;
    requestTripEditing(trip.origin, trip.destination);
  }, [requestTripEditing]);

  useEffect(() => {
    const handleSwap = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      if (event.shiftKey || event.altKey) return;
      event.preventDefault();
      swapTripPoints();
    };
    window.addEventListener("keydown", handleSwap);
    return () => window.removeEventListener("keydown", handleSwap);
  }, [swapTripPoints]);

  const handleTripPlanSubmit = useCallback(async () => {
    if (!tripPlanView.origin || !tripPlanView.destination) {
      setTripPlanError("Choose a start and destination.");
      setTripPlanNotice(null);
      return;
    }
    if (tripModeFilters.length === 0) {
      setTripPlanError("Select at least one mode (Subway, Bus, Commuter Rail).");
      setTripPlanNotice(null);
      return;
    }
    setTripPlanError(null);
    setTripPlanNotice(null);
    setTripMode("TRIP_PLANNING");
    if (tripPlanAbortRef.current) {
      tripPlanAbortRef.current.abort();
    }
    const controller = new AbortController();
    tripPlanAbortRef.current = controller;
    try {
      const response = await fetchTripPlanner({
        originLat: tripPlanView.origin.lat,
        originLon: tripPlanView.origin.lon,
        destLat: tripPlanView.destination.lat,
        destLon: tripPlanView.destination.lon,
        modes: tripModeFilters,
      }, { signal: controller.signal });
      const viewModel = mapTripPlannerResponse(response);
      tripPlanAbortRef.current = null;
      setTripPlanView((prev) => ({
        ...prev,
        activeTripId: viewModel.activeTripId,
        plans: viewModel.plans,
        summary: viewModel.summary,
        warnings: viewModel.warnings,
      }));
      const primaryPlan = viewModel.plans.find((plan) => plan.tripId === viewModel.activeTripId) ?? viewModel.plans[0] ?? null;
      const tripLineIds =
        primaryPlan?.legs
          .filter((leg) => leg.mode !== "walk")
          .map((leg) => (leg.routeId ?? leg.lineId ?? null))
          .filter((id): id is string => typeof id === "string" && id.length > 0) ?? [];
      addRecentTrip(tripPlanView.origin, tripPlanView.destination, tripLineIds);
      setTripMode("TRIP_READY");
    } catch (error) {
      tripPlanAbortRef.current = null;
      if ((error as Error).name === "AbortError") {
        setTripMode("TRIP_EDITING");
        return;
      }
      const err = error as Error;
      if (err.name === "trip_planner_no_route") {
        setTripPlanError(null);
        setTripPlanNotice(buildNoRouteMessage(tripModeFilters));
        setTripMode("TRIP_ERROR");
        return;
      }
      if (err.message === "trip_planner_timeout") {
        setTripPlanError("Trip planning timed out. Try again or switch to walking distance.");
      } else {
        setTripPlanError("Trip planner request failed. Try adjusting your points.");
      }
      setTripPlanNotice(null);
      setTripMode("TRIP_ERROR");
    }
  }, [addRecentTrip, setTripMode, tripModeFilters, tripPlanView.origin, tripPlanView.destination]);

  useEffect(() => {
    if (tripMode === "HOME") {
      setTripFocusedField(null);
      setTripPlanError(null);
      setTripPlanNotice(null);
    }
  }, [tripMode]);

  useEffect(() => {
    if (deepLinkSegmentAppliedRef.current) return;
    if (!mapReady) return;
    if (stopCoordLookup.size === 0) return;

    const focus = searchParams.get("focus");
    const fromStop = searchParams.get("fromStop") ?? "";
    const toStop = searchParams.get("toStop") ?? "";
    if (focus !== "segment" && !fromStop && !toStop) return;

    const points: FocusPoint[] = [];
    const fromPoint = fromStop ? stopCoordLookup.get(fromStop) ?? null : null;
    const toPoint = toStop ? stopCoordLookup.get(toStop) ?? null : null;
    if (fromPoint) points.push(fromPoint);
    if (toPoint && (!fromPoint || toPoint.lat !== fromPoint.lat || toPoint.lng !== fromPoint.lng)) {
      points.push(toPoint);
    }
    if (points.length === 0) return;

    requestMapFocus({
      id: `segment-${fromStop || "_"}-${toStop || "_"}`,
      points,
      scroll: true,
      priority: 1,
      kind: "deeplink",
    });
    deepLinkSegmentAppliedRef.current = true;
  }, [mapReady, requestMapFocus, searchParams, stopCoordLookup]);
  const restoreMapView = useCallback(() => {
    const snapshot = mapViewBeforeSheetRef.current;
    mapViewBeforeSheetRef.current = null;
    if (!snapshot) return;
    const mapInstance = mapRef.current;
    if (!mapInstance) return;
    try {
      mapInstance.flyTo({
        center: snapshot.center,
        zoom: snapshot.zoom,
        bearing: snapshot.bearing,
        pitch: snapshot.pitch,
        duration: 650,
        essential: true,
      });
    } catch {
      try {
        mapInstance.jumpTo({
          center: snapshot.center,
          zoom: snapshot.zoom,
          bearing: snapshot.bearing,
          pitch: snapshot.pitch,
        });
      } catch {
        // ignore
      }
    }
  }, []);
  const closeStopSheet = useCallback(() => {
    setIsStopSheetOpen(false);
    setSelectedStopId(null);
    setSelectedStopName(null);
    setSelectedPlatformStopIds(null);
    lastStopRouteFocusRef.current = null;
    clearMapFocus();
    // Restore previously-selected lines (if we saved them prior to opening the sheet)
    if (prevSelectedLinesRef.current) {
      setSelectedLines(prevSelectedLinesRef.current);
      prevSelectedLinesRef.current = null;
    }
    restoreMapView();
  }, [setIsStopSheetOpen, setSelectedStopId, setSelectedStopName, setSelectedPlatformStopIds, setSelectedLines, clearMapFocus, restoreMapView]);

  const tripTrackQuery = useQuery({
    queryKey: ["tripTrack", activeTripId],
    queryFn: () => fetchTripTrack(activeTripId!),
    enabled: Boolean(activeTripId),
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    retry: false,
    retryOnMount: false,
  });

  const upcomingTripStops = useMemo(() => {
    if (!activeTripId) return [];
    return tripTrackQuery.data?.upcomingStops ?? [];
  }, [activeTripId, tripTrackQuery.data?.upcomingStops]);
  const followFocusStopIds = useMemo(
    () => upcomingTripStops.slice(0, 2).map((stop) => stop.stopId),
    [upcomingTripStops],
  );
  const followFocusStopSet = useMemo(() => {
    return followFocusStopIds.length > 0 ? new Set(followFocusStopIds) : null;
  }, [followFocusStopIds]);
  const vehiclePosition = tripTrackQuery.data?.vehicle?.position;
  const activeTripRouteId = tripTrackQuery.data?.routeId;
  const followTrackingError = useMemo(() => {
    if (tripTrackQuery.isError) {
      return "Trip tracking unavailable. MBTA v3 may not have real-time data for this trip.";
    }
    if (activeTripId && tripTrackQuery.data && !tripTrackQuery.data.vehicle) {
      return "Vehicle location unavailable. MBTA real-time feed may be missing this vehicle.";
    }
    return null;
  }, [activeTripId, tripTrackQuery.data, tripTrackQuery.isError]);

  useEffect(() => {
    if (!activeTripId) return;
    const tripPoints = upcomingTripStops
      .map((stop) => stationLookup.get(stop.stopId))
      .filter((station): station is StationSummary => Boolean(station))
      .map((station) => ({ lat: station.latitude, lng: station.longitude }));
    if (tripPoints.length === 0) {
      return;
    }
    requestMapFocus({ id: `trip-${activeTripId}`, points: tripPoints, scroll: false, priority: 4, kind: "follow" });
  }, [activeTripId, upcomingTripStops, stationLookup, requestMapFocus]);

  const centerMapOnCoordinates = useCallback(
    (lat: number, lng: number, zoom = 14) => {
      if (!mapReady || !mapRef.current) return;
      try {
        mapRef.current.flyTo({ center: [lng, lat], zoom, duration: 900 });
      } catch {
        // ignore fly errors
      }
    },
    [mapReady],
  );

  useEffect(() => {
    if (!mapReady) return;
    const mapInstance = mapRef.current?.getMap?.();
    const padding = getMapPadding(Boolean(activeTripId));
    if (mapInstance) {
      mapInstance.setPadding(padding);
      mapInstance.resize();
      mapInstance.triggerRepaint();
    }
    setViewState((prev) => ({ ...prev, padding }));
  }, [activeTripId, getMapPadding, mapReady]);

  useEffect(() => {
    if (!mapReady) return;
    if (!activeTripId || !vehiclePosition || vehiclePosition.lat == null || vehiclePosition.lng == null) {
      return;
    }
    const map = mapRef.current;
    if (!map) return;
    const previous = lastVehicleLocationRef.current;
    const hasPrevious =
      previous && Number.isFinite(previous.lat) && Number.isFinite(previous.lng);
    const latDiff = hasPrevious ? Math.abs(previous!.lat - vehiclePosition.lat) : Infinity;
    const lngDiff = hasPrevious ? Math.abs(previous!.lng - vehiclePosition.lng) : Infinity;
    if (hasPrevious && latDiff < 0.00005 && lngDiff < 0.00005) {
      return;
    }
    try {
      // Pan to the vehicle without forcing a tighter zoom. Zoom is determined
      // by the bounds-based focus (which includes upcoming stops) so we don't
      // zoom in too closely during follow.
      map.flyTo({
        center: [vehiclePosition.lng, vehiclePosition.lat],
        duration: hasPrevious ? 500 : 0,
        essential: true,
      });
    } catch {
      // ignore fly animation errors
    }
    lastVehicleLocationRef.current = { lat: vehiclePosition.lat, lng: vehiclePosition.lng };
  }, [activeTripId, mapReady, vehiclePosition, viewState.zoom]);

  const handleJumpToStop = useCallback(
    (stopId: string) => {
      const station = stationLookup.get(stopId);
      if (!station) return;
      centerMapOnCoordinates(station.latitude, station.longitude, 15);
    },
    [centerMapOnCoordinates, stationLookup],
  );

  const lineSegments = useMemo<Array<{
    lineId: LineOptionId;
    segments: Array<{ start: { lat: number; lng: number }; end: { lat: number; lng: number } }>;
  }>>(() => {
    if (!filteredLineShapes.length) return [];
    return filteredLineShapes.map((line) => ({
      lineId: line.id as LineOptionId,
      segments: line.shapes.flatMap((path) => {
        const segments: Array<{ start: { lat: number; lng: number }; end: { lat: number; lng: number } }> = [];
        path.forEach((point, index) => {
          if (index === 0) return;
          const prev = path[index - 1];
          if (!prev) return;
          segments.push({ start: prev, end: point });
        });
        return segments;
      }),
    }));
  }, [filteredLineShapes]);

  const lineSegmentIndex = useMemo(() => {
    const grid = new Map<string, number[]>();
    const segments: Array<{
      lineId: LineOptionId;
      start: { lat: number; lng: number };
      end: { lat: number; lng: number };
      minLat: number;
      maxLat: number;
      minLng: number;
      maxLng: number;
    }> = [];
    const size = LINE_SEGMENT_GRID_SIZE;
    const addToCell = (latCell: number, lngCell: number, index: number) => {
      const key = `${latCell}:${lngCell}`;
      const existing = grid.get(key);
      if (existing) {
        existing.push(index);
      } else {
        grid.set(key, [index]);
      }
    };

    lineSegments.forEach((line) => {
      line.segments.forEach((segment) => {
        const minLat = Math.min(segment.start.lat, segment.end.lat);
        const maxLat = Math.max(segment.start.lat, segment.end.lat);
        const minLng = Math.min(segment.start.lng, segment.end.lng);
        const maxLng = Math.max(segment.start.lng, segment.end.lng);
        const index = segments.length;
        segments.push({ lineId: line.lineId, start: segment.start, end: segment.end, minLat, maxLat, minLng, maxLng });
        const minLatCell = Math.floor(minLat / size);
        const maxLatCell = Math.floor(maxLat / size);
        const minLngCell = Math.floor(minLng / size);
        const maxLngCell = Math.floor(maxLng / size);
        for (let latCell = minLatCell; latCell <= maxLatCell; latCell += 1) {
          for (let lngCell = minLngCell; lngCell <= maxLngCell; lngCell += 1) {
            addToCell(latCell, lngCell, index);
          }
        }
      });
    });

    return { grid, segments, size };
  }, [lineSegments]);

  const activeTripPlan = useMemo(() => {
    if (tripPlanView.plans.length === 0) return null;
    if (tripPlanView.activeTripId) {
      return tripPlanView.plans.find((plan) => plan.tripId === tripPlanView.activeTripId) ?? tripPlanView.plans[0] ?? null;
    }
    return tripPlanView.plans[0] ?? null;
  }, [tripPlanView.activeTripId, tripPlanView.plans]);

  const shortenStopLabel = useCallback((value?: string | null) => {
    if (!value) return "Stop";
    const base = value.split(",")[0]?.trim() ?? value.trim();
    const cleaned = base.replace(/\s+Station$/i, "").trim();
    if (cleaned.length <= 14) return cleaned;
    return `${cleaned.slice(0, 12)}…`;
  }, []);

  const shortenTripChipLabel = useCallback((value?: string | null, maxLength = 20) => {
    if (!value) return "Stop";
    const base = value.split(",")[0]?.trim() ?? value.trim();
    const cleaned = base.replace(/\s+Station$/i, "").trim();
    if (cleaned.length <= maxLength) return cleaned;
    return `${cleaned.slice(0, maxLength - 2)}…`;
  }, []);

  const tripLabelPoints = useMemo<TripLabelPoint[]>(() => {
    if (!activeTripPlan || tripMode === "HOME") return [];
    if (viewState.zoom < TRIP_LABEL_MIN_ZOOM) return [];
    const labels: TripLabelPoint[] = [];
    const legs = activeTripPlan.legs ?? [];
    const firstLeg = legs[0];
    const lastLeg = legs[legs.length - 1];

    if (tripPlanView.origin?.lat != null && tripPlanView.origin?.lon != null) {
      labels.push({
        id: "trip-label-start",
        lat: tripPlanView.origin.lat,
        lon: tripPlanView.origin.lon,
        label: shortenStopLabel(tripPlanView.origin.label),
        kind: "start",
        toColor: firstLeg && firstLeg.mode !== "walk"
          ? getLineToken(firstLeg.routeId ?? firstLeg.lineId ?? null, themeMode).color
          : undefined,
      });
    } else if (firstLeg?.from?.lat != null && firstLeg?.from?.lon != null) {
      labels.push({
        id: "trip-label-start",
        lat: firstLeg.from.lat,
        lon: firstLeg.from.lon,
        label: shortenStopLabel(firstLeg.from.name ?? firstLeg.from.label),
        kind: "start",
        toColor: firstLeg.mode !== "walk"
          ? getLineToken(firstLeg.routeId ?? firstLeg.lineId ?? null, themeMode).color
          : undefined,
      });
    }

    if (tripPlanView.destination?.lat != null && tripPlanView.destination?.lon != null) {
      labels.push({
        id: "trip-label-end",
        lat: tripPlanView.destination.lat,
        lon: tripPlanView.destination.lon,
        label: shortenStopLabel(tripPlanView.destination.label),
        kind: "end",
        fromColor: lastLeg && lastLeg.mode !== "walk"
          ? getLineToken(lastLeg.routeId ?? lastLeg.lineId ?? null, themeMode).color
          : undefined,
      });
    } else if (lastLeg?.to?.lat != null && lastLeg?.to?.lon != null) {
      labels.push({
        id: "trip-label-end",
        lat: lastLeg.to.lat,
        lon: lastLeg.to.lon,
        label: shortenStopLabel(lastLeg.to.name ?? lastLeg.to.label),
        kind: "end",
        fromColor: lastLeg.mode !== "walk"
          ? getLineToken(lastLeg.routeId ?? lastLeg.lineId ?? null, themeMode).color
          : undefined,
      });
    }

    legs.forEach((leg, index) => {
      if (index === 0) return;
      const point = leg.from;
      if (!point || typeof point.lat !== "number" || typeof point.lon !== "number") return;
      const prevLeg = legs[index - 1];
      const isWalkTransfer = leg.mode === "walk" || prevLeg?.mode === "walk";
      const fromColor =
        prevLeg && prevLeg.mode !== "walk"
          ? getLineToken(prevLeg.routeId ?? prevLeg.lineId ?? null, themeMode).color
          : undefined;
      const toColor =
        leg.mode !== "walk"
          ? getLineToken(leg.routeId ?? leg.lineId ?? null, themeMode).color
          : undefined;
      labels.push({
        id: `trip-label-transfer-${index}`,
        lat: point.lat,
        lon: point.lon,
        label: shortenStopLabel(point.name ?? point.label),
        kind: isWalkTransfer ? "walk" : "transfer",
        fromColor,
        toColor,
      });
    });

    return labels;
  }, [activeTripPlan, shortenStopLabel, themeMode, tripMode, tripPlanView.destination, tripPlanView.origin, viewState.zoom]);

  const tripStopIdSet = useMemo(() => {
    if (!activeTripPlan || tripMode === "HOME") return null;
    const ids = new Set<string>();
    activeTripPlan.legs.forEach((leg) => {
      if (leg.from?.stopId) ids.add(leg.from.stopId);
      if (leg.to?.stopId) ids.add(leg.to.stopId);
    });
    if (tripPlanView.origin?.stopId) ids.add(tripPlanView.origin.stopId);
    if (tripPlanView.destination?.stopId) ids.add(tripPlanView.destination.stopId);
    return ids.size > 0 ? ids : null;
  }, [activeTripPlan, tripMode, tripPlanView.destination?.stopId, tripPlanView.origin?.stopId]);

  const activeTripLineIds = useMemo<LineOptionId[]>(() => {
    if (!activeTripPlan || tripMode === "HOME") return [];
    const ids = new Set<LineOptionId>();
    activeTripPlan.legs.forEach((leg) => {
      if (leg.mode === "walk") return;
      const candidate = leg.routeId ?? leg.lineId ?? null;
      if (candidate && isLineOptionId(candidate)) {
        ids.add(candidate);
      }
    });
    return Array.from(ids);
  }, [activeTripPlan, tripMode]);

  const mapLineFilter = useMemo<LineOptionId[]>(() => {
    if (selectedLines.length > 0) return selectedLines;
    if (activeTripLineIds.length > 0) return activeTripLineIds;
    return [];
  }, [activeTripLineIds, selectedLines]);

  const lastTripFitRef = useRef<string | null>(null);

  const computeTripBounds = useCallback((plan: TripPlanView) => {
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    const addPoint = (lat?: number | null, lon?: number | null) => {
      if (typeof lat !== "number" || typeof lon !== "number") return;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
    };

    plan.legs.forEach((leg) => {
      addPoint(leg.from?.lat, leg.from?.lon);
      addPoint(leg.to?.lat, leg.to?.lon);
    });

    if (plan.map?.walkPolylines?.length) {
      plan.map.walkPolylines.forEach((encoded) => {
        const walkPath = decodePolyline(encoded);
        walkPath.forEach(([lon, lat]) => addPoint(lat, lon));
      });
    } else if (plan.map?.walkPolyline) {
      const walkPath = decodePolyline(plan.map.walkPolyline);
      walkPath.forEach(([lon, lat]) => addPoint(lat, lon));
    }

    if (plan.map?.lineShapes?.length) {
      plan.map.lineShapes.forEach((shape) => {
        if (!shape.polyline) return;
        const path = decodePolyline(shape.polyline);
        path.forEach(([lon, lat]) => addPoint(lat, lon));
      });
    }

    if (minLat === Infinity || minLon === Infinity || maxLat === -Infinity || maxLon === -Infinity) {
      const bounds = plan.map?.bounds;
      if (bounds) {
        const [[minLatCandidate, minLonCandidate], [maxLatCandidate, maxLonCandidate]] = bounds;
        if ([minLatCandidate, minLonCandidate, maxLatCandidate, maxLonCandidate].every((value) => Number.isFinite(value))) {
          return {
            minLat: minLatCandidate,
            minLon: minLonCandidate,
            maxLat: maxLatCandidate,
            maxLon: maxLonCandidate,
          };
        }
      }
      return null;
    }

    return { minLat, minLon, maxLat, maxLon };
  }, []);

  const focusLegSegment = useCallback(
    (tripId: string, legIndex: number, leg: TripPlannerLeg) => {
      const fromLat = leg.from?.lat;
      const fromLon = leg.from?.lon;
      const toLat = leg.to?.lat;
      const toLon = leg.to?.lon;
      if ([fromLat, fromLon, toLat, toLon].some((value) => typeof value !== "number")) return;
      requestMapFocus({
        id: `trip-leg-${tripId}-${legIndex}`,
        points: [
          { lat: fromLat as number, lng: fromLon as number },
          { lat: toLat as number, lng: toLon as number },
        ],
        scroll: false,
        priority: 2,
        kind: "leg",
      });
      const shouldUseStackedLayout = !isDesktop || Boolean(activeTripId);
      if (shouldUseStackedLayout && isMobile && mapSectionRef.current) {
        mapSectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },
    [activeTripId, isDesktop, isMobile, requestMapFocus],
  );

  const tripStopMarkers = useMemo(() => {
    if (!activeTripPlan) return [];
    type TripStopMarker = {
      key: string;
      lat: number;
      lon: number;
      label: string;
      kind: "primary" | "secondary";
      color: string;
    };
    const markers: TripStopMarker[] = [];
    const seen = new Set<string>();
    const addMarker = (lat?: number | null, lon?: number | null, label?: string | null, kind?: "primary" | "secondary", color?: string) => {
      if (typeof lat !== "number" || typeof lon !== "number") return;
      const key = `${lat.toFixed(6)}-${lon.toFixed(6)}-${label ?? ""}-${kind ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      markers.push({
        key,
        lat,
        lon,
        label: label ?? "Stop",
        kind: kind ?? "secondary",
        color: color ?? "rgba(148,163,184,1)",
      });
    };

    activeTripPlan.legs.forEach((leg) => {
      const token = leg.mode === "walk" ? null : getLineToken(leg.routeId ?? leg.lineId ?? null, themeMode);
      const markerColor = leg.mode === "walk" ? "rgba(148,163,184,1)" : token?.color ?? "rgba(148,163,184,1)";
      const isPrimary = leg.mode !== "walk";
      addMarker(leg.from?.lat, leg.from?.lon, leg.from?.name ?? leg.from?.label ?? "Board", isPrimary ? "primary" : "secondary", markerColor);
      addMarker(leg.to?.lat, leg.to?.lon, leg.to?.name ?? leg.to?.label ?? "Alight", isPrimary ? "primary" : "secondary", markerColor);
    });

    if (tripPlanView.origin) {
      addMarker(tripPlanView.origin.lat, tripPlanView.origin.lon, tripPlanView.origin.label ?? "Start", "primary", "rgba(56,189,248,1)");
    }
    if (tripPlanView.destination) {
      addMarker(tripPlanView.destination.lat, tripPlanView.destination.lon, tripPlanView.destination.label ?? "Destination", "primary", "rgba(34,197,94,1)");
    }

    return markers;
  }, [activeTripPlan, themeMode, tripPlanView.destination, tripPlanView.origin]);

  const tripStopMarkersGeojson = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: tripStopMarkers.map((marker) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [marker.lon, marker.lat] as [number, number],
        },
        properties: {
          label: marker.label,
          kind: marker.kind,
          color: marker.color,
        },
      })),
    }),
    [tripStopMarkers],
  );


  useEffect(() => {
    if (!mapReady || !activeTripPlan || isFollowingTrip) return;
    if (lastTripFitRef.current === activeTripPlan.tripId) return;
    const bounds = computeTripBounds(activeTripPlan);
    if (!bounds) return;
    lastTripFitRef.current = activeTripPlan.tripId;
    fitMapToBounds(
      [
        [bounds.minLon, bounds.minLat],
        [bounds.maxLon, bounds.maxLat],
      ],
      {
        padding: getMapPadding(false),
        duration: 400,
        fallbackCenter: [(bounds.minLon + bounds.maxLon) / 2, (bounds.minLat + bounds.maxLat) / 2],
        fallbackZoom: 12,
      },
    );
  }, [activeTripPlan, computeTripBounds, fitMapToBounds, getMapPadding, isFollowingTrip, mapReady]);

  useEffect(() => {
    if (tripMode !== "TRIP_EDITING") return;
    if (!tripPlanView.origin || !tripPlanView.destination) {
      lastPlannedKeyRef.current = null;
      return;
    }
    const modeKey = tripModeFilters.slice().sort().join("|");
    const key = `${tripPlanView.origin.lat},${tripPlanView.origin.lon}-${tripPlanView.destination.lat},${tripPlanView.destination.lon}-${modeKey}`;
    if (lastPlannedKeyRef.current === key) return;
    lastPlannedKeyRef.current = key;
    void handleTripPlanSubmit();
  }, [handleTripPlanSubmit, tripMode, tripPlanView.destination, tripPlanView.origin, tripModeFilters]);

  

  const homeData = homeQuery.data;
  const hasHomeStops = Boolean(homeData && (homeData.nearby.length > 0 || homeData.favorites.length > 0));
  const homeError = homeQuery.isError && !hasHomeStops ? (homeQuery.error as Error) : null;
  const homeFetching = homeQuery.isFetching && !hasHomeStops;
  const buildFallbackRoutes = useCallback((routes: string[]): HomeStopSummary["routes"] => {
    return routes.map((routeId) => ({
      routeId,
      shortName: routeId,
      direction: "",
      directionId: null,
      nextTimes: [],
    }));
  }, []);
  const buildFallbackSummary = useCallback(
    (station: StationSummary): HomeStopSummary => {
      const distance =
        Number.isFinite(position.lat) && Number.isFinite(position.lng)
          ? metersBetween(position.lat, position.lng, station.latitude, station.longitude)
          : Number.POSITIVE_INFINITY;
      const modes = (station.modesServed ?? []).filter((mode): mode is Mode => mode !== "all");
      return {
        stopId: station.stopId,
        name: station.name,
        distanceMeters: distance,
        modes,
        routes: buildFallbackRoutes(station.routesServing ?? []),
        platformStopIds: station.platformStopIds?.length ? station.platformStopIds : [station.stopId],
      };
    },
    [buildFallbackRoutes, position.lat, position.lng],
  );
  const fallbackNearby = useMemo(() => {
    if (!stationsData || stationsData.length === 0) return [];
    return stationsData
      .filter((station) => Number.isFinite(station.latitude) && Number.isFinite(station.longitude))
      .map((station) => buildFallbackSummary(station))
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, 24);
  }, [buildFallbackSummary, stationsData]);
  const fallbackFavorites = useMemo(() => {
    if (!stationsData || stationsData.length === 0 || favoriteIds.length === 0) return [];
    const stationMap = new Map(stationsData.map((station) => [station.stopId, station]));
    return favoriteIds
      .map((id) => stationMap.get(id))
      .filter((station): station is StationSummary => Boolean(station))
      .map((station) => buildFallbackSummary(station));
  }, [buildFallbackSummary, favoriteIds, stationsData]);
  const normalizedSearch = useMemo(() => stopSearch.trim().toLowerCase(), [stopSearch]);
  const filterLines = isStopSheetOpen && prevSelectedLinesRef.current ? prevSelectedLinesRef.current : mapLineFilter;
  const lineFiltersActive = filterLines.length > 0;
  const searchActive = normalizedSearch.length >= 2;
    const matchesLineFilters = useCallback(
    (stop: HomeStopSummary) => {
      if (!stopSupportsSelectedLines(stop, filterLines)) return false;
      if (stop.routes.length === 0) return true;
      return stop.routes.some((route) => {
        const isBus = routeLooksLikeBus(route.routeId ?? route.shortName);
        const isCommuterRail = candidateMatchesLineId(route.routeId ?? route.shortName, "CommuterRail");
        if (isBus) return activeModeFilters.has("bus");
        if (isCommuterRail) return activeModeFilters.has("commuter_rail");
        return activeModeFilters.has("subway");
      });
    },
    [activeModeFilters, filterLines],
  );
  const stationMarkers = useMemo<StationMarker[]>(() => {
    if (!stationsData) return [];
    const busToken = getLineToken("Bus", themeMode);
    const limitToFollowStops = Boolean(activeTripId && followFocusStopSet && followFocusStopSet.size > 0);
    const limitToTripStops = tripMode !== "HOME" && activeTripPlan;
    const tripRouteTokenId = activeTripRouteId ? getLineToken(activeTripRouteId, themeMode).id : null;
    const effectiveSelectedLines = tripRouteTokenId
      ? Array.from(new Set<LineOptionId>([...mapLineFilter, tripRouteTokenId as LineOptionId]))
      : mapLineFilter;
    return stationsData.flatMap((station) => {
      if (limitToTripStops) {
        if (!tripStopIdSet || tripStopIdSet.size === 0) return [];
        const matchesTripStop =
          tripStopIdSet.has(station.stopId) ||
          (station.platformStopIds ?? []).some((platformStopId) => tripStopIdSet.has(platformStopId));
        if (!matchesTripStop) return [];
      }
      if (!stationSupportsSelectedLines(station.routesServing, effectiveSelectedLines)) {
        return [];
      }
      if (limitToFollowStops && !followFocusStopSet?.has(station.stopId)) {
        // When following a trip, still show stations that belong to the trip's route
        if (tripRouteTokenId) {
          const servesTripRoute = (station.routesServing ?? []).some((r) =>
            candidateMatchesLineId(r, tripRouteTokenId as LineOptionId),
          );
          if (!servesTripRoute) return [];
        } else {
          return [];
        }
      }
      if (!limitToFollowStops && normalizedSearch.length > 0) {
        const normalizedName = station.name.toLowerCase();
        const hasNameMatch = normalizedName.includes(normalizedSearch);
        const hasRouteMatch = station.routesServing?.some((route) => route.toLowerCase().includes(normalizedSearch));
        if (!hasNameMatch && !hasRouteMatch) {
          return [];
        }
      }
      const tokens = Array.from(
        new Map(
          (station.routesServing ?? [])
            .map((route) => getLineToken(route, themeMode))
            .map((token) => [token.id, token]),
        ).values(),
      );
      const candidateTokens = tokens.length > 0 ? tokens : [busToken];
      const sortedTokens = [...candidateTokens].sort((a, b) => getLinePriority(b) - getLinePriority(a));
      const dominantToken = sortedTokens[0] ?? busToken;
      const isBusOnly = station.modesServed.length === 1 && station.modesServed.includes("bus");
      const color = dominantToken.color;
      const dotStyle = buildDotStyle(sortedTokens.map((token) => token.color)) ?? undefined;
      const isFollowStop = followFocusStopSet?.has(station.stopId) ?? false;
      const isSelected = station.stopId === selectedStopId || isFollowStop;
      const platformStopIds = (station.platformStopIds && station.platformStopIds.length > 0
        ? station.platformStopIds
        : [station.stopId]).filter((stopId) => !isNonBoardableStopId(stopId));
      if (platformStopIds.length === 0) {
        return [];
      }
      const platformStopIdSet = new Set(platformStopIds);
      const isParentStation = station.stopId.startsWith("place-");
      const rawMarkers = isParentStation
        ? [
            {
              stopId: station.stopId,
              name: station.name,
              latitude: station.latitude,
              longitude: station.longitude,
            },
          ]
        : station.platformMarkers && station.platformMarkers.length > 0
        ? station.platformMarkers
        : [
            {
              stopId: station.stopId,
              name: station.name,
              latitude: station.latitude,
              longitude: station.longitude,
            },
          ];
      const validMarkers = rawMarkers.filter(
        (marker) =>
          Number.isFinite(marker.latitude) &&
          Number.isFinite(marker.longitude) &&
          !isNonBoardableStopId(marker.stopId) &&
          (isParentStation || platformStopIdSet.has(marker.stopId)),
      );
      const seenCoords = new Set<string>();
      const dedupedMarkers = validMarkers.filter((marker) => {
        const key = `${station.stopId}-${marker.latitude.toFixed(5)}-${marker.longitude.toFixed(5)}`;
        if (seenCoords.has(key)) return false;
        seenCoords.add(key);
        return true;
      });
      if (
        dedupedMarkers.length === 0 &&
        Number.isFinite(station.latitude) &&
        Number.isFinite(station.longitude)
      ) {
        dedupedMarkers.push({
          stopId: station.stopId,
          name: station.name,
          latitude: station.latitude,
          longitude: station.longitude,
        });
      }
        return dedupedMarkers.map((marker) => ({
          markerKey: `${station.stopId}-${marker.stopId}`,
          markerStopId: marker.stopId,
          stopId: station.stopId,
          platformStopIds,
          name: marker.name ?? station.name,
          latitude: marker.latitude,
          longitude: marker.longitude,
          color,
          dotStyle,
          isSelected,
          routesServing: station.routesServing,
          zIndex: isBusOnly ? 10 : 20,
          isBusOnly,
        }));
    });
  }, [activeTripId, activeTripPlan, activeTripRouteId, followFocusStopSet, normalizedSearch, mapLineFilter, stationsData, selectedStopId, themeMode, tripMode, tripStopIdSet]);

  const stationMarkersGeojson = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: stationMarkers.map((marker) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [marker.longitude, marker.latitude] as [number, number],
        },
        properties: {
          markerStopId: marker.markerStopId,
          stopId: marker.stopId,
          name: marker.name,
          color: marker.color,
          isBusOnly: marker.isBusOnly,
          isSelected: marker.isSelected,
          routesServing: JSON.stringify(marker.routesServing ?? []),
          platformStopIds: JSON.stringify(marker.platformStopIds ?? []),
        },
      })),
    }),
    [stationMarkers],
  );

  useEffect(() => {
    if (suggestedHubsFocusAppliedRef.current) return;
    if (!mapReady) return;
    if (!homeData) return;
    if (activeTripId) return;
    if (isStopSheetOpen) return;
    if (tripMode !== "HOME") return;
    if (userMapInteractedRef.current) return;
    if (homeData.nearby.length === 0) return;

    const minDistance = homeData.nearby.reduce((best, stop) => Math.min(best, stop.distanceMeters), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(minDistance) || minDistance <= 50_000) return;

    const focusPoints: FocusPoint[] = homeData.nearby
      .map((stop) => {
        const station = stationLookup.get(stop.stopId);
        if (!station) return null;
        return { lat: station.latitude, lng: station.longitude };
      })
      .filter((point): point is FocusPoint => Boolean(point))
      .slice(0, 6);

    if (focusPoints.length === 0) return;

    const distanceFromMap = metersBetween(viewState.latitude, viewState.longitude, focusPoints[0].lat, focusPoints[0].lng);
    if (!Number.isFinite(distanceFromMap) || distanceFromMap <= 50_000) {
      suggestedHubsFocusAppliedRef.current = true;
      return;
    }

    requestMapFocus({ id: "suggested-hubs", points: focusPoints, scroll: false, priority: 1, kind: "suggested" });
    suggestedHubsFocusAppliedRef.current = true;
  }, [activeTripId, homeData, isStopSheetOpen, mapReady, requestMapFocus, stationLookup, viewState.latitude, viewState.longitude, tripMode]);

  const vehicleIsBus = routeLooksLikeBus(activeTripRouteId);
  const vehicleLineToken = useMemo(
    () => getLineToken(activeTripRouteId, themeMode),
    [activeTripRouteId, themeMode],
  );
  const vehicleMarkerAccent = vehicleLineToken.color;
  const vehicleMarkerGlow = vehicleLineToken.tint;
  const vehicleMarkerHalo = vehicleLineToken.border;
  const vehicleMarkerCore = themeMode === "dark" ? "#020617" : "#f8fafc";
  const preferStackedLayout = isFollowingTrip || !isDesktop;
  const mapVisibility = useMapVisibility({
    mapUiMode,
    hasActiveTripPlan: Boolean(activeTripPlan),
    isFollowingTrip,
  });
  const interactiveLayerIds = useMemo(() => {
    if (!mapVisibility.showStationMarkers) return [];
    return [STATION_MARKER_LAYER_ID, STATION_MARKER_SELECTED_LAYER_ID, STATION_MARKER_HOVER_LAYER_ID];
  }, [mapVisibility.showStationMarkers]);
  const showTripLabels = Boolean(activeTripPlan && tripMode !== "HOME" && !isFollowingTrip && viewState.zoom >= TRIP_LABEL_MIN_ZOOM);

  useEffect(() => {
    if (!mapReady) return;
    if (filteredLineShapes.length === 0) return;
    const map = mapRef.current?.getMap?.();
    if (!map) return;
    const { sourceId, layerId } = lineShapeLayerIdsRef.current;
    const buildData = () => {
      if (tripMode !== "HOME" && activeTripPlan) {
        return { type: "FeatureCollection" as const, features: [] };
      }
      const features = filteredLineShapes.flatMap((line) => {
        const commuterRailColor = getLineToken("CommuterRail", themeMode).color;
        const fallbackColor = line.id === "CommuterRail" ? commuterRailColor : "#666666";
        const colorHex = line.id === "CommuterRail" ? commuterRailColor : line.color ?? fallbackColor;
        const isActive = mapLineFilter.length === 0 || mapLineFilter.includes(line.id);
        const isSelectedLine = isStopSheetOpen && selectedStopId != null && selectedLines.includes(line.id);
        const stopHighlightMode = isStopSheetOpen && selectedLines.length > 0;
        const widthWhenEmpty = 2;
        const baseAlpha = mapLineFilter.length === 0 ? 160 : isActive ? 230 : 70;
        const focusedAlpha = stopHighlightMode ? (isSelectedLine ? 230 : 20) : baseAlpha;
        const alpha = tripMode === "HOME" ? focusedAlpha : Math.round(focusedAlpha * 0.35);
        const lineWidth = mapLineFilter.length === 0 ? widthWhenEmpty : isSelectedLine ? 4 : isActive ? 3 : 1;
        const lineOpacity = Math.max(0.05, Math.min(1, alpha / 255));
        return line.shapes.map((path, index) => ({
          type: "Feature" as const,
          id: `${line.id}-${index}`,
          properties: {
            color: colorHex,
            width: lineWidth,
            opacity: lineOpacity,
          },
          geometry: {
            type: "LineString" as const,
            coordinates: path.map((coord) => [coord.lng, coord.lat]),
          },
        }));
      });
      return { type: "FeatureCollection" as const, features };
    };

    const ensureLayer = () => {
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, {
          type: "geojson",
          data: buildData(),
        });
      }
      if (!map.getLayer(layerId)) {
        map.addLayer({
          id: layerId,
          type: "line",
          source: sourceId,
          layout: {
            "line-cap": "round",
            "line-join": "round",
          },
          paint: {
            "line-color": ["get", "color"],
            "line-width": ["get", "width"],
            "line-opacity": ["get", "opacity"],
          },
        });
      }
    };

    if (map.isStyleLoaded()) {
      ensureLayer();
    } else {
      const handler = () => {
        ensureLayer();
      };
      map.once("styledata", handler);
    }

    const source = map.getSource(sourceId) as GeoJSONSource | undefined;
    if (source) {
      source.setData(buildData());
    }

    return () => {
      const cleanupMap = map;
      if (!cleanupMap || typeof cleanupMap.getLayer !== "function") return;
      try {
        if (cleanupMap.getLayer(layerId)) cleanupMap.removeLayer(layerId);
        if (cleanupMap.getSource(sourceId)) cleanupMap.removeSource(sourceId);
      } catch {
        // Map was destroyed during cleanup
      }
    };
  }, [activeTripPlan, filteredLineShapes, isStopSheetOpen, mapLineFilter, mapReady, selectedLines, selectedStopId, themeMode, tripMode]);

  useEffect(() => {
    if (!mapReady) return;
    if (!activeTripPlan || tripMode === "HOME") return;
    const map = mapRef.current?.getMap?.();
    if (!map) return;
    const { sourceId, layerId } = tripLineLayerIdsRef.current;
    const buildData = () => {
      const features: Array<{
        type: "Feature";
        id: string;
        properties: { color: string; width: number; opacity: number };
        geometry: { type: "LineString"; coordinates: [number, number][] };
      }> = [];

      const walkPolylines = activeTripPlan.map.walkPolylines?.length
        ? activeTripPlan.map.walkPolylines
        : activeTripPlan.map.walkPolyline
          ? [activeTripPlan.map.walkPolyline]
          : [];
      const hasWalkPolylines = walkPolylines.length > 0;
      const lineShapeRoutes = new Set(
        (activeTripPlan.map.lineShapes ?? [])
          .map((shape) => shape.lineId)
          .filter((lineId): lineId is string => Boolean(lineId)),
      );

      const lineSegments =
        activeTripPlan.map.lineShapes?.flatMap((shape, index) => {
          if (!shape.polyline) return [];
          const path = decodePolyline(shape.polyline);
          if (path.length < 2) return [];
          return [
            {
              id: `${shape.lineId}-${index}`,
              color: shape.color ?? getLineToken(shape.lineId, themeMode).color,
              width: 4,
              opacity: 0.9,
              path,
            },
          ];
        }) ?? [];

      if (lineSegments.length > 0) {
        lineSegments.forEach((segment) => {
          features.push({
            type: "Feature",
            id: `trip-line-${segment.id}`,
            properties: {
              color: segment.color,
              width: segment.width,
              opacity: segment.opacity,
            },
            geometry: {
              type: "LineString",
              coordinates: segment.path,
            },
          });
        });
        activeTripPlan.legs.forEach((leg, idx) => {
          const fromLat = leg.from?.lat;
          const fromLon = leg.from?.lon;
          const toLat = leg.to?.lat;
          const toLon = leg.to?.lon;
          if ([fromLat, fromLon, toLat, toLon].some((value) => typeof value !== "number")) return;
          const routeKey = leg.routeId ?? leg.lineId ?? "";
          if (leg.mode === "walk") {
            if (hasWalkPolylines) return;
          } else if (routeKey && lineShapeRoutes.has(routeKey)) {
            return;
          }
          const token = leg.mode === "walk" ? null : getLineToken(routeKey || null, themeMode);
          const color = leg.mode === "walk" ? "rgba(148,163,184,1)" : token?.color ?? "#94a3b8";
          const width = leg.mode === "walk" ? 2 : 4;
          const opacity = leg.mode === "walk" ? 0.65 : 0.95;
          features.push({
            type: "Feature",
            id: `trip-leg-fallback-${idx}`,
            properties: { color, width, opacity },
            geometry: {
              type: "LineString",
              coordinates: [
                [fromLon as number, fromLat as number],
                [toLon as number, toLat as number],
              ],
            },
          });
        });
      } else {
        activeTripPlan.legs.forEach((leg, idx) => {
          const fromLat = leg.from?.lat;
          const fromLon = leg.from?.lon;
          const toLat = leg.to?.lat;
          const toLon = leg.to?.lon;
          if ([fromLat, fromLon, toLat, toLon].some((value) => typeof value !== "number")) return;
          const token = leg.mode === "walk" ? null : getLineToken(leg.routeId ?? leg.lineId ?? null, themeMode);
          const color = leg.mode === "walk" ? "rgba(148,163,184,1)" : token?.color ?? "#94a3b8";
          const width = leg.mode === "walk" ? 2 : 4;
          const opacity = leg.mode === "walk" ? 0.65 : 0.95;
          features.push({
            type: "Feature",
            id: `trip-leg-${idx}`,
            properties: { color, width, opacity },
            geometry: {
              type: "LineString",
              coordinates: [
                [fromLon as number, fromLat as number],
                [toLon as number, toLat as number],
              ],
            },
          });
        });
      }

      walkPolylines.forEach((encoded, idx) => {
        const path = decodePolyline(encoded);
        if (path.length < 2) return;
        features.push({
          type: "Feature",
          id: `trip-walk-${idx}`,
          properties: { color: "rgba(176,186,196,1)", width: 2, opacity: 0.75 },
          geometry: { type: "LineString", coordinates: path },
        });
      });

      return { type: "FeatureCollection" as const, features };
    };

    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, { type: "geojson", data: buildData() });
    }
    if (!map.getLayer(layerId)) {
      map.addLayer({
        id: layerId,
        type: "line",
        source: sourceId,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["get", "width"],
          "line-opacity": ["get", "opacity"],
        },
      });
    }

    const source = map.getSource(sourceId) as GeoJSONSource | undefined;
    if (source) {
      source.setData(buildData());
    }

    return () => {
      const cleanupMap = map;
      if (!cleanupMap || typeof cleanupMap.getLayer !== "function") return;
      try {
        if (cleanupMap.getLayer(layerId)) cleanupMap.removeLayer(layerId);
        if (cleanupMap.getSource(sourceId)) cleanupMap.removeSource(sourceId);
      } catch {
        // Map was destroyed during cleanup
      }
    };
  }, [activeTripPlan, mapReady, themeMode, tripMode]);

  const showTripOptionsPanel =
    tripMode !== "HOME" &&
    (tripMode === "TRIP_PLANNING" ||
      tripMode === "TRIP_EDITING" ||
      tripMode === "TRIP_READY" ||
      tripMode === "TRIP_ERROR" ||
      tripPlanView.plans.length > 0 ||
      Boolean(tripPlanError));
  const layoutBaseClass = preferStackedLayout
    ? "mx-auto grid w-full max-w-7xl flex-1 gap-3 px-4 pb-4 pt-1 sm:px-6 sm:py-6"
    : "mx-auto grid w-full max-w-7xl flex-1 gap-6 px-4 sm:px-6 pb-6 pt-1 sm:py-6";
  const stackedLayoutClass = layoutBaseClass;
  const splitLayoutClass = `${layoutBaseClass} lg:grid-cols-[340px_minmax(0,1fr)] lg:items-start`;
  const layoutClass = preferStackedLayout ? stackedLayoutClass : splitLayoutClass;
  const { mapPanelHeight, mapPanelMaxHeight, mobileSheetHeight } = useResponsiveMapHeights({
    preferStackedLayout,
    breakpointInfo,
  });

  useEffect(() => {
    if (!preferStackedLayout || !isMobile) return;
    if (isStopSheetOpen) {
      setMobileFocusMode("details");
    }
  }, [isMobile, isStopSheetOpen, preferStackedLayout]);

  useEffect(() => {
    if (preferStackedLayout) {
      setIsTripTimelineOpen(true);
    }
  }, [preferStackedLayout]);
  useEffect(() => {
    if (!preferStackedLayout || !isMobile) return;
    if (tripMode === "TRIP_PLANNING") return;
    if (tripPlanView.plans.length === 0) return;
    setIsTripTimelineOpen(true);
    const node = tripTimelineRef.current;
    if (!node) return;
    requestAnimationFrame(() => {
      node.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [isMobile, preferStackedLayout, tripMode, tripPlanView.plans.length]);
  const effectiveMapPanelHeight =
    preferStackedLayout && isMobile
      ? mobileFocusMode === "map"
        ? "72vh"
        : mapPanelHeight
      : mapPanelHeight;
  const baseMobileSheetHeight =
    preferStackedLayout && isMobile
      ? mobileFocusMode === "map"
        ? "28vh"
        : mobileSheetHeight
      : mobileSheetHeight;
  const effectiveMobileSheetHeight =
    preferStackedLayout && isStopSheetOpen
      ? isMobile
        ? mobileFocusMode === "map"
          ? "40vh"
          : "90vh"
        : "90vh"
      : baseMobileSheetHeight;

  useEffect(() => {
    const mapInstance = mapRef.current?.getMap?.();
    if (!mapInstance) return;
    try {
      mapInstance.resize();
    } catch {
      // ignore resize errors
    }
  }, [effectiveMapPanelHeight, isDesktop, preferStackedLayout]);

  const favoriteStops = useMemo(() => {
    const combined = hasHomeStops && homeData ? [...homeData.favorites, ...homeData.nearby] : fallbackFavorites;
    const uniqueMap = new Map<string, HomeStopSummary>();
    combined.forEach((stop) => {
      uniqueMap.set(stop.stopId, stop);
    });
    return favoriteIds
      .map((id) => uniqueMap.get(id))
      .filter((stop): stop is HomeStopSummary => Boolean(stop));
  }, [fallbackFavorites, favoriteIds, hasHomeStops, homeData]);
  const nearbyStops = useMemo(() => (hasHomeStops && homeData ? homeData.nearby : fallbackNearby), [fallbackNearby, hasHomeStops, homeData]);
  const filteredFavorites = useMemo(() => favoriteStops.filter(matchesLineFilters), [favoriteStops, matchesLineFilters]);
  const filteredNearby = useMemo(() => nearbyStops.filter(matchesLineFilters), [nearbyStops, matchesLineFilters]);
  const favoritesFilteredOut = lineFiltersActive && favoriteStops.length > 0 && filteredFavorites.length === 0;
  const nearbyFilteredOut = lineFiltersActive && nearbyStops.length > 0 && filteredNearby.length === 0;
  const allStopsSearchResults = useMemo(() => {
    if (!stationsData || !searchActive) return [];
    const results: Array<{
      summary: HomeStopSummary;
      nameIndex: number;
      nameLength: number;
      distance: number;
    }> = [];
	    stationsData.forEach((station) => {
	      if (!stationSupportsSelectedLines(station.routesServing ?? [], filterLines)) return;
	      const name = station.name ?? "";
	      const nameLower = name.toLowerCase();
	      const nameIndex = nameLower.indexOf(normalizedSearch);
	      if (nameIndex === -1) return;
      if (!Number.isFinite(station.latitude) || !Number.isFinite(station.longitude)) return;
      const distance = Number.isFinite(position.lat) && Number.isFinite(position.lng)
        ? metersBetween(position.lat, position.lng, station.latitude, station.longitude)
        : Number.POSITIVE_INFINITY;
      const modes = (station.modesServed ?? []).filter((mode): mode is Mode => mode !== "all");
      results.push({
        summary: {
          stopId: station.stopId,
          name: station.name,
          distanceMeters: distance,
          modes,
          routes: [],
          platformStopIds: station.platformStopIds?.length ? station.platformStopIds : [station.stopId],
        },
        nameIndex: nameIndex === -1 ? 9999 : nameIndex,
        nameLength: name.length,
        distance,
      });
    });
    results.sort((a, b) => {
      if (a.nameIndex !== b.nameIndex) return a.nameIndex - b.nameIndex;
      if (a.nameLength !== b.nameLength) return a.nameLength - b.nameLength;
      return a.distance - b.distance;
    });
    return results.map((entry) => entry.summary);
  }, [filterLines, normalizedSearch, position.lat, position.lng, searchActive, stationsData]);

  const startFollowingTrip = useCallback(
    async (tripId: string | null) => {
      if (!tripId || followStartLoading) return;
      setFollowStartError(null);
      setFollowStartLoading(true);
      let canFollow = false;
      try {
        const track = await fetchTripTrack(tripId);
        if (!track?.vehicle?.position) {
          setFollowStartError("Vehicle location unavailable. MBTA real-time feed may be missing this trip.");
        } else {
          canFollow = true;
        }
      } catch {
        setFollowStartError("Trip tracking unavailable right now. MBTA v3 may not have data for this trip.");
      } finally {
        setFollowStartLoading(false);
      }
      if (!canFollow) return;
      mapViewBeforeSheetRef.current = null;
      setFollowResumeContext({
        stopId: selectedStopId,
        name: selectedStopName,
        platformStopIds: selectedPlatformStopIds ?? null,
      });
      setIsStopSheetOpen(false);
      setSelectedStopId(null);
      setSelectedStopName(null);
      setSelectedPlatformStopIds(null);
      setActiveTripId(tripId);
      clearMapFocus();
    },
    [
      clearMapFocus,
      followStartLoading,
      selectedPlatformStopIds,
      selectedStopId,
      selectedStopName,
      setIsStopSheetOpen,
      setSelectedPlatformStopIds,
      setSelectedStopId,
    ],
  );

  const toggleFavorite = (stopId: string) => {
    setFavoriteIds((prev) => (prev.includes(stopId) ? prev.filter((id) => id !== stopId) : [...prev, stopId]));
  };

  const selectLineGroup = useCallback(
    (lineId: LineOptionId, mode: "toggle" | "exclusive" = "toggle") => {
      const group = lineId.startsWith("Green-") ? GREEN_LINE_GROUP : [lineId];
      setSelectedLines((prev) => {
        if (mode === "exclusive") {
          return [...group];
        }
        const hasGroup = group.every((id) => prev.includes(id));
        if (hasGroup) {
          return prev.filter((id) => !group.includes(id));
        }
        const next = new Set(prev);
        group.forEach((id) => next.add(id));
        return Array.from(next);
      });
    },
    [],
  );

  const toggleLineFilterSingle = useCallback((lineId: LineOptionId) => {
    setSelectedLines((prev) => {
      if (prev.includes(lineId)) {
        return prev.filter((id) => id !== lineId);
      }
      return [...prev, lineId];
    });
  }, []);

  const applyLocation = useCallback(
    (lat: number, lng: number, label?: string | null) => {
      setPosition({ lat, lng });
      setViewState((prev) => ({ ...prev, latitude: lat, longitude: lng }));
      if (label) {
        setSelectedStopName(label);
      }
    },
    [],
  );

  const requestDeviceLocation = useCallback(
    async ({ centerMap }: { centerMap?: boolean } = {}) => {
      if (!navigator.geolocation) {
        setDeviceLocationError("This browser doesn’t support device location.");
        return;
      }

      setIsRequestingDeviceLocation(true);
      setDeviceLocationError(null);

      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10_000 });
        });
        const { latitude, longitude } = pos.coords;
        applyLocation(latitude, longitude);
        if (centerMap) {
          centerMapOnCoordinates(latitude, longitude);
        }
      } catch (error) {
        const geoError = error as Partial<GeolocationPositionError>;
        const code = geoError.code;
        if (code === 1) {
          setDeviceLocationError("Location access is blocked. Enable it in your browser settings, then try again.");
          return;
        }
        if (code === 2) {
          setDeviceLocationError("Couldn’t determine your location. Try again.");
          return;
        }
        if (code === 3) {
          setDeviceLocationError("Location request timed out. Try again.");
          return;
        }
        setDeviceLocationError("Unable to fetch your location.");
      } finally {
        setIsRequestingDeviceLocation(false);
      }
    },
    [applyLocation, centerMapOnCoordinates],
  );

  useEffect(() => {
    if (deviceLocationPref !== "on") return;
    if (geoPermissionState !== "granted") return;
    void requestDeviceLocation({ centerMap: false });
  }, [deviceLocationPref, geoPermissionState, requestDeviceLocation]);

  const openDeviceLocationModal = useCallback(() => {
    setIsDeviceLocationModalOpen(true);
  }, []);

  useEffect(() => {
    const openLocation = searchParams.get("openLocation");
    if (!openLocation) return;

    setIsDeviceLocationModalOpen(true);

    const params = new URLSearchParams(searchParams.toString());
    params.delete("openLocation");
    const next = params.toString();
    router.replace(next ? `/?${next}` : "/");
  }, [router, searchParams]);

  useEffect(() => {
    const openTrip = searchParams.get("trip");
    if (!openTrip) return;

    setTripPlanError(null);
    setTripPlanNotice(null);
    setTripMode("TRIP_EDITING");
    window.setTimeout(() => originInputRef.current?.focus(), 0);

    const params = new URLSearchParams(searchParams.toString());
    params.delete("trip");
    const next = params.toString();
    router.replace(next ? `/?${next}` : "/");
  }, [router, searchParams, setTripMode]);

  const handleUseDeviceLocation = useCallback(() => {
    setDeviceLocationPref("on");
    if (geoPermissionState === "granted") {
      void requestDeviceLocation({ centerMap: true });
      return;
    }
    openDeviceLocationModal();
  }, [geoPermissionState, openDeviceLocationModal, requestDeviceLocation]);

  useEffect(() => {
    if (!isDeviceLocationModalOpen) return;
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === "Escape") setIsDeviceLocationModalOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isDeviceLocationModalOpen]);

  const recenterMap = useCallback(() => {
    if (!mapReady || !mapRef.current) return;
    const closestStations =
      stationsData && stationsData.length > 0
        ? [...stationsData]
            .map((station) => ({
              station,
              distance: metersBetween(position.lat, position.lng, station.latitude, station.longitude),
            }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 6)
            .map(({ station }) => station)
        : [];
    const focusTargets: { lat: number; lng: number }[] = closestStations
      .map((station) => ({ lat: station.latitude, lng: station.longitude }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
    if (Number.isFinite(position.lat) && Number.isFinite(position.lng)) {
      focusTargets.push({ lat: position.lat, lng: position.lng });
    }
    if (focusTargets.length === 0) {
      return;
    }
    if (focusTargets.length === 1) {
      const only = focusTargets[0];
      mapRef.current.flyTo({
        center: [only.lng, only.lat],
        zoom: 14,
        duration: 800,
      });
      setHasCenteredMap(true);
      return;
    }
    const latitudes = focusTargets.map((point) => point.lat);
    const longitudes = focusTargets.map((point) => point.lng);
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...longitudes), Math.min(...latitudes)],
      [Math.max(...longitudes), Math.max(...latitudes)],
    ];

    const avgLat = latitudes.reduce((sum, lat) => sum + lat, 0) / latitudes.length;
    const avgLng = longitudes.reduce((sum, lng) => sum + lng, 0) / longitudes.length;
    fitMapToBounds(bounds, {
      padding: 120,
      duration: 800,
      fallbackCenter: [avgLng, avgLat],
      fallbackZoom: 13,
    });
    setHasCenteredMap(true);
  }, [fitMapToBounds, mapReady, position.lat, position.lng, stationsData]);

  useEffect(() => {
    setHasCenteredMap(false);
  }, [position.lat, position.lng]);

  useEffect(() => {
    if (!mapReady) return;
    if (!hasCenteredMap && stationsData && stationsData.length > 0) {
      recenterMap();
    }
  }, [hasCenteredMap, mapReady, recenterMap, stationsData]);

  useEffect(() => {
    if (!activeTripId || !tripTrackQuery.data?.vehicle) return;
    const { position } = tripTrackQuery.data.vehicle;
    if (position.lat == null || position.lng == null) return;
    const targets: { lat: number; lng: number }[] = [{ lat: position.lat, lng: position.lng }];
    const nextStops = tripTrackQuery.data.upcomingStops.slice(0, 2);
    nextStops.forEach((stop) => {
      const station = stationsData?.find((s) => s.stopId === stop.stopId);
      if (station) {
        targets.push({ lat: station.latitude, lng: station.longitude });
      }
    });
    if (targets.length === 0) return;
    if (!mapReady || !mapRef.current) return;

    const map = mapRef.current.getMap();
    const followZoom = 14.5;
    if (targets.length === 1) {
      map.easeTo({
        center: [position.lng, position.lat],
        zoom: Math.max(map.getZoom(), followZoom),
        duration: 800,
      });
      return;
    }

    const latitudes = targets.map((point) => point.lat);
    const longitudes = targets.map((point) => point.lng);
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...longitudes), Math.min(...latitudes)],
      [Math.max(...longitudes), Math.max(...latitudes)],
    ];
    const spanMeters = metersBetween(latitudes[0] ?? position.lat, longitudes[0] ?? position.lng, latitudes[1] ?? position.lat, longitudes[1] ?? position.lng);
    if (spanMeters < 1200) {
      map.easeTo({
        center: [position.lng, position.lat],
        zoom: Math.max(map.getZoom(), followZoom),
        duration: 800,
      });
      return;
    }

    fitMapToBounds(bounds, {
      padding: 120,
      duration: 800,
      fallbackCenter: [targets[0].lng, targets[0].lat],
      fallbackZoom: 14,
      maxZoom: 15,
    });
  }, [activeTripId, fitMapToBounds, mapReady, stationsData, tripTrackQuery.data]);

  const handleMapClick = useCallback(
    (evt: MapLayerMouseEvent) => {
      if (!lineSegmentIndex.segments.length) return;
      const now = performance.now();
      if (now - lastLineSelectAtRef.current < LINE_SELECT_THROTTLE_MS) return;
      lastLineSelectAtRef.current = now;
      const { lng, lat } = evt.lngLat;
      const point = { lat, lng };
      let nearest: { lineId: LineOptionId; distance: number } | null = null;
      const size = lineSegmentIndex.size;
      const latCell = Math.floor(lat / size);
      const lngCell = Math.floor(lng / size);
      const candidateIndices = new Set<number>();
      for (let dLat = -1; dLat <= 1; dLat += 1) {
        for (let dLng = -1; dLng <= 1; dLng += 1) {
          const key = `${latCell + dLat}:${lngCell + dLng}`;
          const indices = lineSegmentIndex.grid.get(key);
          if (indices) {
            indices.forEach((idx) => candidateIndices.add(idx));
          }
        }
      }
      const indicesToCheck = candidateIndices.size > 0 ? Array.from(candidateIndices) : lineSegmentIndex.segments.map((_seg, idx) => idx);
      indicesToCheck.forEach((index) => {
        const segment = lineSegmentIndex.segments[index];
        const distance = approxPointToSegmentDistance(point, segment.start, segment.end);
        if (!nearest || distance < nearest.distance) {
          nearest = { lineId: segment.lineId, distance };
        }
      });
      const candidate = nearest as { lineId: LineOptionId; distance: number } | null;
      const nearestDistance = candidate?.distance ?? Infinity;
      if (candidate && nearestDistance < 200) {
        selectLineGroup(candidate.lineId, "exclusive");
        return;
      }
      if (!isStopSheetOpen && selectedLines.length > 0 && tripMode === "HOME" && !activeTripId) {
        setSelectedLines([]);
        prevSelectedLinesRef.current = null;
      }
    },
    [activeTripId, isStopSheetOpen, lineSegmentIndex, selectLineGroup, selectedLines.length, setSelectedLines, tripMode],
  );

  const handleSelectStop = useCallback(
    (
      stopId: string | null,
      meta?: { lat?: number; lng?: number; name?: string; lineIds?: string[]; platformStopIds?: string[] },
    ) => {
      if (!stopId) return;
      const platformMatch = platformStationMap.get(stopId);
      const resolvedStopId = stationLookup.has(stopId) ? stopId : platformMatch?.stationId ?? stopId;
      if (!isStopSheetOpen) {
        captureMapView();
      }
      if (!prevSelectedLinesRef.current) {
        prevSelectedLinesRef.current = selectedLines.length > 0 ? [...selectedLines] : [];
      }
      setSelectedStopId(resolvedStopId);
      setIsStopSheetOpen(true);
      if (meta?.name) {
        setSelectedStopName(meta.name);
      }
      const derivedLines = toLineOptionIds(meta?.lineIds);
      if (derivedLines.length > 0) {
        setSelectedLines(derivedLines);
      }
      if (meta?.platformStopIds && meta.platformStopIds.length > 0) {
        setSelectedPlatformStopIds(meta.platformStopIds);
      } else if (platformMatch?.platformStopIds?.length) {
        setSelectedPlatformStopIds(platformMatch.platformStopIds);
      } else {
        setSelectedPlatformStopIds(null);
      }
      const station = stationLookup.get(resolvedStopId);
      const lat = meta?.lat ?? station?.latitude;
      const lng = meta?.lng ?? station?.longitude;
      const candidateLines = meta?.lineIds ?? station?.routesServing ?? [];
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        lastSelectedStopCoordsRef.current = { lat: lat as number, lng: lng as number };
      }
      logMapDebug("handleSelectStop", {
        stopId: resolvedStopId,
        lat,
        lng,
        lineIdsCount: candidateLines.length,
      });
      const focusPoints = buildStopFocusPoints(lat, lng, candidateLines);
      logMapDebug("handleSelectStop:focusPoints", { count: focusPoints.length });
      if (focusPoints.length > 0) {
        // Prefer a slightly reduced zoom when focusing a stop so surroundings
        // remain visible while the stop sheet is open.
        preferStopZoomRef.current = true;
        requestMapFocus({ id: `stop-${resolvedStopId}`, points: focusPoints, scroll: true, priority: 3, kind: "stop" });
      } else if (Number.isFinite(lat) && Number.isFinite(lng)) {
        centerMapOnCoordinates(lat as number, lng as number, 15);
      } else {
        clearMapFocus();
      }
    },
    [
      setIsStopSheetOpen,
      setSelectedLines,
      selectedLines,
      setSelectedStopId,
      setSelectedStopName,
      setSelectedPlatformStopIds,
      platformStationMap,
      stationLookup,
      buildStopFocusPoints,
      requestMapFocus,
      centerMapOnCoordinates,
      clearMapFocus,
      isStopSheetOpen,
      captureMapView,
    ],
  );

  const focusStopRoute = useCallback(
    (routeId: string | null) => {
      if (!routeId) return;
      if (!isLineOptionId(routeId)) return;
      if (lastStopRouteFocusRef.current === routeId) return;
      lastStopRouteFocusRef.current = routeId;
      logMapDebug("focusStopRoute:start", {
        routeId,
        selectedStop: lastSelectedStopCoordsRef.current,
      });
      setSelectedLines((prev) => {
        if (prev.length === 1 && prev[0] === routeId) return prev;
        return [routeId];
      });
      const shapes = lineShapeLookup.get(routeId);
      if (!shapes || shapes.length === 0) return;
      const stopCoords = lastSelectedStopCoordsRef.current;
      const localBoundsPoints: Array<{ lat: number; lng: number }> = [];
      if (stopCoords) {
        const windowSize = 36;
        const localRadiusMeters = 3500;
        shapes.forEach((path) => {
          let nearestIndex = -1;
          let nearestDistance = Number.POSITIVE_INFINITY;
          path.forEach((coord, idx) => {
            if (!Number.isFinite(coord.lat) || !Number.isFinite(coord.lng)) return;
            const distance = metersBetween(stopCoords.lat, stopCoords.lng, coord.lat, coord.lng);
            if (distance < nearestDistance) {
              nearestDistance = distance;
              nearestIndex = idx;
            }
          });
          if (nearestIndex < 0) return;
          const start = Math.max(0, nearestIndex - windowSize);
          const end = Math.min(path.length - 1, nearestIndex + windowSize);
          for (let idx = start; idx <= end; idx += 1) {
            const coord = path[idx];
            if (!coord) continue;
            if (!Number.isFinite(coord.lat) || !Number.isFinite(coord.lng)) continue;
            if (metersBetween(stopCoords.lat, stopCoords.lng, coord.lat, coord.lng) > localRadiusMeters) continue;
            localBoundsPoints.push({ lat: coord.lat, lng: coord.lng });
          }
        });
      }
      const outlierDistanceMeters = 200_000;
      const boundsPoints: Array<{ lat: number; lng: number }> = [];
      shapes.forEach((path) => {
        path.forEach((coord) => {
          if (!Number.isFinite(coord.lat) || !Number.isFinite(coord.lng)) return;
          if (
            stopCoords &&
            metersBetween(stopCoords.lat, stopCoords.lng, coord.lat, coord.lng) > outlierDistanceMeters
          ) {
            return;
          }
          boundsPoints.push({ lat: coord.lat, lng: coord.lng });
        });
      });
      const focusPoints = localBoundsPoints.length >= 2 ? localBoundsPoints : boundsPoints;
      logMapDebug("focusStopRoute:points", {
        localPoints: localBoundsPoints.length,
        allPoints: boundsPoints.length,
        usingLocal: focusPoints === localBoundsPoints,
      });
      if (focusPoints.length === 0 && stopCoords) {
        const fallbackPoints = buildStopFocusPoints(stopCoords.lat, stopCoords.lng, [routeId]);
        if (fallbackPoints.length > 0) {
          logMapDebug("focusStopRoute:fallbackPoints", { count: fallbackPoints.length });
          requestMapFocus({
            id: `stop-route-${routeId}-fallback`,
            points: fallbackPoints,
            scroll: false,
            priority: 3,
            kind: "stop-route",
          });
        }
        return;
      }
      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLng = Infinity;
      let maxLng = -Infinity;
      (focusPoints.length ? focusPoints : shapes.flat()).forEach((coord) => {
        if (!Number.isFinite(coord.lat) || !Number.isFinite(coord.lng)) return;
        minLat = Math.min(minLat, coord.lat);
        maxLat = Math.max(maxLat, coord.lat);
        minLng = Math.min(minLng, coord.lng);
        maxLng = Math.max(maxLng, coord.lng);
      });
      if (!Number.isFinite(minLat) || !Number.isFinite(minLng)) return;
      if (stopCoords) {
        const spanMeters = metersBetween(minLat, minLng, maxLat, maxLng);
        logMapDebug("focusStopRoute:span", { spanMeters, minLat, minLng, maxLat, maxLng });
        if (spanMeters > outlierDistanceMeters) {
          const fallbackPoints = buildStopFocusPoints(stopCoords.lat, stopCoords.lng, [routeId]);
          if (fallbackPoints.length > 0) {
            logMapDebug("focusStopRoute:spanFallback", { count: fallbackPoints.length });
            requestMapFocus({
              id: `stop-route-${routeId}-fallback`,
              points: fallbackPoints,
              scroll: false,
              priority: 3,
              kind: "stop-route",
            });
            return;
          }
        }
      }
      requestMapFocus({
        id: `stop-route-${routeId}`,
        points: [
          { lat: minLat, lng: minLng },
          { lat: maxLat, lng: maxLng },
        ],
        scroll: false,
        priority: 3,
        kind: "stop-route",
      });
    },
    [buildStopFocusPoints, lineShapeLookup, requestMapFocus, setSelectedLines],
  );

  const saveCurrentLocation = useCallback(
    (name: string, override?: { lat?: number; lng?: number; stopId?: string | null; lines?: LineOptionId[] | null }) => {
      const lat = override?.lat ?? position.lat;
      const lng = override?.lng ?? position.lng;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const newLocation: SavedLocation = {
        id: generateId(),
        name: name || "Saved location",
        lat,
        lng,
        stopId: override?.stopId ?? null,
        lines:
          override?.lines != null
            ? override.lines
            : newLocationIncludeLines && selectedLines.length > 0
              ? [...selectedLines]
              : null,
      };
      setSavedLocations((prev) => [newLocation, ...prev].slice(0, 10));
      setIsSavingLocation(false);
      setNewLocationName("");
      setNewLocationIncludeLines(false);
    },
    [position.lat, position.lng, newLocationIncludeLines, selectedLines],
  );

  const startEditingLocation = (location: SavedLocation) => {
    setEditingLocationId(location.id);
    setEditingLocationValue(location.name);
  };

  const confirmEditLocation = (locationId: string) => {
    setSavedLocations((prev) =>
      prev.map((location) =>
        location.id === locationId ? { ...location, name: editingLocationValue || location.name } : location,
      ),
    );
    setEditingLocationId(null);
    setEditingLocationValue("");
  };

  const deleteLocation = (locationId: string) => {
    setSavedLocations((prev) => prev.filter((location) => location.id !== locationId));
    if (editingLocationId === locationId) {
      setEditingLocationId(null);
      setEditingLocationValue("");
    }
  };

  const jumpToSavedLocation = useCallback(
    (location: SavedLocation) => {
      applyLocation(location.lat, location.lng, location.name);
      centerMapOnCoordinates(location.lat, location.lng, 14);
      if (location.lines && location.lines.length > 0) {
        setSelectedLines(location.lines);
      }
    },
    [applyLocation, centerMapOnCoordinates],
  );

  const handleAddressSearchSelect = useCallback(
    (result: LocationSearchResult) => {
      applyLocation(result.lat, result.lon);
      centerMapOnCoordinates(result.lat, result.lon, 14);
      setStopSearch(result.label);
    },
    [applyLocation, centerMapOnCoordinates],
  );


  useEffect(() => {
    if (!isStopSheetOpen) return;
    const handler = (event: PointerEvent) => {
      const target = event.target;
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      // If any node in the composed path is the stop-sheet panel (fallback to class check), treat as inside.
      const pathContainsSheet = path.some((n) => {
        try {
          return n instanceof Element && n.classList && (n.classList.contains("stop-sheet-panel") || n.getAttribute("role") === "dialog");
        } catch {
          return false;
        }
      });
      if (pathContainsSheet) return;
      const withinNode = (node?: Node | null) => {
        if (!node) return false;
        if (target instanceof Node && node.contains(target)) return true;
        if (path.includes(node)) return true;
        return false;
      };
      if (withinNode(stopSheetRootRef.current)) return;
      // Treat the actual map canvas/container as safe (do not close when clicking the map),
      // but allow clicks on the surrounding panel to close the sheet.
      const mapNode = mapRef.current?.getMap?.()?.getCanvas?.() ?? mapRef.current?.getMap?.()?.getContainer?.();
      if (withinNode(mapNode)) return;
      if (stopSheetSafeRefs.some((ref) => withinNode(ref.current))) return;
      closeStopSheet();
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [isStopSheetOpen, closeStopSheet, stopSheetSafeRefs]);

  // When stop sheet opens on desktop, scroll the page so the map panel is centered
  // in the viewport (improves visibility when sheet would otherwise cut off the map).
  useEffect(() => {
    if (!isStopSheetOpen || !isDesktop) return;
    const el = mapSectionRef.current;
    if (!el) return;
    // Delay slightly to let layout settle (sheet mount/animation).
    const t = window.setTimeout(() => {
      try {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch {
        // ignore
      }
    }, 120);
    return () => window.clearTimeout(t);
  }, [isStopSheetOpen, isDesktop]);

  const selectedStopAnnotation = useMemo(() => {
    if (!selectedStopId || !isStopSheetOpen) return null;
    const station = stationLookup.get(selectedStopId);
    const lat = station?.latitude;
    const lng = station?.longitude;
    if (lat == null || lng == null) return null;
    const tokens = Array.from(
      new Map(
        (station?.routesServing ?? [])
          .map((route) => getLineToken(route, themeMode))
          .map((t) => [t.id, t]),
      ).values(),
    );
    const colors = tokens.length > 0 ? tokens.map((t) => t.color) : undefined;
    return (
      <MapAnnotation
        key={`annotation-${selectedStopId}`}
        latitude={lat}
        longitude={lng}
        label={selectedStopName ?? station?.name ?? ""}
        colors={colors}
        onClose={closeStopSheet}
      />
    );
  }, [selectedStopId, isStopSheetOpen, stationLookup, themeMode, selectedStopName, closeStopSheet]);

  const stopFollowingTrip = useCallback(() => {
    setActiveTripId(null);
    setTripMode("HOME");
    if (followResumeContext?.stopId) {
      setSelectedStopId(followResumeContext.stopId);
      setSelectedStopName(followResumeContext.name ?? null);
      setSelectedPlatformStopIds(followResumeContext.platformStopIds ?? null);
      setIsStopSheetOpen(true);
    }
    setFollowResumeContext(null);
    lastVehicleLocationRef.current = null;
    clearMapFocus();
  }, [
    followResumeContext,
    setIsStopSheetOpen,
    setSelectedPlatformStopIds,
    setSelectedStopId,
    setSelectedStopName,
    setTripMode,
    clearMapFocus,
  ]);

  const cancelTripPlanning = useCallback(() => {
    if (tripPlanAbortRef.current) {
      tripPlanAbortRef.current.abort();
      tripPlanAbortRef.current = null;
    }
    setTripPlanError(null);
    setTripPlanNotice(null);
    setTripMode("TRIP_EDITING");
  }, [setTripMode]);

  const exitTripMode = useCallback(() => {
    if (activeTripId) {
      stopFollowingTrip();
    }
    if (tripPlanAbortRef.current) {
      tripPlanAbortRef.current.abort();
      tripPlanAbortRef.current = null;
    }
    setTripMode("HOME");
    setMapPickMode(null);
    setTripPlanError(null);
    setTripPlanNotice(null);
    setTripOriginInput("");
    setTripDestinationInput("");
    setTripFocusedField(null);
    lastPlannedKeyRef.current = null;
    setTripPlanView(createEmptyTripPlanView());
  }, [
    activeTripId,
    createEmptyTripPlanView,
    setMapPickMode,
    setTripMode,
    stopFollowingTrip,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isEditable =
        target?.isContentEditable ||
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select";
      if (isEditable) return;
      if (tripMode === "HOME" && selectedLines.length > 0 && !activeTripId && !isStopSheetOpen) {
        event.preventDefault();
        setSelectedLines([]);
        prevSelectedLinesRef.current = null;
        return;
      }
      if (tripMode === "HOME" && !activeTripId) return;
      event.preventDefault();
      if (tripMode === "TRIP_PLANNING") {
        cancelTripPlanning();
        return;
      }
      exitTripMode();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTripId, cancelTripPlanning, exitTripMode, isStopSheetOpen, selectedLines.length, setSelectedLines, tripMode]);

  useEffect(() => {
    if (activeTripId && tripTrackQuery.isError && tripTrackQuery.failureCount > 0) {
      const timer = setTimeout(() => {
        stopFollowingTrip();
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [activeTripId, tripTrackQuery.isError, tripTrackQuery.failureCount, stopFollowingTrip]);

  useEffect(() => {
    if (selectedStopId) {
      setFollowStartError(null);
    }
  }, [selectedStopId]);

  useEffect(() => {
    if (!isStopSheetOpen) return;
    setTripFocusedField(null);
    setModeDropdownOpen(false);
  }, [isStopSheetOpen]);

  const mapControlsStyle = useMemo(() => {
    if (preferStackedLayout && isStopSheetOpen) {
      return { top: "1rem", right: "1rem" };
    }
    if (preferStackedLayout) {
      return { bottom: "1rem", right: "1rem" };
    }
    return { top: "1rem", right: "1rem" };
  }, [isStopSheetOpen, preferStackedLayout]);

  const shouldShowExit = Boolean(activeTripPlan || tripPlanView.plans.length > 0 || tripMode === "TRIP_READY");
  const canSwapTrip = Boolean(tripPlanView.origin && tripPlanView.destination);
  const tripStatusLabel =
    tripMode === "TRIP_PLANNING"
      ? "Planning…"
      : tripMode === "TRIP_ERROR"
        ? "Trip error"
        : "Plan a trip";
  const showModeInHeader = !preferStackedLayout && tripMode === "HOME";
  const showModeInTripPlannerCard = !preferStackedLayout && tripMode !== "HOME" && !isFollowingTrip;
  const recentTripsToShow = showRecentTrips ? recentTrips : recentTrips.slice(0, 4);
  const savedLocationsToShow = savedLocations.slice(0, 4);
  const mapHeaderDesktop = mapVisibility.showHomeHeader ? (
    <div className="shrink-0 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between" style={{ position: "relative", zIndex: 20 }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold" style={{ color: "var(--foreground)" }}>
            Tap stop to view ETAs
          </h2>
          <div className="mt-1 text-xs font-medium" style={{ color: "var(--muted)" }}>
            Select a stop to see ETAs or plan a trip above.
          </div>
          {selectedStopId && selectedStopName && (
            <div
              className="mt-2 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
              aria-live="polite"
              style={{
                borderColor: "color-mix(in srgb, var(--state-info) 45%, var(--border))",
                background: "color-mix(in srgb, var(--state-info) 10%, var(--surface))",
                color: "var(--foreground)",
              }}
            >
              <span className="text-[10px] uppercase tracking-[0.3em]" style={{ color: "var(--state-info)" }}>
                Viewing
              </span>
              <span className="font-semibold" style={{ color: "var(--foreground)" }}>
                {selectedStopName}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2 text-xs sm:flex-row sm:flex-wrap sm:items-center" style={{ color: "var(--muted)" }}>
        {activeTripId && tripTrackQuery.data && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" style={{ color: "var(--foreground)" }}>
            <span className="chip chip-live">
              <FiZap /> Following {tripTrackQuery.data.routeId} → {tripTrackQuery.data.destination}
            </span>
            <button type="button" className="btn btn-ghost px-3 py-1 text-xs" onClick={stopFollowingTrip} data-interactive="ghost">
              Stop
            </button>
          </div>
        )}
      </div>
      <div className="flex items-center justify-end">
        {showModeInHeader ? modeDropdownControl : null}
      </div>
    </div>
  ) : null;
  const mapHeaderMobile = preferStackedLayout && isMobile ? (
    <div
      className="fixed left-1/2 top-16 z-[70] flex -translate-x-1/2 items-center gap-1 rounded-full border px-1.5 py-1 shadow-lg"
      style={{
        borderColor: "color-mix(in srgb, var(--border) 70%, transparent)",
        background: "linear-gradient(135deg, rgba(15,23,42,0.55), rgba(15,23,42,0.25))",
        backdropFilter: "blur(14px)",
      }}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition"
        aria-pressed={mobileFocusMode === "map"}
        onClick={() => setMobileFocusMode("map")}
        style={{
          background:
            mobileFocusMode === "map"
              ? "linear-gradient(135deg, rgba(56,189,248,0.45), rgba(16,185,129,0.35))"
              : "transparent",
          color: mobileFocusMode === "map" ? "white" : "var(--foreground)",
        }}
      >
        <FiMap className="text-[12px]" />
        Map
      </button>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition"
        aria-pressed={mobileFocusMode === "details"}
        onClick={() => setMobileFocusMode("details")}
        style={{
          background:
            mobileFocusMode === "details"
              ? "linear-gradient(135deg, rgba(56,189,248,0.45), rgba(16,185,129,0.35))"
              : "transparent",
          color: mobileFocusMode === "details" ? "white" : "var(--foreground)",
        }}
      >
        <FiList className="text-[12px]" />
        Details
      </button>
    </div>
  ) : null;

  type HomeActionSectionKey = "filters" | "tripPlanner" | "tripOptions" | "saved";

  const renderHomeActionStack = (
    variant: "sidebar" | "map",
    sections?: HomeActionSectionKey[],
  ) => {
    const showHomeFilters = tripMode === "HOME";
    const showTripPlannerPanel = true;
    const activePlan =
      tripPlanView.plans.find((plan) => plan.tripId === tripPlanView.activeTripId) ?? tripPlanView.plans[0] ?? null;
    const summaryTitle = tripMode === "TRIP_PLANNING"
      ? "Planning route…"
      : tripMode === "TRIP_ERROR"
        ? "Trip error"
        : activePlan?.label ?? "Trip timeline";
    const summaryMeta = activePlan
      ? `${formatMinutes(activePlan.totalMinutes)} · ${activePlan.transfers} transfers${
          activePlan.confidence !== "realtime" ? " · estimated" : ""
        }`
      : tripPlanError ?? (tripPlanNotice ? "No route in selected modes." : "Tap to view trip details");
    const tripOptionsContent = (
        <div className="mt-3 space-y-2">
          {tripMode === "TRIP_PLANNING" && (
            <div
              className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-xs"
              style={{ borderColor: "var(--border)", color: "var(--muted)" }}
              aria-live="polite"
            >
              <span className="flex items-center gap-2">
                <span
                  className="inline-flex h-3 w-3 animate-spin rounded-full"
                  style={RAINBOW_SPINNER_STYLE}
                />
                Planning the best route…
              </span>
              <button type="button" className="btn btn-ghost px-2 py-1 text-[11px]" onClick={cancelTripPlanning} data-interactive="ghost">
                Cancel
              </button>
            </div>
          )}
          {tripMode === "TRIP_ERROR" && tripPlanError && (
            <div
              className="rounded-xl border px-3 py-2 text-xs"
              style={{ borderColor: "color-mix(in srgb, var(--state-danger) 45%, var(--border))", color: "var(--state-danger)" }}
            >
              {tripPlanError}
            </div>
          )}
          {tripMode === "TRIP_ERROR" && tripPlanNotice && (
            <div
              className="rounded-xl border px-3 py-2 text-xs"
              style={{
                borderColor: "color-mix(in srgb, var(--accent) 35%, var(--border))",
                color: "var(--muted)",
                background: "color-mix(in srgb, var(--accent) 8%, var(--surface))",
              }}
            >
              {tripPlanNotice}
            </div>
          )}
          {tripMode !== "TRIP_PLANNING" && tripPlanView.plans.length === 0 && !tripPlanError && !tripPlanNotice && (
            <div className="rounded-xl border px-3 py-2 text-xs" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
              {tripMode === "TRIP_EDITING"
                ? "Choose a start and destination to plan a trip."
                : "No route found. Try nearby stops or set a point on the map."}
            </div>
          )}
          {tripMode === "TRIP_PLANNING" && tripPlanView.plans.length === 0 && (
            <div className="space-y-3">
              {[0, 1].map((idx) => (
                <div
                  key={`trip-loading-${idx}`}
                  className="animate-pulse rounded-2xl border px-4 py-3"
                  style={{ borderColor: "var(--border)", background: "color-mix(in srgb, var(--surface) 60%, transparent)" }}
                >
                  <div className="h-3 w-32 rounded-full" style={{ background: "color-mix(in srgb, var(--border) 45%, transparent)" }} />
                  <div className="mt-2 h-3 w-24 rounded-full" style={{ background: "color-mix(in srgb, var(--border) 35%, transparent)" }} />
                  <div className="mt-4 h-2 w-full rounded-full" style={{ background: "color-mix(in srgb, var(--border) 25%, transparent)" }} />
                </div>
              ))}
            </div>
          )}
          {tripPlanView.plans.map((plan) => {
            const isActive = tripPlanView.activeTripId === plan.tripId;
            const showDetails = isActive;
            const hasLegDetails = plan.legs.length > 0;
            return (
              <div key={plan.tripId} className="space-y-2">
                <button
                  type="button"
                  className="w-full rounded-xl border px-3 py-2 text-left transition"
                  style={{
                    borderColor: isActive ? "var(--accent)" : "var(--border)",
                    background: isActive ? "color-mix(in srgb, var(--accent) 10%, var(--card))" : "var(--card)",
                  }}
                  onClick={() => setTripPlanView((prev) => ({ ...prev, activeTripId: plan.tripId }))}
                  aria-pressed={isActive}
                >
                  <div className="flex items-center justify-between text-xs" style={{ color: "var(--muted)" }}>
                    <span className="font-semibold">{plan.label}</span>
                    <span>{formatMinutes(plan.totalMinutes)}</span>
                  </div>
                  <div className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
                    {plan.transfers} transfers · {formatMinutes(plan.walkMinutes)} walk
                  </div>
                  {hasLegDetails && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {plan.legs.map((leg, idx) => {
                        const displayMode = getLegDisplayMode(leg);
                        const token = displayMode === "walk" ? null : getLineToken(leg.routeId ?? leg.lineId ?? null, themeMode);
                        return (
                          <span key={`${plan.tripId}-${leg.mode}-${idx}`} className="inline-flex items-center gap-1">
                            <span
                              className="rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                              style={{
                                borderColor: displayMode === "walk" ? "rgba(148,163,184,0.45)" : token?.border,
                                background: displayMode === "walk" ? "rgba(148,163,184,0.14)" : token?.tint,
                                color: displayMode === "walk" ? "var(--foreground)" : token?.textOnTint,
                              }}
                            >
                              {getLegLabel(leg)}
                            </span>
                            {idx < plan.legs.length - 1 && <FiArrowRight className="text-[10px] text-(--muted)" />}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </button>
                <div
                  className={`trip-details ${showDetails ? "trip-details--open" : ""}`}
                  aria-hidden={!showDetails}
                >
                  {hasLegDetails ? (
                    <div className="border-l border-white/10 pl-5 pt-2">
                      {plan.legs.map((leg, idx) => {
                          const displayMode = getLegDisplayMode(leg);
                          const token = displayMode === "walk" ? null : getLineToken(leg.routeId ?? leg.lineId ?? null, themeMode);
                          const fromLabel = formatStopLabel(leg.from);
                          const toLabel = formatStopLabel(leg.to);
                          const durationMinutes =
                            displayMode === "walk"
                              ? formatMinutesOptional(leg.durationMinutes)
                              : formatMinutesOptional(leg.rideMinutes) ?? formatMinutesOptional(leg.durationMinutes);
                          const waitMinutesValue = typeof leg.waitMinutes === "number" ? leg.waitMinutes : null;
                          const waitMinutes = formatMinutesOptional(leg.waitMinutes);
                          const distance = formatWalkDistanceMiles(leg.distanceMeters);
                          const routeChip = displayMode === "walk" ? null : getLegLabel(leg);
                          const title = displayMode === "walk" ? getLegTitle(leg) : routeChip ?? getLegTitle(leg);
                          const iconColor = token?.color ?? "#94a3b8";
                          const longWalk = displayMode === "walk" && typeof leg.durationMinutes === "number" && leg.durationMinutes >= 15;
                          return (
                            <button
                              type="button"
                              key={`${plan.tripId}-${leg.mode}-${idx}`}
                              className="trip-detail-row group relative mb-3 flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition"
                              style={{ transitionDelay: showDetails ? `${idx * 45}ms` : "0ms" }}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                focusLegSegment(plan.tripId, idx, leg);
                              }}
                              data-interactive="ghost"
                            >
                              <span
                                className="absolute -left-[27px] top-5 h-2.5 w-2.5 rounded-full"
                                style={{
                                  background: leg.mode === "walk" ? "rgba(148,163,184,0.8)" : token?.color ?? "rgba(148,163,184,0.8)",
                                  boxShadow: "0 0 0 6px rgba(15,23,42,0.7)",
                                }}
                              />
                              <div
                                className="flex h-10 w-10 items-center justify-center rounded-full border"
                                style={{
                                  borderColor: displayMode === "walk" ? "rgba(148,163,184,0.35)" : token?.border,
                                  background: displayMode === "walk" ? "rgba(148,163,184,0.12)" : token?.tint,
                                  color: displayMode === "walk" ? "var(--foreground)" : token?.textOnTint,
                                }}
                              >
                                {getLegIcon(leg, iconColor)}
                              </div>
                              <div className="flex-1 space-y-1.5">
                                {displayMode !== "walk" && (waitMinutesValue != null || leg.transferPenaltyMinutes) && (
                                  <div className="flex flex-wrap items-center gap-2 text-[11px]" style={{ color: "var(--muted)" }}>
                                    {waitMinutes && waitMinutesValue != null && waitMinutesValue > 2 && (
                                      <span className="inline-flex items-center gap-1">
                                        <FiClock className="text-[11px]" />
                                        {waitMinutes} wait
                                      </span>
                                    )}
                                    {leg.transferPenaltyMinutes ? (
                                      <span className="inline-flex items-center gap-1">
                                        <FiZap className="text-[11px]" />
                                        +{formatMinutesOptional(leg.transferPenaltyMinutes)} transfer
                                      </span>
                                    ) : null}
                                  </div>
                                )}
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="flex items-center gap-2 text-base font-semibold">
                                    {routeChip && (
                                      <span
                                        className="h-2.5 w-2.5 rounded-full"
                                        style={{ background: token?.color ?? "#94a3b8" }}
                                        aria-hidden="true"
                                      />
                                    )}
                                    <span>{title}</span>
                                  </div>
                                  <div className="text-base font-semibold">{durationMinutes ?? "—"}</div>
                                </div>
                                <div className="text-[12px]" style={{ color: "var(--muted)" }}>
                                  {fromLabel && toLabel ? `${fromLabel} → ${toLabel}` : toLabel ?? fromLabel ?? ""}
                                </div>
                                {displayMode === "walk" && distance ? (
                                  <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                                    {distance}
                                    {longWalk ? (
                                      <span className="ml-2 rounded-full border px-2 py-0.5 text-[10px]" style={{ borderColor: "rgba(248,113,113,0.4)", color: "var(--muted)" }}>
                                        Long walk
                                      </span>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                  ) : (
                    <div className="mt-3 text-[12px]" style={{ color: "var(--muted)" }}>
                      Leg details are missing from the trip response. Retrying or adjusting points may help.
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
    );
    const tripOptionsSection = showTripOptionsPanel ? (
      preferStackedLayout ? (
        <div ref={tripTimelineRef} className="surface px-4 py-4">
          <button
            type="button"
            className="flex w-full items-start justify-between gap-3 text-left"
            onClick={() => setIsTripTimelineOpen((prev) => !prev)}
            aria-expanded={isTripTimelineOpen}
          >
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.25em]" style={{ color: "var(--muted)" }}>
                Trip timeline
              </p>
              <p className="mt-1 text-sm font-semibold" style={{ color: "var(--foreground)" }}>
                {summaryTitle}
              </p>
              <p className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
                {summaryMeta}
              </p>
            </div>
            <FiChevronDown className={`mt-1 text-sm transition ${isTripTimelineOpen ? "rotate-180" : ""}`} />
          </button>
          <div
            className={`transition-[max-height,opacity] duration-200 ${
              isTripTimelineOpen ? "max-h-[2000px] opacity-100" : "max-h-0 opacity-0"
            } ${isTripTimelineOpen ? "" : "pointer-events-none"}`}
          >
            {tripOptionsContent}
          </div>
        </div>
      ) : (
        <div ref={tripTimelineRef} className="surface px-6 pb-5 pt-3">
          <div className="flex items-center justify-between gap-2">
            <p className="heading-label inline-flex items-center gap-2" style={{ color: "var(--muted)" }}>
              <FiClock />
              Trip timeline
            </p>
          </div>
          {tripOptionsContent}
        </div>
      )
    ) : null;
    const filtersSection = showHomeFilters ? (
      <>
        {showFiltersPanel && (
          <>
            {preferStackedLayout ? (
              <div>
                <div className="flex items-center gap-3">
                  <FiSearch className="pointer-events-none text-(--muted)" />
                  <input
                    value={stopSearch}
                    onChange={(evt) => setStopSearch(evt.target.value)}
                    onFocus={() => {
                      setShowFiltersPanel(true);
                    }}
                    placeholder="Search all stops (Park Street, Red…)"
                    className="search-input input-prominent flex-1 pr-4 focus-outline"
                    aria-label="Search all stops"
                  />
                </div>
              </div>
            ) : (
              <div className="surface px-6 py-5">
                <div className="flex items-center justify-between gap-2">
                  <p className="heading-label" style={{ color: "var(--muted)" }}>
                    Search stops or lines
                  </p>
                </div>
                <div className="mt-3">
                  <div className="flex items-center gap-3">
                    <FiSearch className="pointer-events-none text-(--muted)" />
                    <input
                      value={stopSearch}
                      onChange={(evt) => setStopSearch(evt.target.value)}
                      onFocus={() => {
                        setShowFiltersPanel(true);
                      }}
                      placeholder="Search all stops (Park Street, Red…)"
                      className="search-input input-prominent flex-1 pr-4 focus-outline"
                      aria-label="Search all stops"
                    />
                  </div>
                </div>
              </div>
            )}
              <HomePanels
                favorites={filteredFavorites}
                nearby={filteredNearby}
                searchResults={allStopsSearchResults}
                addressResults={addressSearch.results}
                addressLoading={addressSearch.isLoading}
                addressError={addressSearch.error}
                isFetching={homeFetching}
                error={homeError}
                favoriteIds={favoriteIds}
                onToggleFavorite={toggleFavorite}
                onSelectStop={(stopId, meta) => {
                  const station = stationLookup.get(stopId);
                  handleSelectStop(stopId, {
                    name: meta.name,
                    lineIds: meta.lineIds,
                    platformStopIds: meta.platformStopIds,
                    lat: station?.latitude,
                    lng: station?.longitude,
                  });
                }}
                onSelectAddress={handleAddressSearchSelect}
                selectedStopId={selectedStopId}
                favoritesFilteredOut={favoritesFilteredOut}
                nearbyFilteredOut={nearbyFilteredOut}
                searchActive={searchActive}
                searchQuery={stopSearch.trim()}
                stationsLoading={stationsLoading}
                isCompactLayout={!isDesktop}
              />
          </>
        )}
        {!preferStackedLayout && !showFiltersPanel && (
          <div className="surface px-6 py-4">
            <div className="flex items-center justify-between gap-2">
              <p className="heading-label" style={{ color: "var(--muted)" }}>
                Search stops or lines
              </p>
            </div>
          </div>
        )}
      </>
    ) : null;
    const tripPlannerSection = showTripPlannerPanel ? (
      <div className="space-y-3">
        <div className={preferStackedLayout ? "space-y-3" : "px-6 py-5"}>
        <div className="mt-3 flex items-center gap-2">
          <div
            ref={originFieldRef}
            className={`search-shell relative flex min-w-0 flex-1 items-center gap-2 rounded-xl border px-2 py-2 ${
              preferStackedLayout ? "search-shell--mobile-trip" : ""
            }`}
            style={{ borderColor: "var(--border)" }}
          >
            <FiMapPin className="text-(--muted)" />
            <input
              ref={originInputRef}
              value={tripOriginInput}
              onFocus={() => setTripFocusedField("origin")}
              onChange={(evt) => {
                originWasManualRef.current = true;
                setTripOriginInput(evt.target.value);
                const nextOrigin = null;
                const nextDestination = tripPlanView.destination ?? null;
                setTripPlanView((prev) => ({
                  ...prev,
                  origin: nextOrigin,
                  activeTripId: null,
                  plans: [],
                  summary: null,
                  warnings: [],
                }));
                setTripPlanError(null);
                setTripPlanNotice(null);
                lastPlannedKeyRef.current = null;
                requestTripEditing(nextOrigin, nextDestination);
              }}
              placeholder="Start"
              disabled={isTripPlanning}
              className="search-input input-prominent flex-1 text-sm text-(--text) placeholder:text-(--muted) focus:outline-none focus-outline"
            />
              <button
                type="button"
                className="map-select-button shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide transition"
                style={{
                  borderColor: mapPickMode === "origin" ? "rgba(56, 189, 248, 0.7)" : "var(--border)",
                  color: mapPickMode === "origin" ? "var(--foreground)" : "var(--muted)",
                  background: mapPickMode === "origin" ? "rgba(8, 47, 73, 0.6)" : "transparent",
                }}
                data-interactive="ghost"
                onClick={() => {
                  if (mapPickMode === "origin") {
                    void confirmMapPick();
                    return;
                  }
                  setTripFocusedField(null);
                  setMapPickMode("origin");
                  setMapPickError(null);
                }}
                aria-label="Set start on map"
                title={mapPickMode === "origin" ? "Confirm start from map" : "Set start on map"}
                disabled={isTripPlanning}
              >
              <FiMap />
            </button>
            {originDropdown.render && (
              <div
                className={`search-dropdown absolute left-0 top-full z-[90] w-full rounded-xl border bg-(--card) p-2 shadow-lg ${
                  originDropdown.visible ? "search-dropdown--open" : ""
                }`}
                style={{ borderColor: "var(--border)" }}
              >
                {savedLocationsToShow.length > 0 && tripOriginInput.trim().length === 0 && (
                  <div className="mb-2">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.25em]" style={{ color: "var(--muted)" }}>
                      Saved locations
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {savedLocationsToShow.map((location) => (
                        <button
                          key={`origin-saved-${location.id}`}
                          type="button"
                          className="search-dropdown-item rounded-full border px-2 py-1 text-[10px] font-semibold"
                          data-interactive="ghost"
                          style={{ borderColor: "var(--border)", color: "var(--foreground)" }}
                          onClick={() => applyTripPoint(
                            { label: location.name, lat: location.lat, lon: location.lng, stopId: location.stopId ?? null },
                            "origin",
                          )}
                        >
                          {location.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {tripOriginSearch.isLoading && (
                  <div className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                    <span
                      className="inline-flex h-3 w-3 animate-spin rounded-full"
                      style={RAINBOW_SPINNER_STYLE}
                    />
                    Searching…
                  </div>
                )}
                {tripOriginSearch.error && <div className="text-xs" style={{ color: "var(--muted)" }}>{tripOriginSearch.error}</div>}
                <button
                  type="button"
                  className="search-dropdown-item flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs"
                  data-interactive="ghost"
                  onClick={() => {
                    applyTripPoint(
                      { label: "Current location", lat: position.lat, lon: position.lng },
                      "origin",
                    );
                  }}
                >
                  <span className="text-[10px] uppercase tracking-[0.2em]" style={{ color: "var(--muted)" }}>current</span>
                  <span className="flex-1">Use current location</span>
                </button>
                {tripOriginSuggestions.map((suggestion) => (
                  <button
                    key={suggestion.id}
                    type="button"
                    className="search-dropdown-item flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs"
                    data-interactive="ghost"
                    onClick={() => {
                      originWasManualRef.current = true;
                      applyTripPoint(
                        { label: suggestion.label, lat: suggestion.lat, lon: suggestion.lon, stopId: suggestion.stopId ?? null },
                        "origin",
                      );
                    }}
                  >
                    <span className="text-[10px] uppercase tracking-[0.2em]" style={{ color: "var(--muted)" }}>{suggestion.kind}</span>
                    <span className="flex-1">{suggestion.label}</span>
                  </button>
                ))}
                {tripOriginSearch.hasSearched && !tripOriginSearch.isLoading && !tripOriginSearch.error && tripOriginSuggestions.length === 0 && (
                  <div className="text-xs" style={{ color: "var(--muted)" }}>No matches.</div>
                )}
              </div>
            )}
          </div>
          {!preferStackedLayout && (
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-full border text-[11px] transition"
            style={{ borderColor: "var(--border)", color: "var(--muted)" }}
            onClick={() => {
              swapTripPoints();
            }}
            aria-label="Swap start and destination"
            title="Swap start and destination"
            data-interactive="icon"
          >
            <FiRepeat />
          </button>
          )}
          <div
            ref={destinationFieldRef}
            className={`search-shell relative flex min-w-0 flex-1 items-center gap-2 rounded-xl border px-2 py-2 ${
              preferStackedLayout ? "search-shell--mobile-trip" : ""
            }`}
            style={{ borderColor: "var(--border)" }}
          >
            <FiMap className="text-(--muted)" />
            <input
              ref={destinationInputRef}
              value={tripDestinationInput}
              onFocus={() => setTripFocusedField("destination")}
              onChange={(evt) => {
                setTripDestinationInput(evt.target.value);
                const nextOrigin = tripPlanView.origin ?? null;
                const nextDestination = null;
                setTripPlanView((prev) => ({
                  ...prev,
                  destination: nextDestination,
                  activeTripId: null,
                  plans: [],
                  summary: null,
                  warnings: [],
                }));
                setTripPlanError(null);
                setTripPlanNotice(null);
                lastPlannedKeyRef.current = null;
                requestTripEditing(nextOrigin, nextDestination);
              }}
              placeholder="Destination"
              disabled={isTripPlanning}
              className="search-input input-prominent flex-1 text-sm text-(--text) placeholder:text-(--muted) focus:outline-none focus-outline"
            />
            <button
              type="button"
              className="map-select-button shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide transition"
              style={{
                borderColor: mapPickMode === "destination" ? "rgba(56, 189, 248, 0.7)" : "var(--border)",
                color: mapPickMode === "destination" ? "var(--foreground)" : "var(--muted)",
                background: mapPickMode === "destination" ? "rgba(8, 47, 73, 0.6)" : "transparent",
              }}
              data-interactive="ghost"
              onClick={() => {
                if (mapPickMode === "destination") {
                  void confirmMapPick();
                  return;
                }
                setTripFocusedField(null);
                setMapPickMode("destination");
                setMapPickError(null);
              }}
              aria-label="Set destination on map"
              title={mapPickMode === "destination" ? "Confirm destination from map" : "Set destination on map"}
              disabled={isTripPlanning}
            >
              <FiMap />
            </button>
            {destinationDropdown.render && (
              <div
                className={`search-dropdown absolute left-0 top-full z-[90] w-full rounded-xl border bg-(--card) p-2 shadow-lg ${
                  destinationDropdown.visible ? "search-dropdown--open" : ""
                }`}
                style={{ borderColor: "var(--border)" }}
              >
                {savedLocationsToShow.length > 0 && tripDestinationInput.trim().length === 0 && (
                  <div className="mb-2">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.25em]" style={{ color: "var(--muted)" }}>
                      Saved locations
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {savedLocationsToShow.map((location) => (
                        <button
                          key={`dest-saved-${location.id}`}
                          type="button"
                          className="search-dropdown-item rounded-full border px-2 py-1 text-[10px] font-semibold"
                          data-interactive="ghost"
                          style={{ borderColor: "var(--border)", color: "var(--foreground)" }}
                          onClick={() => applyTripPoint(
                            { label: location.name, lat: location.lat, lon: location.lng, stopId: location.stopId ?? null },
                            "destination",
                          )}
                        >
                          {location.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {tripDestinationSearch.isLoading && (
                  <div className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                    <span
                      className="inline-flex h-3 w-3 animate-spin rounded-full"
                      style={RAINBOW_SPINNER_STYLE}
                    />
                    Searching…
                  </div>
                )}
                {tripDestinationSearch.error && <div className="text-xs" style={{ color: "var(--muted)" }}>{tripDestinationSearch.error}</div>}
                <button
                  type="button"
                  className="search-dropdown-item flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs"
                  data-interactive="ghost"
                  onClick={() => {
                    applyTripPoint(
                      { label: "Current location", lat: position.lat, lon: position.lng },
                      "destination",
                    );
                  }}
                >
                  <span className="text-[10px] uppercase tracking-[0.2em]" style={{ color: "var(--muted)" }}>current</span>
                  <span className="flex-1">Use current location</span>
                </button>
                {tripDestinationSuggestions.map((suggestion) => (
                  <button
                    key={suggestion.id}
                    type="button"
                    className="search-dropdown-item flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs"
                    data-interactive="ghost"
                    onClick={() => {
                      applyTripPoint(
                        { label: suggestion.label, lat: suggestion.lat, lon: suggestion.lon, stopId: suggestion.stopId ?? null },
                        "destination",
                      );
                    }}
                  >
                    <span className="text-[10px] uppercase tracking-[0.2em]" style={{ color: "var(--muted)" }}>{suggestion.kind}</span>
                    <span className="flex-1">{suggestion.label}</span>
                  </button>
                ))}
                {tripDestinationSearch.hasSearched && !tripDestinationSearch.isLoading && !tripDestinationSearch.error && tripDestinationSuggestions.length === 0 && (
                  <div className="text-xs" style={{ color: "var(--muted)" }}>No matches.</div>
                )}
              </div>
            )}
          </div>
        </div>
        {tripMode === "TRIP_PLANNING" && (
          <div className="mt-2 flex items-center justify-between gap-2 text-[11px]" style={{ color: "var(--muted)" }}>
            <span className="inline-flex items-center gap-2">
              <span
                className="inline-flex h-3 w-3 animate-spin rounded-full"
                style={RAINBOW_SPINNER_STYLE}
              />
              Finding the best trip…
            </span>
            <button type="button" className="btn btn-ghost px-2 py-1 text-[11px]" onClick={cancelTripPlanning} data-interactive="ghost">
              Cancel
            </button>
          </div>
        )}
        {tripPlanError && (
          <div className="mt-2 text-[11px]" style={{ color: "var(--state-danger)" }}>
            {tripPlanError}
          </div>
        )}
        {tripPlanNotice && !tripPlanError && (
          <div className="mt-2 text-[11px]" style={{ color: "var(--muted)" }}>
            {tripPlanNotice}
          </div>
        )}
        {!preferStackedLayout && recentTripsToShow.length > 0 && (
          <div className="mt-3">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.25em]"
              style={{ color: "var(--muted)" }}
              onClick={() => setShowRecentTrips((prev) => !prev)}
              aria-label={showRecentTrips ? "Collapse recent trips" : "Expand recent trips"}
            >
              <span>Recent trips</span>
              <FiChevronDown className={`transition ${showRecentTrips ? "rotate-180" : ""}`} />
            </button>
            <div className={`recent-trips-list mt-2 flex gap-2 ${showRecentTrips ? "recent-trips-list--expanded" : ""}`}>
              {recentTripsToShow.map((trip) => {
                const fullOrigin = trip.origin.label ?? "Start";
                const fullDestination = trip.destination.label ?? "Destination";
                const shortOrigin = shortenTripChipLabel(fullOrigin, 22);
                const shortDestination = shortenTripChipLabel(fullDestination, 22);
                const lineColors =
                  trip.lineIds
                    ?.map((lineId) => getLineToken(lineId, themeMode).color)
                    .filter(Boolean) ?? [];
                const uniqueColors = Array.from(new Set(lineColors));
                const baseColor = uniqueColors[0];
                const tint = (color: string) => `color-mix(in srgb, ${color} 12%, var(--surface))`;
                const borderTint = (color: string) => `color-mix(in srgb, ${color} 45%, var(--border))`;
                const chipBackground =
                  uniqueColors.length > 1
                    ? `linear-gradient(135deg, ${tint(uniqueColors[0])}, ${tint(uniqueColors[1])})`
                    : baseColor
                      ? tint(baseColor)
                      : "var(--surface)";
                const chipBorder = baseColor ? borderTint(baseColor) : "var(--border)";
                return (
                  <button
                    key={trip.id}
                    type="button"
                    className="recent-trip-chip rounded-full border px-2.5 py-1 text-[10px] font-semibold"
                    data-interactive="chip"
                    style={{ borderColor: chipBorder, color: "var(--foreground)", background: chipBackground }}
                    onClick={() => applyRecentTrip(trip)}
                    aria-label={`Use recent trip ${fullOrigin} to ${fullDestination}`}
                    title={`${fullOrigin} → ${fullDestination}`}
                  >
                    {shortOrigin} → {shortDestination}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
      </div>
    ) : null;

    const savedLocationsSection =
      tripMode === "HOME" ? (
        <div className="w-full rounded-2xl border px-3 py-3" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="flex items-center gap-2 text-xs font-semibold"
              style={{ color: "var(--muted)" }}
              onClick={() => setShowSavedLocationsPanel((prev) => !prev)}
              aria-expanded={showSavedLocationsPanel}
            >
              <FiBookmark /> Saved locations
              <FiChevronDown className={`transition ${showSavedLocationsPanel ? "rotate-180" : ""}`} />
            </button>
            <button
              type="button"
              className="btn btn-ghost px-3 py-1 text-xs"
              data-interactive="ghost"
              style={{ background: RAINBOW_LINE, color: "white", border: "none" }}
              onClick={() => {
                setIsSavingLocation((prev) => !prev);
                setNewLocationName(selectedStopName ?? "Work");
                setShowSavedLocationsPanel(true);
              }}
            >
              {isSavingLocation ? "Cancel" : "Save current"}
            </button>
          </div>
          <div
            className={`mt-3 transition-[max-height,opacity] duration-200 ${
              showSavedLocationsPanel ? "max-h-[1200px] opacity-100" : "max-h-0 opacity-0"
            } ${showSavedLocationsPanel ? "" : "pointer-events-none"}`}
          >
            {isSavingLocation && (
              <form
                className="flex flex-col gap-2"
                onSubmit={(evt) => {
                  evt.preventDefault();
                  saveCurrentLocation(newLocationName.trim());
                }}
              >
                <input
                  value={newLocationName}
                  onChange={(evt) => setNewLocationName(evt.target.value)}
                  placeholder="Name (Home, Work…)"
                  className="input w-full"
                />
                <label className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                  <input
                    type="checkbox"
                    checked={newLocationIncludeLines}
                    onChange={(evt) => setNewLocationIncludeLines(evt.target.checked)}
                    className="rounded border-(--border)"
                  />
                  Save current line filters
                </label>
                <button
                  type="submit"
                  className="btn btn-primary px-3 py-1 text-sm"
                  data-interactive="primary"
                >
                  Save location
                </button>
              </form>
            )}
            {savedLocations.length === 0 ? (
              <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
                You haven&apos;t saved any locations yet.
              </p>
            ) : (
              <div className="mt-3 space-y-3">
                {savedLocations.map((location) => (
                  <div key={location.id} className="rounded-xl border px-3 py-2" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
                    {editingLocationId === location.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          value={editingLocationValue}
                          onChange={(evt) => setEditingLocationValue(evt.target.value)}
                          className="input flex-1"
                        />
                        <button
                          type="button"
                          className="btn btn-ghost px-3 py-1 text-xs"
                          data-interactive="ghost"
                          onClick={() => confirmEditLocation(location.id)}
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold">{location.name}</p>
                          <p className="text-xs" style={{ color: "var(--muted)" }}>
                            {location.lat.toFixed(3)}, {location.lng.toFixed(3)}
                          </p>
                          {location.lines && location.lines.length > 0 && (
                            <p className="text-[11px]" style={{ color: "var(--muted)" }}>
                              Filters: {location.lines.join(", ")}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          <button
                            type="button"
                            className="btn btn-ghost px-3 py-1"
                            data-interactive="ghost"
                            onClick={() => jumpToSavedLocation(location)}
                          >
                            Use
                          </button>
                          <button
                            type="button"
                            className="icon-button focus-outline"
                            data-interactive="icon"
                            onClick={() => startEditingLocation(location)}
                            aria-label="Rename saved location"
                          >
                            <FiEdit />
                          </button>
                          <button
                            type="button"
                            className="icon-button focus-outline"
                            data-interactive="icon"
                            onClick={() => deleteLocation(location.id)}
                            aria-label="Delete saved location"
                          >
                            <FiTrash2 />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null;

    const sectionMap: Record<HomeActionSectionKey, React.ReactNode> = {
      filters: filtersSection,
      tripPlanner: tripPlannerSection,
      tripOptions: tripOptionsSection,
      saved: savedLocationsSection,
    };

    if (variant === "sidebar") {
      return (
        <>
          {tripMode !== "HOME" ? tripOptionsSection : null}
          {filtersSection}
        </>
      );
    }
    const mapSections =
      sections ??
      (preferStackedLayout
        ? [filtersSection, tripPlannerSection, tripOptionsSection, savedLocationsSection]
        : [tripPlannerSection, savedLocationsSection]);
    const resolvedSections = sections?.map((key) => sectionMap[key]).filter(Boolean) ?? mapSections;
    const mapStackSpacing = preferStackedLayout ? "mt-2" : "mt-4";
    return (
      <div className={`${mapStackSpacing} flex w-full flex-col ${preferStackedLayout ? "gap-3" : "gap-4"}`}>
        {resolvedSections.map((section, index) => (
          <Fragment key={`map-section-${index}`}>{section}</Fragment>
        ))}
      </div>
    );
  };
	  return (
	    <div className="flex min-h-screen flex-col" style={{ background: "var(--background)", color: "var(--foreground)" }}>
	      {isDeviceLocationModalOpen && (
	        <div
	            className="fixed inset-0 z-60 flex items-center justify-center px-4 py-8"
	          role="dialog"
	          aria-modal="true"
	          aria-label="Device location settings"
	        >
	          <button
	            type="button"
              className="absolute inset-0"
              style={{ background: "rgba(0,0,0,0.6)" }}
	            aria-label="Close location settings"
	            onClick={() => setIsDeviceLocationModalOpen(false)}
	          />
	          <div
              className="relative w-full max-w-md rounded-2xl border bg-(--card) p-5 shadow-2xl"
	            style={{ borderColor: "var(--border)" }}
	          >
	            <div className="flex items-start justify-between gap-4">
	              <div>
	                <h2 className="text-base font-semibold">Device location</h2>
	                <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
	                  Turn this on to center the map and load nearby stops around you.
	                </p>
	              </div>
	              <button
	                type="button"
	                className="icon-button focus-outline"
	                data-interactive="icon"
	                onClick={() => setIsDeviceLocationModalOpen(false)}
	                aria-label="Close"
	              >
	                <FiX />
	              </button>
	            </div>

	            <div className="mt-4 flex items-center justify-between gap-4 rounded-xl border px-4 py-3" style={{ borderColor: "var(--border)" }}>
	              <div className="min-w-0">
	                <p className="text-sm font-semibold">Use my location</p>
	                <p className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}>
	                  {geoPermissionState === "denied"
	                    ? "Blocked in browser settings."
	                    : geoPermissionState === "granted"
	                      ? "Allowed."
	                      : "Ask when you enable."}
	                </p>
	              </div>
	              <button
	                type="button"
	                role="switch"
	                aria-checked={deviceLocationPref === "on"}
                  className={`relative h-7 w-12 shrink-0 rounded-full border transition ${
                    deviceLocationPref === "on" ? "bg-emerald-500/80" : "bg-(--surface)"
	                }`}
	                style={{ borderColor: "var(--border)" }}
	                onClick={() => {
	                  const next = deviceLocationPref === "on" ? "off" : "on";
	                  setDeviceLocationPref(next);
	                  setDeviceLocationError(null);
	                  if (next === "on") {
	                    if (geoPermissionState === "denied") return;
	                    void requestDeviceLocation({ centerMap: true });
	                  }
	                }}
	              >
	                <span
	                  className={`absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow transition ${
	                    deviceLocationPref === "on" ? "left-6" : "left-1"
	                  }`}
	                />
	              </button>
	            </div>

	            {deviceLocationError && (
                <div
                  className="mt-3 rounded-xl border px-3 py-2 text-sm"
                  style={{ borderColor: "color-mix(in srgb, var(--state-danger) 45%, var(--border))", color: "var(--state-danger)" }}
                >
	                {deviceLocationError}
	              </div>
	            )}

	            <div className="mt-4 flex items-center justify-end gap-2">
	              <button
	                type="button"
	                className="btn btn-ghost focus-outline"
	                data-interactive="ghost"
	                onClick={() => setIsDeviceLocationModalOpen(false)}
	              >
	                Done
	              </button>
	              <button
	                type="button"
	                className="btn btn-primary focus-outline inline-flex items-center gap-2"
	                data-interactive="primary"
	                disabled={geoPermissionState === "denied" || isRequestingDeviceLocation}
	                onClick={() => {
	                  setDeviceLocationPref("on");
	                  void requestDeviceLocation({ centerMap: true });
	                }}
	              >
	                <FiMapPin />
	                {isRequestingDeviceLocation ? "Requesting…" : "Enable now"}
	              </button>
	            </div>
	          </div>
	        </div>
	      )}
      <main
        className={`${layoutClass} relative overflow-x-hidden overflow-y-auto`}
        data-breakpoint={layoutBreakpoint}
        data-layout={preferStackedLayout ? "stacked" : "split"}
        data-trip-mode={tripMode}
        data-trip-active={tripPlanView.activeTripId ?? ""}
        data-trip-error={tripPlanError ?? ""}
      >
        <div
          className="pointer-events-none absolute inset-0 -z-10 opacity-40"
          aria-hidden="true"
        >
          <svg width="100%" height="100%">
            <defs>
              <pattern id="city-grid" width="60" height="60" patternUnits="userSpaceOnUse" patternTransform="skewX(-12)">
                <rect width="60" height="60" fill="transparent" />
                <path d="M0 0 H60 M0 20 H60 M0 40 H60" stroke="rgba(0,0,0,0.04)" strokeWidth="1" />
                <path d="M0 0 V60 M20 0 V60 M40 0 V60" stroke="rgba(0,0,0,0.04)" strokeWidth="1" />
              </pattern>
              <linearGradient id="route-streak" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="var(--line-red)" stopOpacity="0.25" />
                <stop offset="40%" stopColor="var(--line-green)" stopOpacity="0.2" />
                <stop offset="80%" stopColor="var(--line-blue)" stopOpacity="0.25" />
              </linearGradient>
            </defs>
            <rect width="100%" height="100%" fill="url(#city-grid)" />
            <path
              d="M-50 80 C 120 40, 200 140, 360 90 S 640 100, 900 140"
              fill="none"
              stroke="url(#route-streak)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="14 10"
            />
            <path
              d="M-80 220 C 60 260, 220 180, 420 210 S 700 260, 950 220"
              fill="none"
              stroke="url(#route-streak)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="16 12"
            />
          </svg>
        </div>
        {!isFollowingTrip && !preferStackedLayout && (
          <aside
            className={`w-full ${isDesktop ? "space-y-5 lg:w-[360px] lg:shrink-0 lg:space-y-5 lg:sticky lg:top-6 lg:pr-3 lg:self-start" : "space-y-4 pl-4 pr-5 pb-3"} `}
          >
            {renderHomeActionStack("sidebar")}
          </aside>
        )}
        <section className={`flex min-w-0 flex-col ${preferStackedLayout ? "space-y-3" : "space-y-5"}`}>
          {!isFollowingTrip && preferStackedLayout && (
            <div className="relative z-30 flex w-full flex-col gap-1">
              <div className="flex items-center justify-between pt-1 text-xs" style={{ color: "var(--muted)" }}>
                <span className="inline-flex items-center gap-2">
                  <FiSmile />
                  Tap the map icon to pick start or destination.
                </span>
              </div>
              {renderHomeActionStack("map", ["tripPlanner"])}
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="mode-dropdown-trigger mode-dropdown-trigger--large rounded-full border px-4 py-2 text-sm font-medium"
                  data-interactive="ghost"
                  onClick={() => swapTripPoints()}
                  disabled={!canSwapTrip}
                  style={{ borderColor: "var(--border)", color: "var(--foreground)", background: "var(--surface)" }}
                >
                  <span className="inline-flex items-center gap-1">
                    <FiRepeat />
                    Reverse
                  </span>
                </button>
                {modeDropdownControl}
              </div>
            </div>
          )}
            <div
              ref={mapSectionRef}
              className={`flex min-h-0 flex-col overflow-hidden ${preferStackedLayout ? "" : "panel"} ${isFollowingTrip ? "p-0!" : ""}`}
              style={{ position: "relative", height: effectiveMapPanelHeight, maxHeight: mapPanelMaxHeight }}
            >
              {tripMode !== "HOME" && !isFollowingTrip && !preferStackedLayout && (
                <div
                  className="mb-4 flex items-center justify-between gap-3 rounded-2xl border px-4 py-3"
                  style={{ borderColor: "var(--border)", background: "var(--surface)" }}
                >
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.3em]" style={{ color: "var(--muted)" }}>
                      Trip planner
                    </div>
                    <div className="mt-1 inline-flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--foreground)" }}>
                      <FiMap className="text-(--muted)" />
                      {tripStatusLabel}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {showModeInTripPlannerCard ? modeDropdownControl : null}
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition"
                      style={{ ...RAINBOW_OUTLINE_STYLE, color: "var(--muted)", opacity: 0.8 }}
                      disabled
                      aria-label="Export trip details (coming soon)"
                      title="Export options coming soon"
                    >
                      <FiDownload />
                      Export
                    </button>
                    {shouldShowExit && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition"
                        style={{
                          ...RAINBOW_OUTLINE_STYLE,
                          background: "linear-gradient(135deg, rgba(220,38,38,0.08), rgba(245,158,11,0.08), rgba(16,185,129,0.08))",
                          color: "var(--foreground)",
                        }}
                        onClick={exitTripMode}
                        aria-label="Exit trip mode"
                      >
                        <FiX />
                        Exit
                      </button>
                    )}
                  </div>
                </div>
              )}
              {!preferStackedLayout && mapHeaderDesktop}
            {!isFollowingTrip && !preferStackedLayout && (
              renderHomeActionStack("map")
            )}
          <div
            className={`${isFollowingTrip ? "" : preferStackedLayout ? "mt-2" : "mt-4"} relative flex min-h-0 w-full min-w-0 flex-1 overflow-hidden rounded-2xl border`}
            style={{
              borderColor: preferStackedLayout ? "color-mix(in srgb, var(--border) 60%, transparent)" : "var(--border)",
              zIndex: preferStackedLayout ? 20 : 50,
              boxShadow: mapPickPulse ? "0 0 0 2px rgba(56, 189, 248, 0.55), 0 0 30px rgba(56, 189, 248, 0.25)" : undefined,
              transition: "box-shadow 300ms ease",
              minHeight: preferStackedLayout ? "360px" : "420px",
            }}
          >

            {!isClient ? (
              <div className="flex h-full w-full items-center justify-center text-sm" style={{ color: "var(--muted)" }}>
                Initializing map…
              </div>
            ) : (
              <>
                {!mapPickMode && mapVisibility.showCenterTarget && (
                  <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center">
                    <div className="map-center-target" />
                  </div>
                )}
                {mapVisibility.showMapControls && (
                  <div className="absolute z-30 flex flex-col gap-2" style={mapControlsStyle}>
                    <button
                      type="button"
                      onClick={handleUseDeviceLocation}
                      className="icon-button focus-outline text-lg"
                      data-interactive="icon"
                      aria-label="Use my location"
                      title="Use my location"
                    >
                      <FiMapPin />
                    </button>
                    <button
                      type="button"
                      onClick={() => recenterMap()}
                      className="icon-button focus-outline text-lg"
                      data-interactive="icon"
                      disabled={stationsLoading}
                      aria-label="Recenter map"
                      title="Recenter map"
                    >
                      <FiCrosshair />
                    </button>
                  </div>
                )}
                <MapGL
                  key={`${mapStyleId}-${MAP_STYLE_VERSION}`}
                  ref={mapRef}
                  mapLib={maplibregl}
                  mapStyle={mapStyleOption.value}
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 1 }}
                  initialViewState={viewState}
                  interactiveLayerIds={interactiveLayerIds}
                  onMove={(evt) => {
                    viewStateRef.current = evt.viewState as ViewState;
                  }}
                  onMoveEnd={() => {
                    setViewState({ ...viewStateRef.current });
                  }}
                  onDragStart={() => {
                    userMapInteractedRef.current = true;
                  }}
                  onZoomStart={() => {
                    userMapInteractedRef.current = true;
                  }}
                  onRotateStart={() => {
                    userMapInteractedRef.current = true;
                  }}
                  onLoad={() => setMapReady(true)}
                  onError={() => {
                    // Map errors are captured via runtime instrumentation if needed.
                  }}
                  onClick={(evt) => {
                    userMapInteractedRef.current = true;
                    const feature = evt.features?.find((entry) =>
                      [STATION_MARKER_LAYER_ID, STATION_MARKER_SELECTED_LAYER_ID, STATION_MARKER_HOVER_LAYER_ID].includes(
                        entry.layer.id,
                      ),
                    );
                    if (feature?.properties) {
                    const props = feature.properties as {
                      stopId?: string;
                      markerStopId?: string;
                      name?: string;
                      routesServing?: string;
                      platformStopIds?: string;
                    };
                      const lineIds = props.routesServing ? (JSON.parse(props.routesServing) as string[]) : undefined;
                      const platformStopIds = props.platformStopIds
                        ? (JSON.parse(props.platformStopIds) as string[])
                        : undefined;
                      handleSelectStop(props.stopId ?? null, {
                        name: props.name,
                        lineIds,
                        platformStopIds,
                      });
                      return;
                    }
                    handleMapClick(evt);
                  }}
                  onMouseMove={(evt) => {
                    const feature = evt.features?.find((entry) =>
                      [STATION_MARKER_LAYER_ID, STATION_MARKER_SELECTED_LAYER_ID, STATION_MARKER_HOVER_LAYER_ID].includes(
                        entry.layer.id,
                      ),
                    );
                    const props = feature?.properties as { markerStopId?: string } | undefined;
                    scheduleHoverUpdate(props?.markerStopId ?? null);
                  }}
                  onMouseLeave={() => scheduleHoverUpdate(null)}
                >
                  {mapVisibility.showStationMarkers && (
                    <Source id="station-markers" type="geojson" data={stationMarkersGeojson}>
                      <Layer
                        id={STATION_MARKER_LAYER_ID}
                        type="circle"
                        paint={{
                          "circle-color": ["get", "color"],
                          "circle-radius": ["case", ["boolean", ["get", "isBusOnly"], false], 3, 5],
                          "circle-stroke-color": "rgba(255,255,255,0.3)",
                          "circle-stroke-width": 1,
                          "circle-opacity": 0.95,
                        }}
                      />
                      <Layer
                        id={STATION_MARKER_SELECTED_LAYER_ID}
                        type="circle"
                        filter={["==", ["get", "isSelected"], true]}
                        paint={{
                          "circle-color": ["get", "color"],
                          "circle-radius": ["case", ["boolean", ["get", "isBusOnly"], false], 5, 7],
                          "circle-stroke-color": "rgba(34,211,238,0.9)",
                          "circle-stroke-width": 2,
                          "circle-opacity": 1,
                        }}
                      />
                      <Layer
                        id={STATION_MARKER_HOVER_LAYER_ID}
                        type="circle"
                        filter={
                          hoveredMarkerId
                            ? ["==", ["get", "markerStopId"], hoveredMarkerId]
                            : ["==", ["get", "markerStopId"], ""]
                        }
                        paint={{
                          "circle-color": ["get", "color"],
                          "circle-radius": ["case", ["boolean", ["get", "isBusOnly"], false], 6, 8],
                          "circle-stroke-color": "rgba(34,211,238,0.75)",
                          "circle-stroke-width": 2,
                          "circle-opacity": 1,
                        }}
                      />
                    </Source>
                  )}
                  {mapVisibility.showTripMarkers && (
                    <Source id="trip-markers" type="geojson" data={tripStopMarkersGeojson}>
                      <Layer
                        id={TRIP_MARKER_LAYER_ID}
                        type="circle"
                        paint={{
                          "circle-color": ["get", "color"],
                          "circle-radius": 4,
                          "circle-stroke-color": "rgba(15,23,42,0.55)",
                          "circle-stroke-width": 2,
                          "circle-opacity": 0.95,
                        }}
                      />
                      <Layer
                        id={TRIP_MARKER_PRIMARY_LAYER_ID}
                        type="circle"
                        filter={["==", ["get", "kind"], "primary"]}
                        paint={{
                          "circle-color": ["get", "color"],
                          "circle-radius": 6,
                          "circle-stroke-color": "rgba(15,23,42,0.75)",
                          "circle-stroke-width": 2,
                          "circle-opacity": 1,
                        }}
                      />
                    </Source>
                  )}
                  {mapVisibility.showSavedLocationMarkers &&
                    savedLocations.map((location) => (
                      <Marker key={`saved-${location.id}`} latitude={location.lat} longitude={location.lng}>
                        <div className="relative flex flex-col items-center">
                          <button
                            type="button"
                            className="focus-outline flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs font-semibold shadow-lg"
                            style={{
                              borderColor: "var(--accent)",
                              background: "var(--background)",
                              color: "var(--accent)",
                            }}
                            onClick={() => jumpToSavedLocation(location)}
                            onMouseEnter={() => setHoveredSavedLocationId(location.id)}
                            onMouseLeave={() => setHoveredSavedLocationId((prev) => (prev === location.id ? null : prev))}
                            onFocus={() => setHoveredSavedLocationId(location.id)}
                            onBlur={() => setHoveredSavedLocationId((prev) => (prev === location.id ? null : prev))}
                            aria-label={`Go to saved location ${location.name}`}
                            title={location.name}
                          >
                            <FiBookmark />
                          </button>
                          <span
                            className="pointer-events-none absolute top-[-0.35rem] -translate-y-full whitespace-nowrap rounded-full border px-2 py-0.5 text-xs shadow transition-all"
                            style={{
                              borderColor: "var(--border)",
                              background: "var(--card)",
                              color: "var(--foreground)",
                              opacity: hoveredSavedLocationId === location.id ? 1 : 0,
                              transform:
                                hoveredSavedLocationId === location.id
                                  ? "translate(-50%, -110%) scale(1)"
                                  : "translate(-50%, -80%) scale(0.95)",
                            }}
                          >
                            {location.name}
                          </span>
                        </div>
                      </Marker>
                    ))}
                  {showTripLabels &&
                    tripLabelPoints.map((label) => {
                      const kindLabel =
                        label.kind === "start" ? "Start" : label.kind === "end" ? "End" : label.kind === "walk" ? "Walk" : "Transfer";
                      const labelCardStyle =
                        themeMode === "dark"
                          ? {
                              borderColor: "rgba(148,163,184,0.4)",
                              background: "rgba(15,23,42,0.88)",
                              color: "var(--foreground)",
                              boxShadow: "0 6px 16px rgba(15, 23, 42, 0.45)",
                            }
                          : {
                              borderColor: "rgba(148,163,184,0.6)",
                              background: "rgba(255,255,255,0.96)",
                              color: "#0f172a",
                              boxShadow: "0 6px 16px rgba(15, 23, 42, 0.18)",
                            };
                      const badgeStyle =
                        label.kind === "start"
                          ? { background: "rgba(22,163,74,0.2)", color: "rgba(187,247,208,1)" }
                          : label.kind === "end"
                            ? { background: "rgba(220,38,38,0.2)", color: "rgba(254,202,202,1)" }
                            : label.kind === "walk"
                              ? { background: "rgba(148,163,184,0.18)", color: "rgba(226,232,240,1)" }
                              : { background: "rgba(250,204,21,0.18)", color: "rgba(253,230,138,1)" };
                      const offsetY = label.kind === "walk" ? -30 : label.kind === "transfer" ? -18 : -42;
                      return (
                        <Marker
                          key={label.id}
                          latitude={label.lat}
                          longitude={label.lon}
                          anchor="bottom"
                        offset={[0, offsetY]}
                      >
                          <div
                            className="pointer-events-none flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[9px] font-semibold shadow-lg"
                            style={{
                              whiteSpace: "nowrap",
                              ...labelCardStyle,
                            }}
                          >
                            <span
                              className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.2em]"
                              style={badgeStyle}
                            >
                              {kindLabel}
                            </span>
                            {label.kind === "transfer" ? (
                              <span className="inline-flex items-center gap-1">
                                <span className="h-1.5 w-1.5 rounded-full" style={{ background: label.fromColor ?? "#94a3b8" }} />
                                <FiArrowRight className="text-[9px] text-slate-300" />
                                <span className="h-1.5 w-1.5 rounded-full" style={{ background: label.toColor ?? "#94a3b8" }} />
                              </span>
                            ) : label.kind === "walk" ? (
                              <FaWalking className="text-[10px] text-slate-200" />
                            ) : (
                              <span
                                className="h-1.5 w-1.5 rounded-full"
                                style={{ background: label.toColor ?? label.fromColor ?? "#94a3b8" }}
                              />
                            )}
                            <span className="font-semibold">{label.label}</span>
                          </div>
                        </Marker>
                      );
                    })}
                  {tripMode !== "HOME" && tripPlanView.origin && (
                    <Marker latitude={tripPlanView.origin.lat} longitude={tripPlanView.origin.lon}>
                      <div
                        className="flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold"
                        style={{
                          borderColor: "rgba(148, 163, 184, 0.8)",
                          background: "rgba(15, 23, 42, 0.85)",
                          color: "var(--foreground)",
                          boxShadow: "0 4px 12px rgba(15, 23, 42, 0.4)",
                        }}
                      >
                        A
                      </div>
                    </Marker>
                  )}
                  {tripMode !== "HOME" && tripPlanView.destination && (
                    <Marker latitude={tripPlanView.destination.lat} longitude={tripPlanView.destination.lon}>
                      <div
                        className="flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold"
                        style={{
                          borderColor: "rgba(56, 189, 248, 0.9)",
                          background: "rgba(8, 47, 73, 0.85)",
                          color: "var(--foreground)",
                          boxShadow: "0 4px 12px rgba(8, 47, 73, 0.45)",
                        }}
                      >
                        B
                      </div>
                    </Marker>
                  )}
                  {activeTripId &&
                    tripTrackQuery.data?.vehicle?.position?.lat != null &&
                    tripTrackQuery.data.vehicle.position.lng != null && (
                      <Marker
                        latitude={tripTrackQuery.data.vehicle.position.lat}
                        longitude={tripTrackQuery.data.vehicle.position.lng}
                        style={{ zIndex: 1000 }}
                      >
                        <div
                          className="flex h-14 w-14 items-center justify-center rounded-full"
                          style={{
                            background: `radial-gradient(circle at 35% 25%, ${vehicleMarkerAccent} 0%, ${vehicleMarkerAccent} 45%, rgba(3,7,18,0.85) 100%)`,
                            border: `2px solid ${vehicleMarkerAccent}`,
                            color: vehicleMarkerCore,
                            boxShadow: `0 0 25px ${vehicleMarkerGlow}, 0 0 0 10px ${vehicleMarkerHalo}`,
                            pointerEvents: "none",
                          }}
                          title="Tracked vehicle"
                        >
                          {vehicleIsBus ? (
                            <BusIcon className="h-6 w-6" color={vehicleMarkerCore} />
                          ) : (
                            <TrainIcon className="h-6 w-6" color={vehicleMarkerCore} />
                          )}
                        </div>
                      </Marker>
                    )}
                  {/* Selected stop annotation */}
                  {selectedStopAnnotation}
                </MapGL>
                {mapVisibility.showBaseLayers && allowedLineIds.size > 0 && lineShapesQuery.isLoading && (
                  <div
                    className="absolute inset-0 flex items-center justify-center text-sm animate-pulse"
                    style={{
                      background: "linear-gradient(90deg, rgba(220,38,38,0.12), rgba(245,158,11,0.08), rgba(16,185,129,0.12))",
                      color: "var(--foreground)",
                      opacity: 0.12,
                    }}
                  >
                    Loading line paths…
                  </div>
                )}
                {mapVisibility.showBaseLayers && allowedLineIds.size > 0 && lineShapesQuery.isError && (
                  <div
                    className="absolute inset-0 flex items-center justify-center text-sm"
                    style={{
                      background: "color-mix(in srgb, var(--background) 65%, transparent)",
                      color: "var(--state-danger)",
                    }}
                  >
                    Unable to load line shapes. Try again shortly.
                  </div>
                )}
                {mapVisibility.showBaseLayers &&
                  allowedLineIds.size > 0 &&
                  !lineShapesQuery.isLoading &&
                  filteredLineShapes.length === 0 &&
                  !lineShapesQuery.isError && (
                  <div
                    className="absolute inset-0 flex items-center justify-center text-sm"
                    style={{
                      background: "color-mix(in srgb, var(--background) 60%, transparent)",
                      color: "var(--muted)",
                    }}
                  >
                    Line shapes unavailable.
                  </div>
                )}
                {mapPickMode && (
                  <>
                    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center">
                      <div className="relative flex flex-col items-center" style={{ transform: "translateY(-10px)" }}>
                        <div
                          className="pointer-events-none absolute"
                          style={{
                            width: 72,
                            height: 72,
                            borderRadius: "999px",
                            border: "2px solid rgba(56, 189, 248, 0.55)",
                            boxShadow: "0 0 24px rgba(56, 189, 248, 0.32), 0 0 60px rgba(56, 189, 248, 0.2)",
                            opacity: 0.85,
                            transform: mapPickPulse ? "scale(1.15)" : "scale(1.0)",
                            transition: "transform 220ms ease, opacity 220ms ease",
                          }}
                        />
                        <button
                          type="button"
                          onClick={confirmMapPick}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                          }}
                          className="pointer-events-auto flex h-16 w-16 items-center justify-center rounded-full border transition"
                          style={{
                            background: RAINBOW_LINE,
                            borderColor: RAINBOW_LINE,
                            color: "white",
                            boxShadow: mapPickPulse
                              ? "0 0 0 10px rgba(220,38,38,0.18), 0 0 24px rgba(220,38,38,0.3)"
                              : "0 0 0 0 rgba(220,38,38,0.0)",
                            transition: "box-shadow 250ms ease, transform 250ms ease",
                          }}
                          aria-label="Confirm map selection"
                          title="Confirm selection"
                        >
                          <FiMapPin className="h-7 w-7" />
                        </button>
                        <div className="mt-2 rounded-full border px-3 py-1 text-xs" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
                          {mapPickMode === "origin"
                            ? "Move map to set start · click pin or press Enter"
                            : "Move map to set destination · click pin or press Enter"}
                        </div>
                      </div>
                    </div>
                    <div
                      className="absolute inset-x-4 bottom-4 z-50 flex flex-wrap items-center justify-between gap-2 rounded-2xl border px-3 py-3"
                      style={{ borderColor: "var(--border)", background: "color-mix(in srgb, var(--surface) 70%, transparent)" }}
                    >
                      <span className="text-xs font-semibold" style={{ color: "var(--foreground)" }}>
                        {mapPickMode === "origin" ? "Set start from map center" : "Set destination from map center"}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="btn btn-ghost px-3 py-1 text-xs"
                          data-interactive="ghost"
                          onClick={() => {
                            setMapPickMode(null);
                            setMapPickError(null);
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="px-3 py-1 text-xs font-semibold rounded-full transition"
                          style={{
                            background: mapPickLoading
                              ? `linear-gradient(135deg, rgba(220,38,38,0.6), rgba(245,158,11,0.6), rgba(16,185,129,0.6))`
                              : RAINBOW_LINE,
                            color: "white",
                            border: "none",
                          }}
                          onClick={confirmMapPick}
                          disabled={mapPickLoading}
                        >
                          {mapPickLoading ? "Setting…" : "Confirm"}
                        </button>
                      </div>
                      {mapPickError && (
                        <span className="text-xs" style={{ color: "var(--state-danger)" }}>
                          {mapPickError}
                        </span>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
        {!isFollowingTrip && preferStackedLayout && (
          <div
            className="relative z-30 mt-4 flex w-full flex-col gap-4"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.5rem)" }}
          >
            {renderHomeActionStack("map", ["filters", "tripOptions", "saved"])}
          </div>
        )}
        </section>
      </main>
      {mapHeaderMobile}
      {selectedStopId && isStopSheetOpen && (
        <>
	      <div
        ref={stopSheetBackdropRef}
        className="fixed inset-x-0 bottom-0 z-30 pointer-events-none"
        aria-hidden="true"
        style={{ height: preferStackedLayout ? effectiveMobileSheetHeight : "100%" }}
      >
	        <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.7)" }} />
      </div>
          <StopSheetPanel
            stopId={selectedStopId}
            stopName={selectedStopName ?? undefined}
            platformStopIds={selectedPlatformStopIds ?? undefined}
            isOpen={isStopSheetOpen}
            onClose={closeStopSheet}
            onFollowTrip={startFollowingTrip}
            followError={followStartError ?? undefined}
            followLoading={followStartLoading}
            onRouteSelect={focusStopRoute}
            mapPanelRef={mapSectionRef}
            panelRootRef={stopSheetRootRef}
            allowRefs={stopSheetSafeRefs}
            mobileSheetHeight={effectiveMobileSheetHeight}
            overlayHeight={preferStackedLayout ? effectiveMobileSheetHeight : "100%"}
          />
        </>
      )}
      {activeTripId && (
        <div
          ref={followPanelRef}
            className="fixed inset-x-0 bottom-0 z-80 flex justify-center px-4 pb-6 pointer-events-none"
          aria-live="polite"
        >
          <div
            className={`pointer-events-auto panel mx-auto w-full max-w-6xl space-y-4 rounded-4xl border bg-opacity-90 transition duration-400 ${tripTrackQuery.isLoading ? "translate-y-10 opacity-0" : "translate-y-0 opacity-100"}`}
            style={{
              borderColor: followPanelTokens.border,
              background: followPanelTokens.background,
              color: followPanelTokens.text,
              boxShadow: "0 20px 45px rgba(0,0,0,0.45)",
            }}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-full border"
                  style={{
                    borderColor: followPanelTokens.cardAccentBorder,
                    background: themeMode === "dark" ? "rgba(13,22,38,0.9)" : "rgba(226,232,240,0.85)",
                    color: followPanelTokens.text,
                  }}
                >
                  {vehicleIsBus ? (
                    <BusIcon className="h-5 w-5" color={themeMode === "dark" ? "#facc15" : "#c2410c"} />
                  ) : (
                    <TrainIcon className="h-5 w-5" color={themeMode === "dark" ? "#fda4af" : "#be123c"} />
                  )}
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.6em]" style={{ color: followPanelTokens.subtext }}>
                    Following
                  </p>
                  <h3 className="text-2xl font-semibold">
                    {tripTrackQuery.data?.destination ?? tripTrackQuery.data?.tripId ?? activeTripId}
                  </h3>
                  <p className="text-sm" style={{ color: followPanelTokens.subtext }}>
                    Route {tripTrackQuery.data?.routeId ?? "—"}
                    {tripTrackQuery.data?.vehicle?.id ? ` • Vehicle ${tripTrackQuery.data.vehicle.id}` : ""}
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="btn btn-ghost touch-target px-4 py-1 text-sm"
                data-interactive="ghost"
                onClick={stopFollowingTrip}
                style={{ borderColor: followPanelTokens.border, color: followPanelTokens.text }}
              >
                Stop following
              </button>
            </div>
                <div className="flex flex-wrap items-center gap-4 text-xs" style={{ color: followPanelTokens.subtext }}>
              {tripTrackQuery.data?.vehicle?.lastUpdated && (
                <span>Updated {new Date(tripTrackQuery.data.vehicle.lastUpdated).toLocaleTimeString()}</span>
              )}
              <span>
                Focusing on next {followFocusStopIds.length > 0 ? followFocusStopIds.length : Math.min(2, upcomingTripStops.length)} stops
              </span>
            </div>
            <div className="overflow-x-auto pb-1 scrollbar-none">
              {tripTrackQuery.isLoading ? (
                <p className="px-1 text-sm" style={{ color: followPanelTokens.subtext }}>
                  Locking onto vehicle…
                </p>
              ) : followTrackingError ? (
                <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm">
                  <p className="font-medium text-rose-300">Trip tracking unavailable</p>
                  <p className="mt-1 text-xs text-rose-200">{followTrackingError}</p>
                </div>
              ) : upcomingTripStops.length === 0 ? (
                <p className="px-1 text-sm" style={{ color: followPanelTokens.subtext }}>
                  No upcoming stops reported.
                </p>
              ) : (
                <div className="flex gap-3">
                  {upcomingTripStops.slice(0, 10).map((stop, idx) => {
                    const etaLabel = formatEta(stop.etaMinutes);
                    const isPrimary = idx === 0;
                    const stopSourceLabel =
                      stop.source === "schedule"
                        ? "Schedule"
                        : stop.source === "prediction" || stop.source === "blended"
                          ? "Live"
                          : "Estimate";
                    const cardBackground = isPrimary ? followPanelTokens.cardAccent : followPanelTokens.card;
                    const cardBorder = isPrimary ? followPanelTokens.cardAccentBorder : followPanelTokens.cardBorder;
                    const cardShadow = isPrimary ? followPanelTokens.cardShadow : followPanelTokens.cardShadowMuted;
                    return (
                      <button
                        key={`${stop.stopId}-${idx}`}
                        type="button"
                        onClick={() => handleJumpToStop(stop.stopId)}
                        className="group flex min-w-[190px] flex-col rounded-2xl border px-4 py-3 text-left transition focus-outline"
                        style={{
                          borderColor: cardBorder,
                          background: cardBackground,
                          color: followPanelTokens.text,
                          boxShadow: cardShadow,
                        }}
                        data-interactive="ghost"
                      >
                        <div className="flex h-full flex-col">
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-sm font-semibold leading-snug" style={{ color: followPanelTokens.stopName }}>
                              {stop.stopName}
                            </span>
                            {isPrimary && (
                              <span
                                className="flex h-6 w-6 items-center justify-center rounded-full border text-xs"
                                aria-label="Next stop"
                                title="Next stop"
                                style={{
                                  background: followPanelTokens.nextIconBackground,
                                  borderColor: followPanelTokens.nextIconBorder,
                                  color: followPanelTokens.nextIconColor,
                                }}
                              >
                                <FiArrowRight />
                              </span>
                            )}
                          </div>
                          <div className="mt-3 flex flex-1 flex-col justify-end">
                            <div className="flex items-end gap-2">
                              <span className="text-3xl font-bold leading-none" style={{ color: followPanelTokens.etaText }}>
                                {etaLabel}
                              </span>
                              <span
                                className="text-xs uppercase tracking-[0.3em]"
                                style={{ color: followPanelTokens.etaSubtext }}
                              >
                                ETA
                              </span>
                            </div>
                            <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: followPanelTokens.etaSubtext }}>
                              <EtaSourceIndicator source={stop.source} />
                              <span>{stopSourceLabel}</span>
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
