"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchStationBoard, fetchRouteShapes } from "@/lib/api";
import type {
  GetStationBoardResponse,
  StationBoardRoutePrimary,
  StationDeparture,
  StationAlert,
  StationFacility,
  StationBoardPrimary,
  StationEta,
  StationBoardDetails,
  LineShapeResponse,
} from "@linelight/core";
import { formatEta } from "@/lib/time";
import { EtaSourceIndicator } from "./EtaSourceIndicator";
import { LineBadge } from "@/components/common/LineBadge";
import { DirectionArrowIcon } from "@/components/common/DirectionArrowIcon";
import { InfoTooltip } from "@/components/common/InfoTooltip";
import {
  FiCheckCircle,
  FiAlertTriangle,
  FiArrowRightCircle,
  FiChevronDown,
  FiInfo,
  FiZap,
  FiMapPin,
  FiXCircle,
  FiChevronRight,
  FiClock,
  FiMap,
} from "react-icons/fi";
import { humanizeDirection } from "@/lib/directions";
import { getLineToken, getDirectionToken } from "@/lib/designTokens";
import { useThemeMode } from "@/hooks/useThemeMode";
import { getLandmarkImage, getStopHue } from "@/lib/stopStyling";

interface StopSheetPanelProps {
  stopId: string;
  isOpen: boolean;
  platformStopIds?: string[];
  preferredDirection?: string | null;
  onClose: () => void;
  onFollowTrip: (tripId: string | null) => void;
  onBusRoutesChange?: (shapes: LineShapeResponse[]) => void;
  mapPanelRef?: RefObject<HTMLElement | null>;
  panelRootRef?: RefObject<HTMLElement | null>;
  allowRefs?: Array<RefObject<HTMLElement | null>>;
}

const NO_EXTRA_REFS: ReadonlyArray<RefObject<HTMLElement | null>> = [];

const statusTone = (status?: string) => {
  switch (status) {
    case "delayed":
      return {
        bg: "bg-amber-500/15",
        text: "text-amber-200",
        border: "border-amber-400/30",
        icon: <FiAlertTriangle className="mr-1" />,
        label: "Delayed",
      };
    case "cancelled":
    case "no_service":
      return {
        bg: "bg-rose-500/15",
        text: "text-rose-200",
        border: "border-rose-400/30",
        icon: <FiXCircle className="mr-1" />,
        label: "Cancelled",
      };
    case "on_time":
      return null;
    default:
      return {
        bg: "bg-white/5",
        text: "text-slate-300",
        border: "border-white/15",
        icon: <FiInfo className="mr-1" />,
        label: status ?? "Status unknown",
      };
  }
};

const normalizeDestinationLabel = (value?: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[-\u2014]+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
};

const formatTimeLabel = (iso?: string) => {
  if (!iso) return "—";
  try {
    const date = new Date(iso);
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "—";
  }
};

const getRouteKey = (route: StationBoardRoutePrimary) => `${route.routeId}-${route.direction}`;

type RouteGroup = {
  routeId: string;
  shortName: string;
  directions: StationBoardRoutePrimary[];
};

type StationDepartureWithTrip = StationDeparture & { tripId?: string | null };

const normalizeDirectionForComparison = (direction?: string | null): string | null => {
  if (!direction) return null;
  const cleaned = direction.trim().toLowerCase().replace(/[^a-z]/g, "");
  return cleaned || null;
};

const directionsMatch = (departureDirection?: string | null, routeDirection?: string | null): boolean => {
  const normalizedDeparture = normalizeDirectionForComparison(departureDirection);
  const normalizedRoute = normalizeDirectionForComparison(routeDirection);
  if (!normalizedDeparture || !normalizedRoute) {
    return false;
  }
  if (normalizedDeparture === normalizedRoute) return true;
  return (
    normalizedDeparture.includes(normalizedRoute) ||
    normalizedRoute.includes(normalizedDeparture)
  );
};

const toDirectionId = (direction?: string | null): 0 | 1 | null => {
  if (!direction) return null;
  const normalized = direction.toLowerCase();
  if (normalized.includes("inbound") || normalized.includes("north") || normalized.includes("east")) return 0;
  if (normalized.includes("outbound") || normalized.includes("south") || normalized.includes("west")) return 1;
  return null;
};

const formatWalkLabel = (board?: GetStationBoardResponse["primary"]) => {
  if (!board) return null;
  if (board.walkMinutes != null) {
    return `${Math.round(board.walkMinutes)} min walk`;
  }
  if (board.distanceMeters != null) {
    const meters = board.distanceMeters;
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(1)} km away`;
    }
    return `${Math.round(meters)} m away`;
  }
  return null;
};

const mapEtaToDeparture = (
  eta: StationEta,
  route: StationBoardRoutePrimary,
): StationDepartureWithTrip => ({
  routeId: route.routeId,
  shortName: route.shortName,
  direction: route.direction,
  destination: humanizeDirection(route.direction),
  scheduledTime: eta.scheduledTime,
  predictedTime: eta.predictedTime,
  etaMinutes: eta.etaMinutes,
  source: eta.source ?? "unknown",
  status: eta.status ?? "on_time",
  tripId: eta.tripId ?? null,
});

const getDepartureDirectionKey = (departure: StationDeparture) => {
  const directionValue = departure.direction ?? "";
  return `${departure.routeId}-${directionValue}`;
};

const getRouteDotLabel = (routeLabel: string, routeId: string): string => {
  if (routeId.startsWith("Green-")) {
    return routeId.split("-")[1] ?? "G";
  }
  if (/^\d+$/.test(routeLabel)) {
    return routeLabel;
  }
  return routeLabel.charAt(0).toUpperCase();
};

const getRouteLabelText = (routeLabel: string, routeId: string): string => {
  if (routeId.startsWith("Green-")) {
    return routeId.split("-")[1] ?? "G";
  }
  if (/^\d+$/.test(routeLabel)) {
    return routeLabel;
  }
  return routeLabel;
};

const LoadingSkeleton = () => (
  <div className="space-y-6">
    <div className="panel">
      <div className="h-3 w-24 animate-pulse rounded bg-[color:var(--border)]" />
      <div className="mt-4 h-10 w-32 animate-pulse rounded bg-[color:var(--surface)]" />
      <div className="mt-2 h-4 w-48 animate-pulse rounded bg-[color:var(--surface)]" />
    </div>
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, idx) => (
        <div key={`skeleton-${idx}`} className="h-16 panel">
          <div className="h-full w-full animate-pulse rounded-md bg-[color:var(--surface-soft)]" />
        </div>
      ))}
    </div>
  </div>
);

const AlertList = ({ alerts }: { alerts: StationAlert[] }) => {
  if (alerts.length === 0) {
    return (
      <div className="chip chip-live flex items-center gap-2 text-sm">
        <FiCheckCircle /> No active alerts for this stop.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {alerts.map((alert) => (
        <div key={alert.id} className="panel border-[color:var(--line-orange)]/40 bg-white text-[color:var(--foreground)] shadow-sm">
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.3em]" style={{ color: "var(--line-orange)" }}>
            <FiAlertTriangle /> {alert.severity}
          </p>
          <p className="mt-1 font-semibold">{alert.header}</p>
          {alert.description && <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>{alert.description}</p>}
        </div>
      ))}
    </div>
  );
};

const FacilitiesList = ({ facilities }: { facilities: StationFacility[] }) => {
  if (facilities.length === 0) {
    return (
      <div className="chip flex items-center gap-2 text-sm">
        <FiInfo /> No facilities data available.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {facilities.map((facility) => (
        <div key={facility.id} className="panel text-sm">
          <p className="flex items-center gap-2 font-semibold capitalize">
            <FiMapPin /> {facility.type}
          </p>
          <span className="chip mt-1">{facility.status ?? "Unknown"}</span>
          {facility.description && (
            <p className="mt-2 text-xs text-muted">{facility.description}</p>
          )}
        </div>
      ))}
    </div>
  );
};

const HeroPlaceholder = () => (
  <div className="panel space-y-3">
    <div className="h-4 w-32 animate-pulse rounded bg-[color:var(--border)]" />
    <div className="flex items-center gap-4">
      <div className="h-3 w-24 animate-pulse rounded bg-[color:var(--surface)]" />
      <div className="h-3 w-16 animate-pulse rounded bg-[color:var(--surface)]" />
    </div>
    <div className="flex items-center justify-between gap-4">
      <div className="h-7 w-16 animate-pulse rounded bg-[color:var(--surface-soft)]" />
      <div className="flex items-center gap-2">
        <div className="h-6 w-6 animate-pulse rounded-full bg-[color:var(--surface-soft)]" />
        <div className="h-7 w-20 animate-pulse rounded bg-[color:var(--surface-soft)]" />
      </div>
    </div>
  </div>
);

const DepartureListSkeleton = () => (
  <div className="overflow-hidden rounded-2xl border" style={{ borderColor: "var(--border)" }}>
    {Array.from({ length: 3 }).map((_, idx) => (
      <div
        key={`departure-skeleton-${idx}`}
        className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b px-4 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="space-y-3">
          <div className="h-4 w-36 animate-pulse rounded bg-[color:var(--surface)]" />
          <div className="flex items-center gap-2">
            <div className="h-3 w-24 animate-pulse rounded bg-[color:var(--surface-soft)]" />
            <div className="h-3 w-16 animate-pulse rounded bg-[color:var(--surface-soft)]" />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="h-4 w-4 animate-pulse rounded-full bg-[color:var(--surface-soft)]" />
          <div className="h-8 w-12 animate-pulse rounded bg-[color:var(--surface-soft)]" />
        </div>
      </div>
    ))}
  </div>
);

const DepartureList = ({
  departures,
  onFollowTrip,
  defaultDestinationLabel,
}: {
  departures: StationDeparture[];
  onFollowTrip: (tripId: string | null) => void;
  defaultDestinationLabel?: string | null;
}) => {
  const { mode: themeMode } = useThemeMode();
  if (departures.length === 0) {
    return (
      <div
        className="rounded-2xl border px-4 py-4 text-sm"
        style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--muted)" }}
      >
        There are no more departures scheduled for this direction today.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border" style={{ borderColor: "var(--border)" }}>
      {departures.map((departure, idx) => {
        const tone = statusTone(departure.status);
        const tripId = (departure as StationDepartureWithTrip).tripId ?? null;
        const isLive = departure.source === "prediction" || departure.source === "blended";
        const lineToken = getLineToken(departure.routeId, themeMode);
        const isStriped = idx % 2 === 1;
        return (
          <button
            key={`${departure.routeId}-${departure.direction}-${departure.destination}-${idx}`}
            type="button"
            className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b px-4 py-2.5 text-left transition last:border-b-0 hover:bg-[var(--surface)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
            onClick={() => tripId && onFollowTrip(tripId)}
            disabled={!tripId}
            aria-disabled={!tripId}
            title={tripId ? "Follow this trip" : "Trip tracking not available"}
            style={{ 
              color: "var(--foreground)", 
              background: isStriped ? `color-mix(in srgb, ${lineToken.color} 6%, var(--surface))` : "var(--surface)", 
              borderColor: "var(--border)" 
            }}
          >
            <div>
                <p className="text-base font-semibold">
                  {normalizeDestinationLabel(departure.destination) ??
                    defaultDestinationLabel ??
                    departure.shortName ??
                    departure.routeId ??
                    humanizeDirection(departure.direction)}
                </p>
              <div className="mt-1 flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                <span>{formatTimeLabel(departure.predictedTime ?? departure.scheduledTime)}</span>
                {tone && (
                  <span className="inline-flex items-center gap-1" style={{ color: tone.text }}>
                    {tone.icon}
                    {tone.label}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <div className="flex items-center justify-end gap-1.5">
                  <EtaSourceIndicator source={departure.source} />
                  <p className="text-2xl font-bold" style={{ color: "var(--foreground)" }}>
                    {formatEta(departure.etaMinutes)}
                  </p>
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
};

export const StopSheetPanel = ({
  stopId,
  isOpen,
  onClose,
  onFollowTrip,
  platformStopIds,
  preferredDirection,
  onBusRoutesChange,
  mapPanelRef,
  panelRootRef,
  allowRefs,
}: StopSheetPanelProps) => {
  const safeAllowRefs = allowRefs ?? NO_EXTRA_REFS;
  const { mode: themeMode } = useThemeMode();
  const isDarkTheme = themeMode === "dark";
  const headerBadgeBg = isDarkTheme ? "rgba(8,10,18,0.65)" : "rgba(255,255,255,0.85)";
  const headerBadgeBorder = isDarkTheme ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.08)";
  const headerLabelColor = isDarkTheme ? "rgba(229,231,235,0.85)" : "rgba(15,23,42,0.65)";
  const headerTitleColor = isDarkTheme ? "rgba(255,255,255,0.98)" : "rgba(5,5,7,0.95)";
  const closeButtonBg = isDarkTheme ? "rgba(6,7,12,0.7)" : "rgba(255,255,255,0.95)";
  const closeButtonColor = isDarkTheme ? "#f8fafc" : "#0f172a";
  const headerChipBg = isDarkTheme ? "rgba(5,6,11,0.55)" : "rgba(255,255,255,0.75)";
  const headerChipText = isDarkTheme ? "rgba(247,248,250,0.85)" : "rgba(15,23,42,0.75)";
  const stopOptions = useMemo(() => {
    const base = platformStopIds && platformStopIds.length > 0 ? platformStopIds : [stopId];
    const deduped = Array.from(new Set(base.filter(Boolean)));
    if (!deduped.includes(stopId)) {
      deduped.unshift(stopId);
    }
    return deduped;
  }, [platformStopIds, stopId]);

  const boardQuery = useQuery({
    queryKey: ["stationBoard", stopOptions.join("|")],
    queryFn: async () => {
      let lastError: unknown = null;
      for (const optionId of stopOptions) {
        try {
          const board = await fetchStationBoard(optionId);
          if (board) {
            return board;
          }
        } catch (error) {
          console.warn("[StopSheet] failed to load board for", optionId, error);
          lastError = error;
        }
      }
      throw lastError ?? new Error("Station board unavailable");
    },
    enabled: isOpen && stopOptions.length > 0,
    staleTime: 20_000,
  });


  const board = boardQuery.data;
  useEffect(() => {
    console.log("[StopSheet] board query state", {
      stopId,
      stopOptions,
      status: boardQuery.status,
      isFetching: boardQuery.isFetching,
      isError: boardQuery.isError,
      error: boardQuery.error ? String(boardQuery.error) : null,
    });
  }, [boardQuery.status, boardQuery.isFetching, boardQuery.isError, boardQuery.error, stopId, stopOptions]);
  useEffect(() => {
    if (!boardQuery.isError || !boardQuery.error) return;
    console.error("[StopSheet] board query failed", {
      stopId,
      stopOptions,
      error: boardQuery.error,
    });
  }, [boardQuery.isError, boardQuery.error, stopId, stopOptions]);
  useEffect(() => {
    if (!boardQuery.isSuccess || board) return;
    console.warn("[StopSheet] board query returned no data", { stopId, stopOptions });
  }, [boardQuery.isSuccess, board, stopId, stopOptions]);
  useEffect(() => {
    if (!board) return;
    console.log("[StopSheet] board payload", {
      stopId,
      stopName: board.primary.stopName,
      routes: board.primary.routes.map((route) => ({
        routeId: route.routeId,
        direction: route.direction,
        primaryEta: route.primaryEta?.etaMinutes,
        shortName: route.shortName,
      })),
      departureSamples: board.details?.departures?.slice(0, 6),
    });
  }, [board, stopId]);
  const routes = useMemo(() => board?.primary.routes ?? [], [board]);
  const routeGroups = useMemo<RouteGroup[]>(() => {
    const map = new Map<string, RouteGroup>();
    routes.forEach((route) => {
      const existing = map.get(route.routeId);
      if (existing) {
        existing.directions.push(route);
      } else {
        map.set(route.routeId, { routeId: route.routeId, shortName: route.shortName, directions: [route] });
      }
    });
    return Array.from(map.values());
  }, [routes]);
  const routeColorIds = useMemo(() => routeGroups.map((group) => group.routeId), [routeGroups]);
  const routeDestinationMap = useMemo(() => {
    const map = new Map<string, string>();
    board?.details?.departures?.forEach((departure, index) => {
      const key = `${departure.routeId}-${departure.direction}`;
      const normalized = normalizeDestinationLabel(departure.destination);
      console.log("[StopSheet] destination candidate", {
        index,
        key,
        raw: departure.destination,
        normalized,
        source: departure.source,
        eta: departure.etaMinutes,
      });
      if (map.has(key)) return;
      if (normalized) {
        map.set(key, normalized);
      }
    });
    console.log("[StopSheet] destination map entries", Array.from(map.entries()));
    return map;
  }, [board?.details?.departures]);

  const busRouteIds = useMemo(() => {
    const ids = routes
      .filter((route) => route.mode === "bus")
      .map((route) => route.routeId)
      .filter((id, index, self) => self.indexOf(id) === index);
    console.log('[StopSheet] Bus route IDs:', ids);
    return ids;
  }, [routes]);

  const busRoutesShapesQuery = useQuery({
    queryKey: ["busRouteShapes", busRouteIds.sort().join(",")],
    queryFn: async () => {
      if (busRouteIds.length === 0) return [];
      console.log('[StopSheet] Fetching shapes for bus routes:', busRouteIds);
      const results = await Promise.all(
        busRouteIds.map((routeId) =>
          fetchRouteShapes(routeId).catch((error) => {
            console.error("[StopSheet] failed to load shapes for bus route", routeId, error);
            return null;
          })
        )
      );
      const filtered = results.filter((shape): shape is LineShapeResponse => Boolean(shape));
      console.log('[StopSheet] Loaded bus route shapes:', filtered.length, 'routes');
      return filtered;
    },
    enabled: isOpen && busRouteIds.length > 0,
    staleTime: 1000 * 60 * 5,
  });

  const routeDirectionOptions = useMemo(() => {
    const priorityOrder: Record<string, number> = {
      Red: 3,
      "Green-B": 2,
      "Green-C": 2,
      "Green-D": 2,
      "Green-E": 2,
      Mattapan: 1,
      Bus: 0,
    };
    return routeGroups
      .flatMap((group) =>
        group.directions.map((direction) => {
          const directionLabel = humanizeDirection(direction.direction);
          const routeLabel = direction.shortName ?? group.shortName ?? group.routeId;
          const token = getLineToken(group.routeId, themeMode);
        const key = `${direction.routeId}-${direction.direction}`;
    return {
      group,
      direction,
      directionId: toDirectionId(direction.direction),
      directionLabel,
      directionKey: getRouteKey(direction),
      routeLabel,
      lineToken: token,
      priority: priorityOrder[token.id] ?? 0,
      destinationLabel:
        routeDestinationMap.get(key) ?? direction.shortName ?? group.shortName ?? group.routeId,
    };
      }),
    )
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        const labelDiff = a.routeLabel.localeCompare(b.routeLabel);
        if (labelDiff !== 0) return labelDiff;
        return a.directionLabel.localeCompare(b.directionLabel);
      });
  }, [routeGroups, themeMode, routeDestinationMap]);
  useEffect(() => {
    console.log("[StopSheet] route option summaries", {
      stopId,
      options: routeDirectionOptions.map((option) => ({
        key: option.directionKey,
        routeId: option.group.routeId,
        direction: option.direction.direction,
        destinationLabel: option.destinationLabel,
        sourceDestination: routeDestinationMap.get(option.directionKey),
      })),
    });
  }, [stopId, routeDirectionOptions, routeDestinationMap]);

  const normalizedPreferredDirection = useMemo(
    () => (preferredDirection ? humanizeDirection(preferredDirection) : null),
    [preferredDirection],
  );

  const defaultSelection = (() => {
    if (normalizedPreferredDirection) {
      const match = routes.find(
        (route) => humanizeDirection(route.direction) === normalizedPreferredDirection,
      );
      if (match) {
        return { routeId: match.routeId, directionKey: getRouteKey(match) };
      }
    }
    let best: { routeId: string; directionKey: string; eta: number } | undefined;
    routes.forEach((route) => {
      const eta = route.primaryEta?.etaMinutes ?? route.extraEtas[0]?.etaMinutes ?? null;
      if (eta == null) return;
      if (!best || eta < best.eta) {
        best = { routeId: route.routeId, directionKey: getRouteKey(route), eta };
      }
    });
    if (best) return { routeId: best.routeId, directionKey: best.directionKey };
    if (routes[0]) {
      return { routeId: routes[0].routeId, directionKey: getRouteKey(routes[0]) };
    }
    return null;
  })();

  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [selectedDirectionKey, setSelectedDirectionKey] = useState<string | null>(null);
  const [routeExpansion, setRouteExpansion] = useState<Record<string, boolean>>({});
  const collapseEnabled = routeGroups.length > 1 && routeDirectionOptions.length > 4;
  const singleRouteOnly = routeGroups.length <= 1;
  const preferSingleColumnRoutes = singleRouteOnly || routeDirectionOptions.length <= 4;
  const routeListGridClass = `grid gap-2 ${preferSingleColumnRoutes ? "sm:grid-cols-1" : "sm:grid-cols-2"}`;
  const areRoutesExpanded = collapseEnabled ? routeExpansion[stopId] ?? false : true;

  const activeRouteId = useMemo(() => {
    if (selectedRouteId && routeGroups.some((group) => group.routeId === selectedRouteId)) {
      return selectedRouteId;
    }
    return defaultSelection?.routeId ?? routeGroups[0]?.routeId ?? null;
  }, [selectedRouteId, routeGroups, defaultSelection]);

  const activeRouteGroup = useMemo(
    () => routeGroups.find((group) => group.routeId === activeRouteId) ?? routeGroups[0] ?? null,
    [routeGroups, activeRouteId],
  );

  const activeDirectionKey = useMemo(() => {
    if (!activeRouteGroup) return null;
    const directions = activeRouteGroup.directions;
    if (!directions.length) return null;
    if (
      selectedDirectionKey &&
      directions.some((direction) => getRouteKey(direction) === selectedDirectionKey)
    ) {
      return selectedDirectionKey;
    }
    if (defaultSelection?.routeId === activeRouteGroup.routeId) {
      const match = directions.find((direction) => getRouteKey(direction) === defaultSelection.directionKey);
      if (match) return defaultSelection.directionKey;
    }
    return getRouteKey(directions[0]);
  }, [activeRouteGroup, selectedDirectionKey, defaultSelection]);

  const handleRouteOptionSelect = useCallback(
    (option: (typeof routeDirectionOptions)[number]) => {
      setSelectedRouteId(option.group.routeId);
      setSelectedDirectionKey(option.directionKey);
      if (collapseEnabled) {
        setRouteExpansion((prev) => ({ ...prev, [stopId]: false }));
      }
    },
    [setSelectedRouteId, setSelectedDirectionKey, stopId, collapseEnabled],
  );

  const activeDirectionOption = useMemo(
    () => routeDirectionOptions.find((option) => option.directionKey === activeDirectionKey) ?? null,
    [routeDirectionOptions, activeDirectionKey],
  );

  const routeOptionButton = useCallback(
    (option: (typeof routeDirectionOptions)[number]) => {
      const isActive = option.directionKey === activeDirectionKey;
      const textColor = isActive ? option.lineToken.textOnTint : "var(--foreground)";
      const directionToken = getDirectionToken(option.directionId, option.directionLabel, themeMode);
      const dotLabel = getRouteDotLabel(option.routeLabel, option.group.routeId);
      return (
        <button
          key={`${option.group.routeId}-${option.directionKey}`}
          type="button"
          className="touch-target inline-flex items-center gap-3 rounded-2xl border px-3 py-2 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          style={{
            borderColor: isActive ? option.lineToken.border : "var(--border)",
            background: isActive ? option.lineToken.tint : "var(--surface)",
            color: textColor,
            opacity: isActive ? 1 : 0.85,
            boxShadow: isActive ? `0 0 0 3px ${option.lineToken.border}` : "none",
            width: "100%",
          }}
          onClick={() => handleRouteOptionSelect(option)}
          aria-pressed={isActive}
        >
          <span
            className="flex h-6 w-6 items-center justify-center rounded-full text-[0.65rem] font-bold uppercase tracking-tight"
            style={{
              background: option.lineToken.color,
              border: `2px solid ${option.lineToken.border}`,
              color: option.lineToken.textOnTint,
            }}
          >
            {dotLabel}
          </span>
          <DirectionArrowIcon token={directionToken} size="sm" />
          <div className="flex flex-col leading-none">
            <span>{option.destinationLabel}</span>
          </div>
        </button>
      );
    },
    [activeDirectionKey, handleRouteOptionSelect, themeMode],
  );

  const activeRoute = useMemo(() => {
    if (!activeRouteGroup) return null;
    return activeRouteGroup.directions.find((route) => getRouteKey(route) === activeDirectionKey) ?? activeRouteGroup.directions[0] ?? null;
  }, [activeRouteGroup, activeDirectionKey]);

  const { heroDeparture, upcomingDepartures } = useMemo(() => {
    if (!activeRoute) {
      return { heroDeparture: null as StationDeparture | null, upcomingDepartures: [] as StationDeparture[] };
    }
    const detailed =
      board?.details?.departures?.filter((departure) => {
        if (departure.routeId !== activeRoute.routeId) return false;
        if (!activeRoute.direction || !departure.direction) return true;
        return directionsMatch(departure.direction, activeRoute.direction);
      }) ?? [];
    const etaCandidates = [activeRoute.primaryEta, ...activeRoute.extraEtas].filter(
      Boolean,
    ) as StationEta[];
    const mapped = etaCandidates.map((eta) => mapEtaToDeparture(eta, activeRoute));

    const heroDepartureFromDetails = detailed.length > 0 ? detailed[0] : null;
    const heroDepartureFromEta = mapped[0] ?? null;
    const hero = heroDepartureFromDetails ?? heroDepartureFromEta;

    const getDepartureKey = (departure: StationDeparture) =>
      `${departure.routeId}-${departure.direction ?? ""}-${departure.destination ?? ""}-${departure.etaMinutes ?? -1}`;

    const uniqueDepartures: StationDeparture[] = [];
    const seenKeys = new Set<string>();
    const combinedDepartures = [...detailed, ...mapped];
    let heroKey: string | null = hero ? getDepartureKey(hero) : null;

    const addDeparture = (departure: StationDeparture) => {
      const key = getDepartureKey(departure);
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      uniqueDepartures.push(departure);
    };

    for (const departure of combinedDepartures) {
      if (heroKey && getDepartureKey(departure) === heroKey) {
        heroKey = null;
        continue;
      }
      if (uniqueDepartures.length >= 12) break;
      addDeparture(departure);
    }

    return {
      heroDeparture: hero,
      upcomingDepartures: uniqueDepartures.slice(0, 12),
    };
  }, [board?.details?.departures, activeRoute]);
  useEffect(() => {
    console.log("[StopSheet] hero/upcoming computation", {
      stopId,
      activeRouteId: activeRoute?.routeId,
      direction: activeRoute?.direction,
      heroDestinationRaw: heroDeparture?.destination,
      heroEta: heroDeparture?.etaMinutes ?? activeRoute?.primaryEta?.etaMinutes ?? null,
      detailedCount:
        board?.details?.departures?.filter(
          (departure) =>
            activeRoute && departure.routeId === activeRoute.routeId && departure.direction === activeRoute.direction,
        ).length ?? 0,
      upcomingCount: upcomingDepartures.length,
    });
  }, [stopId, activeRoute, heroDeparture, board?.details?.departures, upcomingDepartures]);
  const heroTone = heroDeparture?.status ? statusTone(heroDeparture.status) : null;
  const heroSource = heroDeparture?.source ?? activeRoute?.primaryEta?.source;
  const heroTripId =
    (heroDeparture as StationDepartureWithTrip | null)?.tripId ?? activeRoute?.primaryEta?.tripId ?? null;
  const heroEta = heroDeparture?.etaMinutes ?? activeRoute?.primaryEta?.etaMinutes ?? null;
  const heroClock =
    heroDeparture?.predictedTime ??
    heroDeparture?.scheduledTime ??
    activeRoute?.primaryEta?.predictedTime ??
    activeRoute?.primaryEta?.scheduledTime;
  const activeRouteDestinationKey = activeRoute ? `${activeRoute.routeId}-${activeRoute.direction}` : null;
  const activeRouteDestinationLabel = useMemo(() => {
    if (!activeRoute) return null;
    const routeKey = `${activeRoute.routeId}-${activeRoute.direction}`;
    const mapped = routeDestinationMap.get(routeKey);
    return (
      normalizeDestinationLabel(mapped) ??
      normalizeDestinationLabel(activeRoute.shortName) ??
      normalizeDestinationLabel(activeRoute.routeId)
    );
  }, [activeRoute, routeDestinationMap]);
  const heroDestinationLabel =
    normalizeDestinationLabel(heroDeparture?.destination) ?? activeRouteDestinationLabel ?? "Next departure";
  useEffect(() => {
    console.log("[StopSheet] active route destination resolution", {
      stopId,
      activeRouteId: activeRoute?.routeId,
      direction: activeRoute?.direction,
      destinationFromMap: activeRoute ? routeDestinationMap.get(`${activeRoute.routeId}-${activeRoute.direction}`) : null,
      heroDepartureDestination: heroDeparture?.destination,
      heroDestinationLabel,
    });
  }, [stopId, activeRoute, routeDestinationMap, heroDeparture, heroDestinationLabel]);
  const directionLabel = humanizeDirection(activeRoute?.direction);
  const routeLabel = activeRoute?.shortName ?? activeRoute?.routeId ?? null;
  const heroLineToken = activeRoute ? getLineToken(activeRoute.routeId, themeMode) : null;
  const heroDirectionToken = activeRoute ? getDirectionToken(toDirectionId(activeRoute.direction), directionLabel, themeMode) : null;
  const headerHue = useMemo(() => getStopHue(routeColorIds, themeMode), [routeColorIds, themeMode]);
  const heroHue = useMemo(
    () => getStopHue(activeRoute ? [activeRoute.routeId] : routeColorIds, themeMode),
    [activeRoute, routeColorIds, themeMode],
  );
  const isBoardLoading = boardQuery.isLoading;
  const isBoardRefreshing = !isBoardLoading && boardQuery.isFetching;
  const isBoardBusy = isBoardLoading || isBoardRefreshing;
  const showHeroPlaceholder = isBoardBusy && !heroDeparture;
  const showUpcomingPlaceholder = isBoardBusy && upcomingDepartures.length === 0;
  const shouldShowNoMoreDepartures = !isBoardBusy && !heroDeparture && upcomingDepartures.length === 0;
  const headerOverlayGradient = useMemo(() => {
    if (themeMode === "dark") {
      return "linear-gradient(120deg, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.55) 45%, rgba(0,0,0,0.25) 100%)";
    }
    return "linear-gradient(120deg, rgba(255,255,255,0.92) 0%, rgba(255,255,255,0.78) 45%, rgba(255,255,255,0.52) 100%)";
  }, [themeMode]);

  const handleClose = useCallback(() => {
    setSelectedRouteId(null);
    setSelectedDirectionKey(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        handleClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, handleClose]);

  useEffect(() => {
    if (onBusRoutesChange) {
      const shapes = busRoutesShapesQuery.data ?? [];
      console.log('[StopSheet] Notifying parent of bus route shapes:', shapes.length);
      onBusRoutesChange(shapes);
    }
  }, [busRoutesShapesQuery.data, onBusRoutesChange]);

  const stopName = board?.primary.stopName ?? stopId;
  const primaryStopId = board?.primary.stopId ?? stopId;
  const landmarkImage = useMemo(
    () => getLandmarkImage({ stopName, stopId: primaryStopId }),
    [stopName, primaryStopId],
  );

  const mobileSheetRef = useRef<HTMLElement | null>(null);
  const desktopSheetRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!panelRootRef) return;
    // Keep the provided panelRootRef.current pointing to whichever sheet ref is mounted.
    const update = () => {
      panelRootRef.current = mobileSheetRef.current ?? desktopSheetRef.current ?? null;
    };
    update();
    return () => {
      if (panelRootRef) panelRootRef.current = null;
    };
  }, [panelRootRef]);

  useEffect(() => {
    if (!isOpen) return;
    const handleOutsideClick = (event: PointerEvent) => {
      const target = event.target;
      const withinNode = (node?: Node | null) => {
        if (!node) return false;
        if (target instanceof Node && node.contains(target)) return true;
        const path = typeof event.composedPath === "function" ? event.composedPath() : [];
        if (path.includes(node)) return true;
        return false;
      };
      const insideSheet =
        withinNode(mobileSheetRef.current) || withinNode(desktopSheetRef.current);
      if (insideSheet) return;
      if (withinNode(mapPanelRef?.current ?? null)) return;
      if (safeAllowRefs.some((ref) => withinNode(ref.current))) return;
      onClose();
    };
    document.addEventListener("pointerdown", handleOutsideClick);
    return () => document.removeEventListener("pointerdown", handleOutsideClick);
  }, [safeAllowRefs, isOpen, mapPanelRef, onClose]);

  if (!isOpen) {
    return null;
  }
  const walkLabel = formatWalkLabel(board?.primary);
  const upcomingLabel = activeRouteDestinationLabel
    ? `Next departures to ${activeRouteDestinationLabel}`
    : activeRoute
    ? `Next ${activeRoute.shortName ?? activeRoute.routeId} departures`
    : "Next departures";

  const renderSheet = (variant: "mobile" | "desktop") => {
    const sheetRef = variant === "mobile" ? mobileSheetRef : desktopSheetRef;
    return (
      <section
        className={`stop-sheet-panel flex h-full w-full flex-col overflow-hidden bg-[color:var(--card)] text-[color:var(--foreground)] shadow-2xl ${
          variant === "desktop" ? "rounded-r-3xl" : "rounded-t-3xl"
        }`}
        role="dialog"
        aria-modal="true"
        aria-label={`Stop sheet for ${stopName}`}
        ref={sheetRef}
      >
      <header
        className={`sticky top-0 z-10 overflow-hidden border-b px-6 py-5 ${variant === "desktop" ? "rounded-tr-3xl" : "rounded-t-3xl"}`}
        style={{ borderColor: headerHue.borderColor, background: headerHue.background }}
      >
        {landmarkImage && (
          <div
            className={`pointer-events-none absolute inset-0 ${variant === "desktop" ? "rounded-r-3xl" : "rounded-t-3xl"}`}
            style={{ opacity: 0.6 }}
          >
            <div
              className={`absolute inset-0 bg-cover bg-center blur-[3px] ${variant === "desktop" ? "rounded-r-3xl" : "rounded-t-3xl"}`}
              style={{ backgroundImage: `url(${landmarkImage})`, filter: "saturate(1.05)" }}
            />
            <div
              className={`absolute inset-0 ${variant === "desktop" ? "rounded-r-3xl" : "rounded-t-3xl"}`}
              style={{ background: headerOverlayGradient }}
            />
          </div>
        )}
        <div className="relative z-10">
          {variant === "mobile" && <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-[color:var(--surface)]" />}
          <div className="flex items-start justify-between gap-3">
            <div
              className="flex items-center gap-3 rounded-2xl border px-3 py-2 shadow-sm"
              style={{ borderColor: headerBadgeBorder, background: headerBadgeBg }}
            >
              <div
                className="flex h-10 w-10 items-center justify-center rounded-full text-xl"
                style={{ background: isDarkTheme ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.05)", color: headerTitleColor }}
              >
                <FiMap />
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.35em]" style={{ color: headerLabelColor }}>
                  Stop
                </p>
                <h2 className="text-2xl font-semibold" style={{ color: headerTitleColor }}>
                  {stopName}
                </h2>
                {walkLabel && (
                  <p className="text-xs" style={{ color: headerLabelColor }}>
                    {walkLabel}
                  </p>
                )}
              </div>
            </div>
            <button
              type="button"
              className="touch-target flex h-10 w-10 items-center justify-center rounded-full text-lg font-semibold shadow transition hover:scale-110"
              onClick={handleClose}
              aria-label="Close stop sheet"
              style={{
                background: closeButtonBg,
                color: closeButtonColor,
                border: `1px solid ${headerBadgeBorder}`,
                marginTop: "-0.5rem",
                marginRight: "-0.5rem",
              }}
            >
              ×
            </button>
          </div>
              {routeGroups.length > 0 && (
                <div className="mt-4 space-y-3">
                  <div
                    className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.35em]"
                    style={{
                  borderColor: headerBadgeBorder,
                  background: headerBadgeBg,
                  color: headerLabelColor,
                }}
              >
                <FiMapPin />
                <span>Routes at this stop</span>
                {boardQuery.isFetching && (
                  <span className="normal-case tracking-normal" style={{ color: headerTitleColor }}>
                    Refreshing…
                  </span>
                )}
              </div>
              {routeDirectionOptions.length > 0 && (
                <>
                  {collapseEnabled ? (
                    areRoutesExpanded || !activeDirectionOption ? (
                      <div className={routeListGridClass}>
                        {routeDirectionOptions.map((option) => routeOptionButton(option))}
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        {routeOptionButton(activeDirectionOption)}
                        <button
                          type="button"
                          className="btn btn-ghost touch-target rounded-full p-2 text-lg"
                          onClick={() => setRouteExpansion((prev) => ({ ...prev, [stopId]: true }))}
                          aria-label="Show all routes at this stop"
                          style={{
                            border: "1px solid var(--border)",
                            color: "var(--foreground)",
                            background: "var(--surface)",
                          }}
                        >
                          <FiChevronDown />
                        </button>
                      </div>
                    )
                  ) : (
                    <div className={routeListGridClass}>
                      {routeDirectionOptions.map((option) => routeOptionButton(option))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </header>
      <div className="stop-sheet-scroll flex-1 overflow-y-auto pb-8 pt-5" style={{ background: "var(--surface-soft)" }}>
        {boardQuery.isLoading && <div className="px-6"><LoadingSkeleton /></div>}
        {boardQuery.isError && (
          <div className="px-6">
            <div className="panel border-[color:var(--line-red)]/40 text-sm" style={{ background: "color-mix(in srgb, var(--line-red) 8%, var(--card))" }}>
              <p className="font-semibold" style={{ color: "var(--line-red)" }}>
                We couldn't load departures for this stop.
              </p>
              <p className="mt-2 text-xs text-muted">
                Please try again. If the issue persists, check your connection.
              </p>
            </div>
          </div>
        )}
        {!boardQuery.isLoading && !board && !boardQuery.isError && (
          <div className="px-6">
            <div className="panel text-sm text-muted">No data available for this stop right now.</div>
          </div>
        )}
        {!boardQuery.isLoading && board && (
          <div className="space-y-8 px-6">
            <div>
              <p className="text-xs uppercase tracking-[0.35em] mb-3" style={{ color: "var(--muted)" }}>
                Next departure
              </p>
              {showHeroPlaceholder ? (
                <HeroPlaceholder />
              ) : heroDeparture ? (
                <div className="panel shadow-inner" style={{ background: heroHue.background, borderColor: heroHue.borderColor }}>
                  <button
                    type="button"
                    className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 text-left transition hover:bg-[var(--surface)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
                    onClick={() => heroTripId && onFollowTrip(heroTripId)}
                    disabled={!heroTripId}
                    aria-disabled={!heroTripId}
                    title={heroTripId ? "Follow this trip on the map" : "Trip tracking not available"}
                    style={{ color: "var(--foreground)", background: "transparent" }}
                  >
                    <div>
                      <p className="text-base font-semibold mb-1">{heroDestinationLabel}</p>
                      <div className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                        <FiClock className="text-xs" />
                        <span>{formatTimeLabel(heroClock)}</span>
                        {heroTone && (
                          <span className="inline-flex items-center gap-1" style={{ color: heroTone.text }}>
                            {heroTone.icon}
                            {heroTone.label}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {heroSource && (
                            heroSource === "schedule" || heroSource === "unknown" ? (
                              <FiClock className="text-sm" style={{ color: "var(--muted)" }} />
                            ) : (
                              <FiZap className="text-sm" style={{ color: "var(--line-blue)" }} />
                            )
                          )}
                          <p className="text-3xl font-bold" style={{ color: "var(--foreground)" }}>
                            {formatEta(heroEta)}
                          </p>
                        </div>
                      </div>
                      {heroTripId ? (
                        <div className="btn btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm transition group-hover:scale-105" style={{ position: "relative" }}>
                          <FiArrowRightCircle className="text-base" />
                          <span>Follow</span>
                          <span className="inline-flex ml-0.5" onClick={(e) => e.stopPropagation()}>
                            <InfoTooltip content="Track this vehicle in real-time on the map" />
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs" style={{ color: "var(--muted)" }}>Not trackable</span>
                      )}
                    </div>
                  </button>
                </div>
              ) : shouldShowNoMoreDepartures ? (
                <div className="panel" style={{ background: heroHue.background, borderColor: heroHue.borderColor }}>
                  <p className="text-lg font-semibold">No more departures.</p>
                  <p className="text-sm" style={{ color: "var(--muted)" }}>
                    There are currently no more {routeLabel ?? ""} departures from this stop.
                  </p>
                </div>
              ) : null}
            </div>
            <div>
              <p className="heading-label text-slate-400">{upcomingLabel}</p>
              <div className="mt-3 stop-sheet-list">
                {showUpcomingPlaceholder ? (
                  <DepartureListSkeleton />
                ) : (
                  <DepartureList
                    departures={upcomingDepartures}
                    onFollowTrip={onFollowTrip}
                    defaultDestinationLabel={activeRouteDestinationLabel ?? heroDestinationLabel}
                  />
                )}
              </div>
            </div>
            {board.details && (
              <div className="space-y-6">
                <div>
                  <p className="heading-label text-slate-400">Alerts</p>
                  <div className="mt-3">
                    <AlertList alerts={board.details.alerts} />
                  </div>
                </div>
                <div>
                  <p className="heading-label text-slate-400">Facilities</p>
                  <div className="mt-3">
                    <FacilitiesList facilities={board.details.facilities} />
                  </div>
                </div>
              </div>
            )}
            <div className="panel text-sm">
              <p className="font-semibold">Need more?</p>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                View the full schedule or report an issue from the MBTA site.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

  return (
    <>
      <div className="fixed inset-0 z-50 flex flex-col md:hidden pointer-events-none" aria-modal="true" role="presentation">
        <div className="mt-auto h-[88vh] w-full pointer-events-auto" onClick={(evt) => evt.stopPropagation()}>
          {renderSheet("mobile")}
        </div>
      </div>
      <div className="fixed inset-0 z-50 hidden md:block pointer-events-none" aria-modal="true" role="presentation">
        <div className="flex h-full w-full justify-start">
          <div className="pointer-events-auto flex h-full" onClick={(evt) => evt.stopPropagation()}>
            {renderSheet("desktop")}
          </div>
        </div>
      </div>
    </>
  );
};
