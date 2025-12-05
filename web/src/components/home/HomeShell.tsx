"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import MapGL, { Marker, type MapLayerMouseEvent, type MapRef, type ViewState } from "react-map-gl/maplibre";
import DeckGL from "@deck.gl/react";
import { PathLayer } from "@deck.gl/layers";
import { type Color } from "@deck.gl/core";
import maplibregl from "maplibre-gl";
import { envConfig } from "@/lib/config";
import {
  fetchHome,
  fetchLineShapes,
  fetchStations,
  fetchTripTrack,
  type LineShapeResponse,
  type StationPlatformMarker,
  type StationSummary,
} from "@/lib/api";
import type { HomeStopSummary, HomeRouteSummary } from "@linelight/core";
import { StopSheetPanel } from "@/components/stop/StopSheetPanel";
import {
  FiMapPin,
  FiCrosshair,
  FiStar,
  FiZap,
  FiSun,
  FiMoon,
  FiSearch,
  FiEdit,
  FiTrash2,
  FiBookmark,
  FiHome,
  FiMap,
  FiBarChart2,
  FiSliders,
  FiChevronDown,
  FiX,
  FiMenu,
} from "react-icons/fi";
import { FaStar } from "react-icons/fa";
import { formatEta, formatEtaChip } from "@/lib/time";
import { useAppState } from "@/state/appState";
import { EtaSourceIndicator } from "@/components/stop/EtaSourceIndicator";
import { getDirectionToken, getLineToken } from "@/lib/designTokens";
import type { LineToken } from "@/lib/designTokens";
import { getLandmarkImage, getStopHue } from "@/lib/stopStyling";
import { DirectionArrowIcon } from "@/components/common/DirectionArrowIcon";
import { ThemeProvider, useThemeMode } from "@/hooks/useThemeMode";
import { breakpointClass, useBreakpoint } from "@/hooks/useBreakpoint";

const DEFAULT_POSITION = {
  lat: envConfig.defaultMap.lat,
  lng: envConfig.defaultMap.lng,
};

const FOLLOW_RIBBON_HEIGHT = 240;

const SAVED_LOCATIONS_KEY = "linelight:savedLocations";
const generateId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;

type PersistedViewState = Pick<ViewState, "latitude" | "longitude" | "zoom" | "bearing" | "pitch">;

interface SavedLocation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  stopId?: string | null;
  lines?: LineOptionId[] | null;
}

interface MapSearchResult {
  id: string;
  label: string;
  lat: number;
  lng: number;
}

type FocusPoint = { lat: number; lng: number };
interface FocusRequest {
  id: string;
  points: FocusPoint[];
  scroll?: boolean;
}

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
] as const;

const LINE_PRIORITY_ORDER: Record<string, number> = {
  Red: 3,
  "Green-B": 2,
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

const NAV_BUTTON_CLASS = "btn btn-ghost focus-outline inline-flex items-center gap-1.5 text-sm font-semibold";
const PRIMARY_NAV_LINKS = [
  { href: "/", label: "Home", icon: <FiHome /> },
  { href: "/lines", label: "Lines", icon: <FiMap /> },
  { href: "/insights", label: "Insights", icon: <FiBarChart2 /> },
] as const;

type LineOptionId = (typeof LINE_OPTIONS)[number]["id"];
const GREEN_LINE_GROUP: LineOptionId[] = ["Green-B", "Green-C", "Green-D", "Green-E"];

const canonicalizeLineKey = (value?: string | null) =>
  value?.toLowerCase().replace(/line/g, "").replace(/[^a-z0-9]/g, "") ?? "";

const candidateMatchesLineId = (candidate: string | null | undefined, lineId: LineOptionId) => {
  if (!candidate) return false;
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

const hexToColor = (hex: string | null | undefined): Color => {
  if (!hex) return [0, 196, 180, 220];
  const normalized = hex.replace("#", "");
  const bigint = Number.parseInt(normalized, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return [r, g, b, 200];
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

const normalizeHomeDestination = (value?: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const getDisplayDestinationLabel = (route: HomeRouteSummary): string => {
  return (
    normalizeHomeDestination(route.destination) ??
    normalizeHomeDestination(route.direction) ??
    route.shortName ??
    route.routeId ??
    "Route"
  );
};

const StopSummaryCard = ({
  stop,
  isFavorite,
  onToggleFavorite,
  onSelectStop,
  selected,
}: {
  stop: HomeStopSummary;
  isFavorite: boolean;
  onToggleFavorite: (stopId: string) => void;
  onSelectStop: (stopId: string, meta: { name: string; lineIds: string[]; platformStopIds?: string[] }) => void;
  selected: boolean;
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
            <div>
              <p className="text-base font-semibold" style={{ color: "var(--foreground)" }}>
                {stop.name}
              </p>
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
                    <span className="font-semibold">{formatEtaChip(eta?.etaMinutes ?? null)}</span>
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

export const HomeShell = () => (
  <ThemeProvider>
    <HomeShellContent />
  </ThemeProvider>
);

const HomePanels = ({
  favorites,
  nearby,
  isLoading,
  error,
  favoriteIds,
  onToggleFavorite,
  onSelectStop,
  selectedStopId,
  favoritesFilteredOut,
  nearbyFilteredOut,
  filtersActive,
  isCompactLayout,
}: {
  favorites: HomeStopSummary[];
  nearby: HomeStopSummary[];
  isLoading: boolean;
  error: Error | null;
  favoriteIds: string[];
  onToggleFavorite: (stopId: string) => void;
  onSelectStop: (stopId: string, meta: { name: string; lineIds: string[]; platformStopIds?: string[] }) => void;
  selectedStopId: string | null;
  favoritesFilteredOut: boolean;
  nearbyFilteredOut: boolean;
  filtersActive: boolean;
  isCompactLayout: boolean;
}) => {
  const [favoritesExpanded, setFavoritesExpanded] = useState(false);
  const [nearbyExpanded, setNearbyExpanded] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(!isCompactLayout);
  const [nearbyOpen, setNearbyOpen] = useState(!isCompactLayout);
  const favoritesToShow = favoritesExpanded ? favorites : favorites.slice(0, 3);
  const nearbyToShow = nearbyExpanded ? nearby : nearby.slice(0, 3);
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
    setFavoritesOpen(!isCompactLayout);
    setNearbyOpen(!isCompactLayout);
  }, [isCompactLayout]);
  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-6 w-2/3 animate-pulse rounded-full bg-white/10" />
        <div className="h-32 animate-pulse rounded-3xl bg-white/5" />
        <div className="h-px w-full bg-white/5" />
        <div className="h-6 w-2/3 animate-pulse rounded-full bg-white/10" />
        <div className="h-40 animate-pulse rounded-3xl bg-white/5" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6 text-sm" style={{ color: "var(--muted)" }}>
        <SectionHeader icon={<FiStar />} title="Favorites" />
        <p>We couldn&apos;t load your favorites just now.</p>
        <SectionDivider />
        <SectionHeader icon={<FiMap />} title="Nearby" />
        <p>Nearby stops failed to load. Please try again.</p>
      </div>
    );
  }

  const showFavoritesSection = favoriteIds.length > 0 || favoritesFilteredOut;

  return (
    <div className="space-y-6">
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
            className={`mt-3 space-y-3 transition-[max-height,opacity] duration-200 ${
              favoritesOpen ? "max-h-[1200px] opacity-100" : "max-h-0 opacity-0"
            } ${favoritesOpen ? "" : "pointer-events-none"}`}
          >
            {favorites.length === 0 ? (
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
                />
              ))
            )}
          </div>
        </section>
      )}
      <section>
        {isCompactLayout ? (
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left"
            style={{ borderColor: "var(--border)" }}
            onClick={() => setNearbyOpen((prev) => !prev)}
            aria-expanded={nearbyOpen}
          >
            <div className="flex items-center gap-3">
              <FiMapPin />
              <span className="font-semibold">
                Nearby {nearby.length > 0 ? `• ${nearby.length}` : ""}
              </span>
            </div>
            <FiChevronDown className={`transition ${nearbyOpen ? "rotate-180" : ""}`} />
          </button>
        ) : (
          <>
            <SectionHeader
              icon={<FiMapPin />}
              title="Nearby"
              action={
                nearby.length > 3 && (
                  <button
                    type="button"
                    className="btn btn-ghost touch-target px-3 py-1 text-[11px]"
                    onClick={() => setNearbyExpanded((prev) => !prev)}
                  >
                    {nearbyExpanded ? "Show fewer" : `Show all (${nearby.length})`}
                  </button>
                )
              }
            />
            <SectionDivider />
          </>
        )}
        <div
          className={`mt-3 space-y-3 transition-[max-height,opacity] duration-200 ${
            nearbyOpen ? "max-h-[1200px] opacity-100" : "max-h-0 opacity-0"
          } ${nearbyOpen ? "" : "pointer-events-none"}`}
        >
          {nearby.length === 0 ? (
            nearbyFilteredOut ? (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                Your filters hide nearby stops. Reset them to see everything around you.
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
              />
            ))
          )}
        </div>
      </section>
      {filtersActive && (
        <p className="px-1 text-center text-[11px] uppercase tracking-[0.2em]" style={{ color: "var(--muted)" }}>
          Filters apply to both sections
        </p>
      )}
    </div>
  );
};

const HomeShellContent = () => {
  const mapRef = useRef<MapRef | null>(null);
  const mapSectionRef = useRef<HTMLDivElement | null>(null);
  const mapSearchAbortRef = useRef<AbortController | null>(null);
  const [viewState, setViewState] = useState<ViewState>(() => ({
    ...INITIAL_VIEW_STATE,
  }));
  const [position, setPosition] = useState(DEFAULT_POSITION);
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const stored = window.localStorage.getItem("linelight:favorites");
      if (!stored) return [];
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  });
  const [manualLat, setManualLat] = useState(() => DEFAULT_POSITION.lat.toFixed(5));
  const [manualLng, setManualLng] = useState(() => DEFAULT_POSITION.lng.toFixed(5));
  const [showAdvancedCoords, setShowAdvancedCoords] = useState(false);
  const [manualCoordsError, setManualCoordsError] = useState<string | null>(null);
  const { selectedStopId, setSelectedStopId, isStopSheetOpen, setIsStopSheetOpen } = useAppState();
  const [selectedPlatformStopIds, setSelectedPlatformStopIds] = useState<string[] | null>(null);
  const { mode: themeMode, toggleTheme } = useThemeMode();
  const [activeTripId, setActiveTripId] = useState<string | null>(null);
  const [showBusStops, setShowBusStops] = useState(true);
  const [selectedLines, setSelectedLines] = useState<LineOptionId[]>([]);
  const [greenDrawerOpen, setGreenDrawerOpen] = useState(false);
  const [hasCenteredMap, setHasCenteredMap] = useState(false);
  const [isNavDrawerOpen, setIsNavDrawerOpen] = useState(false);
  const [selectedStopName, setSelectedStopName] = useState<string | null>(null);
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null);
  const [hoveredSavedLocationId, setHoveredSavedLocationId] = useState<string | null>(null);
  const [stopSearch, setStopSearch] = useState("");
  const [mapSearchQuery, setMapSearchQuery] = useState("");
  const [mapSearchResults, setMapSearchResults] = useState<MapSearchResult[]>([]);
  const [mapSearchLoading, setMapSearchLoading] = useState(false);
  const [mapSearchError, setMapSearchError] = useState<string | null>(null);
  const [busRouteShapes, setBusRouteShapes] = useState<LineShapeResponse[]>([]);
  const breakpointInfo = useBreakpoint();
  const { isDesktop } = breakpointInfo;
  const layoutBreakpoint = breakpointClass(breakpointInfo);
  const [savedLocations, setSavedLocations] = useState<SavedLocation[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(SAVED_LOCATIONS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
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
      return cleaned;
    } catch {
      return [];
    }
  });
  const [isSavingLocation, setIsSavingLocation] = useState(false);
  const [newLocationName, setNewLocationName] = useState("");
  const [newLocationIncludeLines, setNewLocationIncludeLines] = useState(false);
  const [editingLocationId, setEditingLocationId] = useState<string | null>(null);
  const [editingLocationValue, setEditingLocationValue] = useState("");
  const [mapFocusRequest, setMapFocusRequest] = useState<FocusRequest | null>(null);
  const lastScrollPositionRef = useRef<number | null>(null);
  const [followResumeContext, setFollowResumeContext] = useState<{
    stopId: string | null;
    name: string | null;
    platformStopIds: string[] | null;
  } | null>(null);
  const lastVehicleLocationRef = useRef<{ lat: number; lng: number } | null>(null);
  const followPanelTokens = useMemo(() => {
    if (themeMode === "dark") {
      return {
        background: "rgba(15,23,42,0.85)",
        border: "rgba(148,163,184,0.35)",
        text: "#f8fafc",
        subtext: "rgba(226,232,240,0.8)",
        card: "rgba(2,6,23,0.65)",
        cardBorder: "rgba(148,163,184,0.25)",
        nextBadge: "rgba(94,234,212,0.2)",
      };
    }
    return {
      background: "rgba(255,255,255,0.95)",
      border: "rgba(148,163,184,0.4)",
      text: "#0f172a",
      subtext: "rgba(71,85,105,0.9)",
      card: "rgba(248,250,252,0.95)",
      cardBorder: "rgba(148,163,184,0.4)",
      nextBadge: "rgba(14,165,233,0.15)",
    };
  }, [themeMode]);

  useEffect(() => {
    localStorage.setItem("linelight:favorites", JSON.stringify(favoriteIds));
  }, [favoriteIds]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify(savedLocations));
    } catch {
      // ignore
    }
  }, [savedLocations]);

  useEffect(() => {
    const query = mapSearchQuery.trim();
    if (query.length === 0) {
      setMapSearchResults([]);
      setMapSearchLoading(false);
      setMapSearchError(null);
      mapSearchAbortRef.current?.abort();
      return;
    }
    setMapSearchLoading(true);
    setMapSearchError(null);
    const controller = new AbortController();
    mapSearchAbortRef.current?.abort();
    mapSearchAbortRef.current = controller;
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&bounded=1&viewbox=-73.7,43.9,-69.7,41.0&limit=6&q=${encodeURIComponent(query)}`,
          {
            headers: {
              "Accept-Language": "en-US",
            },
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          throw new Error("Search failed");
        }
        const payload = (await response.json()) as Array<{ place_id: number; display_name: string; lat: string; lon: string }>;
        const results: MapSearchResult[] = payload
          .map((entry) => ({
            id: String(entry.place_id),
            label: entry.display_name,
            lat: Number(entry.lat),
            lng: Number(entry.lon),
          }))
          .filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lng));
        setMapSearchResults(results);
        setMapSearchLoading(false);
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        setMapSearchLoading(false);
        setMapSearchError("Location search unavailable");
      }
    }, Math.max(120, Math.min(220, query.length <= 2 ? 150 : 100)));
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [mapSearchQuery]);


  const homeQuery = useQuery({
    queryKey: ["home", position],
    queryFn: () =>
      fetchHome({
        lat: position.lat,
        lng: position.lng,
        radiusMeters: 1200,
        limit: 12,
      }),
    retry: false,
  });

  const lineShapesQuery = useQuery({
    queryKey: ["lineShapes", "all"],
    queryFn: async (): Promise<LineShapeWithId[]> => {
      const results = await Promise.allSettled(
        LINE_OPTIONS.map(async (line) => {
          const data = await fetchLineShapes(line.id);
          return { ...data, id: line.id };
        }),
      );
      return results
        .filter((result): result is PromiseFulfilledResult<LineShapeWithId> => result.status === "fulfilled")
        .map((result) => result.value);
    },
    staleTime: 5 * 60_000,
  });

  const lineShapeLookup = useMemo(() => {
    const map = new Map<LineOptionId, LineShapeResponse["shapes"]>();
    lineShapesQuery.data?.forEach((line) => {
      map.set(line.id, line.shapes);
    });
    return map;
  }, [lineShapesQuery.data]);

  const requestMapFocus = useCallback((request: FocusRequest | null) => {
    setMapFocusRequest(request);
  }, []);

  const clearMapFocus = useCallback(() => {
    requestMapFocus(null);
  }, [requestMapFocus]);

  const buildStopFocusPoints = useCallback(
    (lat?: number, lng?: number, lineIds?: string[]) => {
      if (lat == null || lng == null) return [];
      const basePoint: FocusPoint = { lat, lng };
      const neighborPoints: FocusPoint[] = [];
      const seen = new Set<string>();
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
            seen.add(key);
            neighborPoints.push({ lat: coord.lat, lng: coord.lng });
          });
        });
      });
      if (neighborPoints.length === 0) {
        return [basePoint];
      }
      return [basePoint, ...neighborPoints.slice(0, 6)];
    },
    [lineShapeLookup],
  );

  const focusOnMapPoints = useCallback((points: FocusPoint[]) => {
    if (!mapRef.current || points.length === 0) return;
    const latitudes = points.map((point) => point.lat);
    const longitudes = points.map((point) => point.lng);
    const minLat = Math.min(...latitudes);
    const maxLat = Math.max(...latitudes);
    const minLng = Math.min(...longitudes);
    const maxLng = Math.max(...longitudes);
    if (points.length === 1 || (maxLat === minLat && maxLng === minLng)) {
      mapRef.current.flyTo({
        center: [points[0].lng, points[0].lat],
        zoom: 14,
        duration: 800,
      });
      return;
    }
    const bounds: [[number, number], [number, number]] = [
      [minLng, minLat],
      [maxLng, maxLat],
    ];
    try {
      const map = mapRef.current.getMap();
      map.fitBounds(bounds, { padding: 140, duration: 800 });
    } catch {
      mapRef.current.flyTo({
        center: [points[0].lng, points[0].lat],
        zoom: 14,
        duration: 800,
      });
    }
  }, []);

  useEffect(() => {
    if (!mapFocusRequest) {
      if (lastScrollPositionRef.current != null) {
        window.scrollTo({ top: lastScrollPositionRef.current, behavior: "smooth" });
        lastScrollPositionRef.current = null;
      }
      return;
    }
    focusOnMapPoints(mapFocusRequest.points);
    if (mapFocusRequest.scroll && mapSectionRef.current && typeof window !== "undefined") {
      if (lastScrollPositionRef.current == null) {
        lastScrollPositionRef.current = window.scrollY;
      }
      const targetTop = mapSectionRef.current.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
    }
  }, [mapFocusRequest, focusOnMapPoints]);

  const subwayStationsQuery = useQuery({
    queryKey: ["stations", "subway"],
    queryFn: () => fetchStations("subway", 600),
    staleTime: 5 * 60_000,
  });

  const busStationsQuery = useQuery({
    queryKey: ["stations", "bus"],
    queryFn: () => fetchStations("bus", 600),
    staleTime: 5 * 60_000,
    enabled: showBusStops,
  });

  const stationsDataRaw = useMemo(() => {
    const subway = subwayStationsQuery.data ?? [];
    const bus = showBusStops && busStationsQuery.data ? busStationsQuery.data : [];
    return [...subway, ...bus];
  }, [busStationsQuery.data, showBusStops, subwayStationsQuery.data]);
  const stationsLoading = subwayStationsQuery.isLoading || (showBusStops && busStationsQuery.isLoading);

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
    return Array.from(merged.values());
  }, [stationsDataRaw]);

  const stationLookup = useMemo(() => {
    return new Map(stationsData.map((station) => [station.stopId, station]));
  }, [stationsData]);

  useEffect(() => {
    if (!stationsData) return;
    const matching = selectedLines.length > 0
      ? stationsData.filter((station) => stationSupportsSelectedLines(station.routesServing, selectedLines))
      : stationsData;
    console.info(
      "[stations] fetched",
      stationsData.length,
      "total |", matching.length,
      "after line filters:",
      selectedLines,
      matching.slice(0, 5).map((s) => ({ name: s.name, routes: s.routesServing })),
    );
  }, [stationsData, selectedLines]);

  const tripTrackQuery = useQuery({
    queryKey: ["tripTrack", activeTripId],
    queryFn: () => fetchTripTrack(activeTripId!),
    enabled: Boolean(activeTripId),
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    retry: false,
    retryOnMount: false,
  });

  const upcomingTripStops = activeTripId ? tripTrackQuery.data?.upcomingStops ?? [] : [];
  const followFocusStopIds = upcomingTripStops.slice(0, 2).map((stop) => stop.stopId);
  const followFocusStopSet = useMemo(() => {
    return followFocusStopIds.length > 0 ? new Set(followFocusStopIds) : null;
  }, [followFocusStopIds]);
  const vehiclePosition = tripTrackQuery.data?.vehicle?.position;

  useEffect(() => {
    if (!activeTripId) return;
    const tripPoints = upcomingTripStops
      .map((stop) => stationLookup.get(stop.stopId))
      .filter((station): station is StationSummary => Boolean(station))
      .map((station) => ({ lat: station.latitude, lng: station.longitude }));
    if (tripPoints.length === 0) {
      return;
    }
    requestMapFocus({ id: `trip-${activeTripId}`, points: tripPoints, scroll: false });
  }, [activeTripId, upcomingTripStops, stationLookup, requestMapFocus]);

  const centerMapOnCoordinates = useCallback(
    (lat: number, lng: number, zoom = 14) => {
      if (mapRef.current) {
        try {
          mapRef.current.flyTo({ center: [lng, lat], zoom, duration: 900 });
        } catch {
          // ignore fly errors
        }
      }
    },
    [],
  );

  useEffect(() => {
    const mapInstance = mapRef.current?.getMap?.();
    if (!mapInstance) return;
    const basePadding = { top: 40, right: 40, left: 40, bottom: 40 };
    if (activeTripId) {
      mapInstance.setPadding({
        ...basePadding,
        bottom: FOLLOW_RIBBON_HEIGHT + 80,
      });
    } else {
      mapInstance.setPadding(basePadding);
    }
  }, [activeTripId]);

  useEffect(() => {
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
      map.flyTo({
        center: [vehiclePosition.lng, vehiclePosition.lat],
        zoom: Math.max(viewState.zoom, 15),
        offset: [0, activeTripId ? -FOLLOW_RIBBON_HEIGHT / 2 : 0],
        duration: hasPrevious ? 500 : 0,
        essential: true,
      });
    } catch {
      // ignore fly animation errors
    }
    lastVehicleLocationRef.current = { lat: vehiclePosition.lat, lng: vehiclePosition.lng };
  }, [activeTripId, vehiclePosition, viewState.zoom]);

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
    if (!lineShapesQuery.data) return [];
    return lineShapesQuery.data.map((line) => ({
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
  }, [lineShapesQuery.data]);

  const pathLayers = useMemo(() => {
    if (!lineShapesQuery.data) return [];
    return lineShapesQuery.data.map((line) => {
      const color = hexToColor(line.color);
      const isActive = selectedLines.length === 0 || selectedLines.includes(line.id);
      const widthWhenEmpty = 2;
      const alpha = selectedLines.length === 0 ? 160 : isActive ? 230 : 70;
      return new PathLayer({
        id: `line-shapes-${line.id}`,
        data: line.shapes.map((path) => path.map((coord) => [coord.lng, coord.lat] as [number, number])),
        getPath: (path: [number, number][]) => path,
        getWidth: () => (selectedLines.length === 0 ? widthWhenEmpty : isActive ? 4 : 1),
        getColor: () => [color[0], color[1], color[2], alpha],
        widthUnits: "pixels",
        opacity: isActive ? 0.95 : 0.25,
        jointRounded: true,
        capRounded: true,
        pickable: false,
        parameters: { depthTest: false },
      });
    });
  }, [lineShapesQuery.data, selectedLines]);

  const busRouteLayers = useMemo(() => {
    console.log('[HomeShell] Creating bus route layers for:', busRouteShapes.length, 'routes');
    if (busRouteShapes.length === 0) return [];
    return busRouteShapes.map((route) => {
      const busYellow = "#F4C542";
      const color = hexToColor(route.color ?? busYellow);
      console.log('[HomeShell] Creating layer for bus route', route.lineId, 'with', route.shapes.length, 'shapes');
      return new PathLayer({
        id: `bus-route-${route.lineId}`,
        data: route.shapes.map((path) => path.map((coord) => [coord.lng, coord.lat] as [number, number])),
        getPath: (path: [number, number][]) => path,
        getWidth: () => 3,
        getColor: () => [color[0], color[1], color[2], 180],
        widthUnits: "pixels",
        widthMinPixels: 2,
        widthMaxPixels: 6,
        opacity: 0.7,
        jointRounded: true,
        capRounded: true,
        pickable: false,
        parameters: { depthTest: false },
      });
    });
  }, [busRouteShapes]);

  const homeError = homeQuery.isError ? (homeQuery.error as Error) : null;
  const homeData = homeQuery.data;
  const normalizedSearch = useMemo(() => stopSearch.trim().toLowerCase(), [stopSearch]);
  const filtersActive = normalizedSearch.length > 0 || selectedLines.length > 0;
  const matchesFilters = useCallback(
    (stop: HomeStopSummary) => {
      const matchesText = normalizedSearch
        ? stop.name.toLowerCase().includes(normalizedSearch) ||
          stop.routes.some((route) =>
            route.shortName?.toLowerCase().includes(normalizedSearch) || route.routeId.toLowerCase().includes(normalizedSearch),
          )
        : true;
      if (!matchesText) return false;
      return stopSupportsSelectedLines(stop, selectedLines);
    },
    [normalizedSearch, selectedLines],
  );
  const stationMarkers = useMemo<StationMarker[]>(() => {
    if (!stationsData) return [];
    const busToken = getLineToken("Bus", themeMode);
    const limitToFollowStops = Boolean(activeTripId && followFocusStopSet && followFocusStopSet.size > 0);
    return stationsData.flatMap((station) => {
      if (!stationSupportsSelectedLines(station.routesServing, selectedLines)) {
        return [];
      }
      if (limitToFollowStops && !followFocusStopSet?.has(station.stopId)) {
        return [];
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
      const platformStopIds =
        station.platformStopIds && station.platformStopIds.length > 0 ? station.platformStopIds : [station.stopId];
      const rawMarkers =
        station.platformMarkers && station.platformMarkers.length > 0
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
        (marker) => Number.isFinite(marker.latitude) && Number.isFinite(marker.longitude),
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
  }, [activeTripId, followFocusStopSet, normalizedSearch, selectedLines, stationsData, selectedStopId, themeMode]);

  const vehicleIsBus = routeLooksLikeBus(tripTrackQuery.data?.routeId);
  const isFollowingTrip = Boolean(activeTripId);
  const preferStackedLayout = isFollowingTrip || !isDesktop;
  const layoutBaseClass = "mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 sm:px-6 py-6";
  const stackedLayoutClass = layoutBaseClass;
  const splitLayoutClass = `${layoutBaseClass} lg:grid lg:grid-cols-[340px_minmax(0,1fr)] lg:items-start lg:gap-8`;
  const layoutClass = preferStackedLayout ? stackedLayoutClass : splitLayoutClass;

  const favoriteStops = useMemo(() => {
    if (!homeData) return [];
    const combined = [...homeData.favorites, ...homeData.nearby];
    const uniqueMap = new Map<string, HomeStopSummary>();
    combined.forEach((stop) => {
      uniqueMap.set(stop.stopId, stop);
    });
    return favoriteIds
      .map((id) => uniqueMap.get(id))
      .filter((stop): stop is HomeStopSummary => Boolean(stop));
  }, [homeData, favoriteIds]);
  const nearbyStops = useMemo(() => homeData?.nearby ?? [], [homeData]);
  const filteredFavorites = useMemo(() => favoriteStops.filter(matchesFilters), [favoriteStops, matchesFilters]);
  const filteredNearby = useMemo(() => nearbyStops.filter(matchesFilters), [nearbyStops, matchesFilters]);
  const favoritesFilteredOut = filtersActive && favoriteStops.length > 0 && filteredFavorites.length === 0;
  const nearbyFilteredOut = filtersActive && nearbyStops.length > 0 && filteredNearby.length === 0;

  const greenLineOptions = useMemo(() => LINE_OPTIONS.filter((line) => line.id.startsWith("Green-")), []);
  const nonGreenLineOptions = useMemo(() => LINE_OPTIONS.filter((line) => !line.id.startsWith("Green-")), []);
  const greenAggregateToken = useMemo(() => getLineToken("Green-B", themeMode), [themeMode]);
  const isAnyGreenSelected = useMemo(
    () => selectedLines.some((line) => line.startsWith("Green-")),
    [selectedLines],
  );
  const greenDrawerCollapsedWidth = 40;
  const greenDrawerFullWidth = greenDrawerCollapsedWidth + greenLineOptions.length * 32 + 44;
  const startFollowingTrip = useCallback(
    (tripId: string | null) => {
      if (!tripId) return;
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
    [selectedPlatformStopIds, selectedStopId, selectedStopName, setIsStopSheetOpen, setSelectedPlatformStopIds, setSelectedStopId, clearMapFocus],
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

  const applyGreenSelection = useCallback(
    (lineIds: LineOptionId[]) => {
      setSelectedLines((prev) => {
        const withoutGreen = prev.filter((id) => !id.startsWith("Green-"));
        const merged = new Set(withoutGreen);
        lineIds.forEach((id) => merged.add(id));
        return Array.from(merged);
      });
    },
    [],
  );

  const clearGreenSelection = useCallback(() => {
    setSelectedLines((prev) => prev.filter((id) => !id.startsWith("Green-")));
  }, []);

  const toggleLineFilter = (lineId: LineOptionId) => {
    selectLineGroup(lineId, "toggle");
  };

  const handleGreenDrawerToggle = useCallback(() => {
    setGreenDrawerOpen((prev) => {
      const next = !prev;
      if (next) {
        applyGreenSelection(GREEN_LINE_GROUP);
      } else {
        applyGreenSelection(GREEN_LINE_GROUP);
      }
      return next;
    });
  }, [applyGreenSelection]);

  const handleGreenBranchSelect = useCallback((lineId: LineOptionId) => {
    setSelectedLines((prev) => {
      const nonGreen = prev.filter((id) => !id.startsWith("Green-"));
      const currentGreen = prev.filter((id) => id.startsWith("Green-"));
      const singleAlreadySelected = currentGreen.length === 1 && currentGreen[0] === lineId;
      const nextGreen = singleAlreadySelected ? GREEN_LINE_GROUP : [lineId];
      return [...nonGreen, ...nextGreen];
    });
  }, []);

  const handleGreenDrawerClear = useCallback(() => {
    clearGreenSelection();
    setGreenDrawerOpen(false);
  }, [clearGreenSelection]);

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

  const handleUseDeviceLocation = useCallback(() => {
    if (!navigator.geolocation) {
      alert("Geolocation not supported");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        applyLocation(latitude, longitude);
        centerMapOnCoordinates(latitude, longitude);
      },
      () => {
        alert("Unable to fetch your location");
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }, [applyLocation, centerMapOnCoordinates]);
  useEffect(() => {
    handleUseDeviceLocation();
  }, [handleUseDeviceLocation]);

  useEffect(() => {
    if (isDesktop) {
      setIsNavDrawerOpen(false);
    }
  }, [isDesktop]);

  const recenterMap = useCallback(() => {
    if (!stationsData || stationsData.length === 0 || !mapRef.current) return;
    const closestStations = [...stationsData]
      .map((station) => ({
        station,
        distance: metersBetween(position.lat, position.lng, station.latitude, station.longitude),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 6)
      .map(({ station }) => station);
    if (closestStations.length === 0) {
      return;
    }
    const latitudes = closestStations.map((station) => station.latitude);
    const longitudes = closestStations.map((station) => station.longitude);
    latitudes.push(position.lat);
    longitudes.push(position.lng);
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...longitudes), Math.min(...latitudes)],
      [Math.max(...longitudes), Math.max(...latitudes)],
    ];
    
    try {
      const map = mapRef.current.getMap();
      map.fitBounds(bounds, { padding: 120, duration: 800 });
    } catch {
      // Fallback if fitBounds fails
      const avgLat = latitudes.reduce((sum, lat) => sum + lat, 0) / latitudes.length;
      const avgLng = longitudes.reduce((sum, lng) => sum + lng, 0) / longitudes.length;
      mapRef.current.flyTo({
        center: [avgLng, avgLat],
        zoom: 13,
        duration: 800,
      });
    }
    setHasCenteredMap(true);
  }, [position.lat, position.lng, stationsData]);

  useEffect(() => {
    setHasCenteredMap(false);
    setManualLat(position.lat.toFixed(5));
    setManualLng(position.lng.toFixed(5));
  }, [position.lat, position.lng]);

  useEffect(() => {
    if (!hasCenteredMap && stationsData && stationsData.length > 0) {
      recenterMap();
    }
  }, [hasCenteredMap, recenterMap, stationsData]);

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
    if (!mapRef.current) return;
    
    const latitudes = targets.map((point) => point.lat);
    const longitudes = targets.map((point) => point.lng);
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...longitudes), Math.min(...latitudes)],
      [Math.max(...longitudes), Math.max(...latitudes)],
    ];
    
    try {
      const map = mapRef.current.getMap();
      map.fitBounds(bounds, { padding: 140, duration: 800 });
    } catch {
      // Fallback
      mapRef.current.flyTo({
        center: [targets[0].lng, targets[0].lat],
        zoom: 14,
        duration: 800,
      });
    }
  }, [activeTripId, stationsData, tripTrackQuery.data]);

  const handleMapClick = useCallback(
    (evt: MapLayerMouseEvent) => {
      if (!lineSegments.length) return;
      const { lng, lat } = evt.lngLat;
      const point = { lat, lng };
      let nearest: { lineId: LineOptionId; distance: number } | null = null;
      lineSegments.forEach((line) => {
        line.segments.forEach((segment) => {
          const distance = approxPointToSegmentDistance(point, segment.start, segment.end);
          if (!nearest || distance < nearest.distance) {
            nearest = { lineId: line.lineId, distance };
          }
        });
      });
      const candidate = nearest as { lineId: LineOptionId; distance: number } | null;
      const nearestDistance = candidate?.distance ?? Infinity;
      if (candidate && nearestDistance < 200) {
        selectLineGroup(candidate.lineId, "exclusive");
      }
    },
    [lineSegments, selectLineGroup],
  );

  const handleSelectStop = useCallback(
    (
      stopId: string | null,
      meta?: { lat?: number; lng?: number; name?: string; lineIds?: string[]; platformStopIds?: string[] },
    ) => {
      if (!stopId) return;
      setSelectedStopId(stopId);
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
      } else {
        setSelectedPlatformStopIds(null);
      }
      const station = stationLookup.get(stopId);
      const lat = meta?.lat ?? station?.latitude;
      const lng = meta?.lng ?? station?.longitude;
      const candidateLines = meta?.lineIds ?? station?.routesServing ?? [];
      const focusPoints = buildStopFocusPoints(lat, lng, candidateLines);
      if (focusPoints.length > 0) {
        requestMapFocus({ id: `stop-${stopId}`, points: focusPoints, scroll: true });
      } else {
        clearMapFocus();
      }
    },
    [setIsStopSheetOpen, setSelectedLines, setSelectedStopId, setSelectedStopName, setSelectedPlatformStopIds, stationLookup, buildStopFocusPoints, requestMapFocus, clearMapFocus],
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

  const handleMapSearchSelect = useCallback(
    (result: MapSearchResult) => {
      applyLocation(result.lat, result.lng);
      centerMapOnCoordinates(result.lat, result.lng);
      setMapSearchQuery(result.label);
      setMapSearchResults([]);
      setMapSearchError(null);
    },
    [applyLocation, centerMapOnCoordinates],
  );

  const handleMapSearchSave = useCallback(
    (result: MapSearchResult) => {
      saveCurrentLocation(result.label, { lat: result.lat, lng: result.lng, stopId: null });
    },
    [saveCurrentLocation],
  );

  const applyManualCoordinates = useCallback(
    (evt: React.FormEvent<HTMLFormElement>) => {
      evt.preventDefault();
      setManualCoordsError(null);
      const lat = Number(manualLat);
      const lng = Number(manualLng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        setManualCoordsError("Enter valid latitude/longitude");
        return;
      }
      applyLocation(lat, lng);
      centerMapOnCoordinates(lat, lng);
    },
    [applyLocation, centerMapOnCoordinates, manualLat, manualLng],
  );

  const closeStopSheet = useCallback(() => {
    setIsStopSheetOpen(false);
    setSelectedStopId(null);
    setSelectedStopName(null);
    setSelectedPlatformStopIds(null);
    setBusRouteShapes([]);
    clearMapFocus();
  }, [setIsStopSheetOpen, setSelectedStopId, setSelectedPlatformStopIds, clearMapFocus]);

  const stopFollowingTrip = useCallback(() => {
    setActiveTripId(null);
    if (followResumeContext?.stopId) {
      setSelectedStopId(followResumeContext.stopId);
      setSelectedStopName(followResumeContext.name ?? null);
      setSelectedPlatformStopIds(followResumeContext.platformStopIds ?? null);
      setIsStopSheetOpen(true);
    }
    setFollowResumeContext(null);
    lastVehicleLocationRef.current = null;
    clearMapFocus();
  }, [followResumeContext, setIsStopSheetOpen, setSelectedPlatformStopIds, setSelectedStopId, setSelectedStopName, clearMapFocus]);

  useEffect(() => {
    if (activeTripId && tripTrackQuery.isError && tripTrackQuery.failureCount > 0) {
      const timer = setTimeout(() => {
        stopFollowingTrip();
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [activeTripId, tripTrackQuery.isError, tripTrackQuery.failureCount, stopFollowingTrip]);

  return (
    <div className="flex min-h-screen flex-col" style={{ background: "var(--background)", color: "var(--foreground)" }}>
      <header className="sticky top-0 z-40 border-b bg-[color:var(--background)]/95 backdrop-blur" style={{ borderColor: "var(--border)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-2.5 sm:px-6">
          <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-wide" style={{ color: "var(--foreground)" }}>
            <span className="text-[10px] uppercase tracking-[0.5em] text-[color:var(--muted)]">LineLight</span>
            <span className="hidden sm:inline">Transit Radar</span>
          </Link>
          {isDesktop ? (
            <nav className="hidden items-center gap-2 lg:flex" aria-label="Primary navigation">
              {PRIMARY_NAV_LINKS.map((link) => (
                <Link key={link.href} href={link.href} className={NAV_BUTTON_CLASS}>
                  {link.icon}
                  <span>{link.label}</span>
                </Link>
              ))}
              <button type="button" onClick={toggleTheme} className={NAV_BUTTON_CLASS}>
                {themeMode === "dark" ? <FiSun /> : <FiMoon />}
                <span className="hidden sm:inline">{themeMode === "dark" ? "Light" : "Dark"}</span>
              </button>
            </nav>
          ) : (
            <div className="flex items-center gap-2 lg:hidden">
              <button
                type="button"
                onClick={toggleTheme}
                className="icon-button"
                aria-label="Toggle theme"
              >
                {themeMode === "dark" ? <FiSun /> : <FiMoon />}
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => setIsNavDrawerOpen((prev) => !prev)}
                aria-expanded={isNavDrawerOpen}
                aria-controls="primary-nav-panel"
                aria-label={isNavDrawerOpen ? "Close navigation" : "Open navigation"}
              >
                {isNavDrawerOpen ? <FiX /> : <FiMenu />}
              </button>
            </div>
          )}
        </div>
        {!isDesktop && (
          <div
            id="primary-nav-panel"
            className={`mx-auto w-full max-w-6xl px-4 pb-3 transition-all duration-200 sm:px-6 ${
              isNavDrawerOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            <nav
              className="rounded-2xl border bg-[color:var(--card)] p-4 shadow-xl"
              style={{ borderColor: "var(--border)" }}
              aria-label="Primary navigation drawer"
            >
              <div className="flex flex-col gap-2">
                {PRIMARY_NAV_LINKS.map((link) => (
                  <Link
                    key={`drawer-${link.href}`}
                    href={link.href}
                    className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-base font-semibold"
                    style={{ color: "var(--foreground)" }}
                    onClick={() => setIsNavDrawerOpen(false)}
                  >
                    {link.icon}
                    <span>{link.label}</span>
                  </Link>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    toggleTheme();
                    setIsNavDrawerOpen(false);
                  }}
                  className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-base font-semibold"
                  style={{ color: "var(--foreground)" }}
                >
                  {themeMode === "dark" ? <FiSun /> : <FiMoon />}
                  <span>{themeMode === "dark" ? "Light mode" : "Dark mode"}</span>
                </button>
              </div>
            </nav>
          </div>
        )}
      </header>
      <main
        className={`${layoutClass} relative overflow-hidden`}
        data-breakpoint={layoutBreakpoint}
        data-layout={preferStackedLayout ? "stacked" : "split"}
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
        {!isFollowingTrip && (
        <div className="w-full space-y-5 lg:w-[340px] lg:shrink-0 lg:space-y-5 lg:sticky lg:top-6 lg:pr-1">
          <div className="surface px-6 py-5">
            <div className="flex items-center justify-between gap-2">
              <p className="heading-label" style={{ color: "var(--muted)" }}>
                Filter stops or lines
              </p>
              <span className="text-[11px] uppercase tracking-wide" style={{ color: "var(--muted)" }}>
                Favorites & Nearby
              </span>
            </div>
            <div className="mt-3">
              <div className="flex items-center">
                  <FiSearch className="pointer-events-none mr-3 text-[color:var(--muted)]" />
                  <input
                    value={stopSearch}
                    onChange={(evt) => setStopSearch(evt.target.value)}
                    placeholder="Government Center, Red, Bus 1…"
                    className="input flex-1 pr-4"
                    aria-label="Search favorites and nearby stops"
                  />
                </div>
            </div>
          </div>
            <HomePanels
              favorites={filteredFavorites}
              nearby={filteredNearby}
              isLoading={homeQuery.isLoading}
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
              selectedStopId={selectedStopId}
              favoritesFilteredOut={favoritesFilteredOut}
              nearbyFilteredOut={nearbyFilteredOut}
              filtersActive={filtersActive}
              isCompactLayout={!isDesktop}
            />
        </div>
        )}
          <div className="flex-1 space-y-5">
          <div ref={mapSectionRef} className="panel" style={{ position: "relative" }}>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between" style={{ position: "relative", zIndex: 20 }}>
              <div>
                <p className="heading-label" style={{ color: "var(--muted)" }}>
                  Map spotlight
                </p>
                <h2 className="text-xl font-semibold" style={{ color: "var(--foreground)" }}>
                  Tap stop to view ETAs
                </h2>
                <div className="mt-1 text-xs font-medium" style={{ color: "var(--muted)" }}>
                  Stops on map: <span style={{ color: "var(--foreground)" }}>{stationMarkers.length}</span>
                </div>
                {selectedStopId && selectedStopName && (
                  <div
                    className="mt-2 inline-flex items-center gap-2 rounded-full border border-cyan-400/40 bg-cyan-500/10 px-3 py-1 text-xs text-white"
                    aria-live="polite"
                  >
                    <span className="text-[10px] uppercase tracking-[0.3em] text-cyan-200">Viewing</span>
                    <span className="font-semibold text-white">{selectedStopName}</span>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-2 text-xs text-slate-400 sm:flex-row sm:flex-wrap sm:items-center">
                {selectedStopId && selectedStopName && (
                <div className="mt-2 inline-flex items-center gap-2 chip chip-live" aria-live="polite">
                    <span className="text-[10px] uppercase tracking-[0.3em]">Viewing</span>
                    <span className="font-semibold">{selectedStopName}</span>
                  </div>
                )}
                {activeTripId && tripTrackQuery.data && (
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-200">
                    <span className="chip chip-live">
                      <FiZap /> Following {tripTrackQuery.data.routeId} → {tripTrackQuery.data.destination}
                    </span>
                    <button type="button" className="btn btn-ghost px-3 py-1 text-xs" onClick={stopFollowingTrip}>
                      Stop
                    </button>
                  </div>
                )}
              </div>
              <div
                className="-mx-1 flex flex-nowrap items-center gap-2 overflow-x-auto pb-2 pl-1"
                style={{ WebkitOverflowScrolling: "touch" }}
              >
                {nonGreenLineOptions.map((line) => {
                  const isActive = selectedLines.includes(line.id);
                  const token = getLineToken(line.id, themeMode);
                  if (line.id === "Mattapan") {
                    return (
                      <button
                        key={line.id}
                        type="button"
                        onClick={() => toggleLineFilter(line.id)}
                        aria-pressed={isActive}
                        className={`line-dot-label-button focus-outline ${isActive ? "active" : ""}`}
                        style={{
                          background: isActive ? token.tint : "transparent",
                          color: isActive ? token.textOnTint : "var(--foreground)",
                        }}
                        title="Toggle Mattapan Trolley"
                      >
                        <span className="line-dot" style={{ background: token.color }} />
                        <span>Mattapan</span>
                      </button>
                    );
                  }
                  return (
                    <button
                      key={line.id}
                      type="button"
                      onClick={() => toggleLineFilter(line.id)}
                      aria-pressed={isActive}
                      aria-label={`Toggle ${line.label}`}
                      title={`Toggle ${line.label}`}
                      className={`line-dot-button focus-outline ${isActive ? "active" : ""}`}
                      style={{
                        borderColor: isActive ? token.color : undefined,
                        background: isActive ? token.tint : "transparent",
                      }}
                    >
                      <span className="sr-only">{line.label}</span>
                      <span className="line-dot" style={{ background: token.color }} />
                    </button>
                  );
                })}
                <div className="flex items-center gap-2">
                  <div
                    className={`green-branch-shell ${greenDrawerOpen ? "open" : ""} ${isAnyGreenSelected ? "active" : ""}`}
                    style={{
                      maxWidth: greenDrawerOpen ? greenDrawerFullWidth : greenDrawerCollapsedWidth,
                      background: greenDrawerOpen || isAnyGreenSelected ? greenAggregateToken.tint : "transparent",
                    }}
                    role="group"
                    aria-label="Green Line branches"
                  >
                    <button
                      type="button"
                      onClick={handleGreenDrawerToggle}
                      className="green-branch-toggle focus-outline"
                      aria-expanded={greenDrawerOpen}
                      title="Toggle Green Line branches"
                    >
                      <span className="sr-only">Toggle Green Line branches</span>
                      <span className="line-dot" style={{ background: greenAggregateToken.color }} />
                    </button>
                    <div
                      className="green-branch-letters"
                      style={{ 
                        opacity: greenDrawerOpen ? 1 : 0,
                        maxWidth: greenDrawerOpen ? '200px' : '0px',
                        pointerEvents: greenDrawerOpen ? 'auto' : 'none'
                      }}
                      aria-hidden={!greenDrawerOpen}
                    >
                      {greenLineOptions.map((line) => {
                        const isActive = selectedLines.includes(line.id);
                        const token = getLineToken(line.id, themeMode);
                        const letter = line.label.replace("Green ", "");
                        return (
                          <button
                            key={line.id}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleGreenBranchSelect(line.id);
                            }}
                            aria-pressed={isActive}
                            className="green-branch-letter focus-outline"
                            style={{ color: isActive ? token.color : "var(--muted)" }}
                          >
                            {letter}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        className="green-branch-letter focus-outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleGreenDrawerClear();
                        }}
                        aria-label="Clear Green Line selection"
                        style={{ color: "var(--muted)" }}
                      >
                        <FiX />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-4 flex w-full flex-col gap-4 lg:flex-row lg:items-start">
              <div className="flex-1 min-w-[260px]">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <label htmlFor="map-spotlight-search" className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
                    Map input
                  </label>
                  <button
                    type="button"
                    className={`icon-button focus-outline ${showAdvancedCoords ? "bg-[color:var(--surface)]" : ""}`}
                    onClick={() => {
                      setShowAdvancedCoords((prev) => !prev);
                      setManualCoordsError(null);
                    }}
                    aria-pressed={showAdvancedCoords}
                    aria-controls="map-advanced-coordinates"
                    aria-label={showAdvancedCoords ? "Hide manual coordinates" : "Show manual coordinates"}
                  >
                    <FiSliders />
                  </button>
                </div>
                <div className="flex items-center">
                  <FiSearch className="pointer-events-none mr-3 text-[color:var(--muted)]" />
                  <input
                    id="map-spotlight-search"
                    value={mapSearchQuery}
                    onChange={(evt) => setMapSearchQuery(evt.target.value)}
                    placeholder="e.g. Fenway Park, Quincy, office address"
                    className="input flex-1 pr-10"
                  />
                  {mapSearchQuery && (
                    <button
                      type="button"
                      className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full px-2 text-xs"
                      style={{ color: "var(--muted)" }}
                      onClick={() => {
                        setMapSearchQuery("");
                        setMapSearchResults([]);
                      }}
                      aria-label="Clear map search"
                    >
                      ✕
                    </button>
                  )}
                </div>
                {mapSearchError && (
                  <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                    {mapSearchError}
                  </p>
                )}
                {mapSearchLoading && (
                  <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                    Searching…
                  </p>
                )}
                {mapSearchResults.length > 0 && (
                  <div className="mt-2 rounded-2xl border" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
                    {mapSearchResults.map((result) => (
                      <div key={result.id} className="flex items-center gap-2 border-b px-3 py-2 text-left text-xs last:border-b-0" style={{ borderColor: "var(--border)" }}>
                        <button
                          type="button"
                          className="flex-1 text-left text-sm hover:text-[color:var(--accent)]"
                          onClick={() => handleMapSearchSelect(result)}
                        >
                          {result.label}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost px-2 py-0.5 text-xs"
                          onClick={() => handleMapSearchSave(result)}
                          aria-label={`Save ${result.label}`}
                        >
                          <FiBookmark />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {showAdvancedCoords && (
                  <form
                    id="map-advanced-coordinates"
                    onSubmit={applyManualCoordinates}
                    className="mt-3 flex flex-wrap items-center gap-3 rounded-2xl border px-3 py-3"
                    style={{ borderColor: "var(--border)", background: "var(--surface)" }}
                  >
                    <label className="flex-1 text-xs" style={{ color: "var(--muted)" }}>
                      Latitude
                      <input
                        value={manualLat}
                        onChange={(evt) => setManualLat(evt.target.value)}
                        inputMode="decimal"
                        className="input mt-1 w-full"
                      />
                    </label>
                    <label className="flex-1 text-xs" style={{ color: "var(--muted)" }}>
                      Longitude
                      <input
                        value={manualLng}
                        onChange={(evt) => setManualLng(evt.target.value)}
                        inputMode="decimal"
                        className="input mt-1 w-full"
                      />
                    </label>
                    <div className="flex flex-col gap-1">
                      <button
                        type="submit"
                        className="btn btn-primary px-4 py-1 text-sm"
                      >
                        Apply
                      </button>
                      {manualCoordsError && (
                        <p className="text-xs" style={{ color: "var(--danger, #e11d48)" }}>
                          {manualCoordsError}
                        </p>
                      )}
                    </div>
                  </form>
                )}
              </div>
              <div className="w-full rounded-2xl border px-3 py-3 lg:max-w-sm" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold" style={{ color: "var(--muted)" }}>
                    <FiBookmark /> Saved locations
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost px-3 py-1 text-xs"
                    onClick={() => {
                      setIsSavingLocation((prev) => !prev);
                      setNewLocationName(selectedStopName ?? "Work");
                    }}
                  >
                    {isSavingLocation ? "Cancel" : "Save current"}
                  </button>
                </div>
                {isSavingLocation && (
                  <form
                    className="mt-3 flex flex-col gap-2"
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
                        className="rounded border-[color:var(--border)]"
                      />
                      Save current line filters
                    </label>
                    <button
                      type="submit"
                      className="btn btn-primary px-3 py-1 text-sm"
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
                                onClick={() => jumpToSavedLocation(location)}
                              >
                                Use
                              </button>
                              <button
                                type="button"
                                className="icon-button focus-outline"
                                onClick={() => startEditingLocation(location)}
                                aria-label="Rename saved location"
                              >
                                <FiEdit />
                              </button>
                              <button
                                type="button"
                                className="icon-button focus-outline"
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
          </div>
          <div className="relative min-h-[360px] overflow-hidden rounded-2xl border lg:h-[520px]" style={{ borderColor: "var(--border)", zIndex: 50 }}>
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
              <div className="map-center-target" />
            </div>
            <div className="absolute right-4 top-4 z-30 flex flex-col gap-2">
              <button
                type="button"
                onClick={handleUseDeviceLocation}
                className="icon-button focus-outline text-lg"
                aria-label="Use my location"
                title="Use my location"
              >
                <FiMapPin />
              </button>
              <button
                type="button"
                onClick={() => setShowBusStops((prev) => !prev)}
                className={`icon-button focus-outline text-lg ${showBusStops ? "" : ""}`}
                aria-pressed={showBusStops}
                aria-label="Toggle bus stops"
                title="Toggle bus stops"
                style={{
                  borderColor: showBusStops ? "rgba(250,204,21,0.8)" : "var(--border)",
                  color: showBusStops ? "#b45309" : "var(--foreground)",
                }}
              >
                <BusIcon className="h-4 w-4" color={showBusStops ? "#fbbf24" : "#facc15"} />
              </button>
              <button
                type="button"
                onClick={() => recenterMap()}
                className="icon-button focus-outline text-lg"
                disabled={stationsLoading}
                aria-label="Recenter map"
                title="Recenter map"
              >
                <FiCrosshair />
              </button>
            </div>
            <MapGL
              ref={mapRef}
              reuseMaps
              mapLib={maplibregl}
              mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
              style={{ width: "100%", height: "100%" }}
              initialViewState={viewState}
              onMove={(evt) => setViewState(evt.viewState as ViewState)}
              onClick={handleMapClick}
            >
              {viewState.latitude != null && viewState.longitude != null && (
                <DeckGL
                  style={{ position: "absolute", inset: "0", pointerEvents: "none" }}
                  layers={[...pathLayers, ...busRouteLayers]}
                  viewState={viewState}
                  controller={false}
                />
              )}
              {stationMarkers.map((marker) => (
                <Marker key={marker.markerKey} latitude={marker.latitude} longitude={marker.longitude}>
                  <button
                    type="button"
                    className={`focus-outline ${
                      marker.isBusOnly ? "h-2.5 w-2.5" : "h-4 w-4"
                    } rounded-full border-2 transition-all duration-200 ${
                      marker.isSelected
                        ? "scale-150 border-cyan-300 map-marker-selected"
                        : hoveredMarkerId === marker.markerStopId
                          ? "scale-125 border-cyan-200"
                          : "border-white/30"
                    }`}
                    style={{
                      background: marker.dotStyle?.backgroundColor ?? marker.color,
                      backgroundImage: marker.dotStyle?.backgroundImage,
                      backgroundSize: marker.dotStyle?.backgroundSize,
                      cursor: "pointer",
                      boxShadow:
                        hoveredMarkerId === marker.markerStopId
                          ? "0 0 10px rgba(34,211,238,0.45)"
                          : "0 2px 6px rgba(0,0,0,0.5)",
                      zIndex: marker.zIndex,
                    }}
                    onPointerDown={(evt) => {
                      evt.preventDefault();
                      evt.stopPropagation();
                    }}
                    onPointerUp={(evt) => {
                      evt.preventDefault();
                      evt.stopPropagation();
                    }}
                    onPointerMove={(evt) => {
                      evt.preventDefault();
                      evt.stopPropagation();
                    }}
                    onMouseEnter={() => setHoveredMarkerId(marker.markerStopId)}
                    onMouseLeave={() => setHoveredMarkerId((prev) => (prev === marker.markerStopId ? null : prev))}
                    onClick={(evt) => {
                      evt.preventDefault();
                      evt.stopPropagation();
                      handleSelectStop(marker.stopId, {
                        lat: marker.latitude,
                        lng: marker.longitude,
                        name: marker.name,
                        lineIds: marker.routesServing,
                        platformStopIds: marker.platformStopIds,
                      });
                    }}
                    aria-label={`View ${marker.name}`}
                    aria-pressed={marker.isSelected}
                    aria-current={marker.isSelected ? "true" : undefined}
                    data-stop-id={marker.stopId}
                    title={marker.name}
                  />
                </Marker>
              ))}
              {savedLocations.map((location) => (
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
              {activeTripId &&
                tripTrackQuery.data?.vehicle?.position?.lat != null &&
                tripTrackQuery.data.vehicle.position.lng != null && (
                  <Marker
                    latitude={tripTrackQuery.data.vehicle.position.lat}
                    longitude={tripTrackQuery.data.vehicle.position.lng}
                  >
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-white/60 bg-slate-900/90 text-white shadow-2xl ring-2 ring-cyan-300/60"
                      title="Tracked vehicle"
                    >
                      {vehicleIsBus ? <BusIcon className="h-5 w-5" color="#fef9c3" /> : <TrainIcon className="h-5 w-5" color="#fee2e2" />}
                    </div>
                  </Marker>
                )}
            </MapGL>
            {lineShapesQuery.isLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/20 text-sm text-slate-300">
                Loading line paths…
              </div>
            )}
            {lineShapesQuery.isError && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-sm text-rose-400">
                Unable to load line shapes. Try again shortly.
              </div>
            )}
            {!lineShapesQuery.isLoading && (!lineShapesQuery.data || lineShapesQuery.data.length === 0) && !lineShapesQuery.isError && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-sm text-slate-300">
                Line shapes unavailable.
              </div>
            )}
          </div>
        </div>
      </main>
      {selectedStopId && isStopSheetOpen && (
        <>
          <div className="fixed inset-0 z-30 pointer-events-none" aria-hidden="true">
            <div className="absolute inset-0 bg-black/70" />
          </div>
          <StopSheetPanel
            stopId={selectedStopId}
            platformStopIds={selectedPlatformStopIds ?? undefined}
            isOpen={isStopSheetOpen}
            onClose={closeStopSheet}
            onFollowTrip={startFollowingTrip}
            onBusRoutesChange={setBusRouteShapes}
            mapPanelRef={mapSectionRef}
          />
        </>
      )}
      {activeTripId && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-6 pointer-events-none"
          aria-live="polite"
        >
          <div
            className={`pointer-events-auto panel mx-auto w-full max-w-6xl space-y-4 rounded-[32px] border bg-opacity-90 transition duration-400 ${tripTrackQuery.isLoading ? "translate-y-10 opacity-0" : "translate-y-0 opacity-100"}`}
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
                    borderColor: followPanelTokens.border,
                    background:
                      themeMode === "dark" ? "rgba(15,23,42,0.6)" : "rgba(226,232,240,0.7)",
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
            <div className="overflow-x-auto pb-1">
              {tripTrackQuery.isLoading ? (
                <p className="px-1 text-sm" style={{ color: followPanelTokens.subtext }}>
                  Locking onto vehicle…
                </p>
              ) : tripTrackQuery.isError ? (
                <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm">
                  <p className="font-medium text-rose-300">Trip tracking unavailable</p>
                  <p className="mt-1 text-xs text-rose-200">
                    This trip may have ended or vehicle data is not available. Try selecting another departure.
                  </p>
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
                    return (
                      <button
                        key={`${stop.stopId}-${idx}`}
                        type="button"
                        onClick={() => handleJumpToStop(stop.stopId)}
                        className="flex min-w-[180px] flex-col rounded-2xl border px-4 py-3 text-left transition"
                        style={{
                          borderColor: isPrimary ? followPanelTokens.border : followPanelTokens.cardBorder,
                          background: followPanelTokens.card,
                          color: followPanelTokens.text,
                        }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold">{stop.stopName}</span>
                          {isPrimary && (
                            <span className="chip chip-live text-[10px] font-semibold uppercase tracking-[0.3em]">
                              Next
                            </span>
                          )}
                        </div>
                        <div className="mt-2 flex items-end gap-1">
                          <span className="text-3xl font-bold">{etaLabel}</span>
                          <span className="text-xs uppercase" style={{ color: followPanelTokens.subtext }}>
                            ETA
                          </span>
                        </div>
                        <div className="mt-2 flex items-center gap-2 text-xs">
                          <EtaSourceIndicator source={stop.source} />
                          <span style={{ color: followPanelTokens.subtext }}>
                            {stop.source === "schedule" ? "Scheduled" : ""}
                          </span>
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
