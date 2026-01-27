"use client";

// Stop sheet panel showing departures, alerts, and facilities for a station.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchStationBoard } from "@/lib/api";
import type {
  GetStationBoardResponse,
  StationBoardRoutePrimary,
  StationDeparture,
  StationAlert,
  StationFacility,
  StationEta,
} from "@linelight/core";
import { formatEta } from "@/lib/time";
import { EtaSourceIndicator } from "./EtaSourceIndicator";
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
  FiClock,
  FiMap,
  FiArrowUpCircle,
  FiShuffle,
  FiTruck,
  FiGrid,
  FiCreditCard,
  FiLock,
  FiNavigation,
} from "react-icons/fi";
import { humanizeDirection } from "@/lib/directions";
import { getLineToken, getDirectionToken } from "@/lib/designTokens";
import { useThemeMode } from "@/hooks/useThemeMode";
import { getLandmarkImage, getStopHue } from "@/lib/stopStyling";

interface StopSheetPanelProps {
  stopId: string;
  stopName?: string;
  isOpen: boolean;
  platformStopIds?: string[];
  preferredDirection?: string | null;
  onClose: () => void;
  onFollowTrip: (tripId: string | null) => void;
  followError?: string;
  followLoading?: boolean;
  onRouteSelect?: (routeId: string | null) => void;
  mapPanelRef?: RefObject<HTMLElement | null>;
  panelRootRef?: RefObject<HTMLElement | null>;
  allowRefs?: Array<RefObject<HTMLElement | null>>;
  mobileSheetHeight?: string;
  overlayHeight?: string;
}

const NO_EXTRA_REFS: ReadonlyArray<RefObject<HTMLElement | null>> = [];
const MOBILE_SHEET_DEFAULT_HEIGHT = "88vh";

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

const isGenericDirectionLabel = (value?: string | null) => {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return normalized === "inbound" || normalized === "outbound" || normalized === "unknown";
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

type StationDepartureWithTrip = StationDeparture & { tripId?: string | null; vehicleId?: string | null };

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

const getDepartureTimestamp = (departure: StationDeparture): number | null => {
  const time = departure.predictedTime ?? departure.scheduledTime ?? null;
  if (!time) return null;
  const ts = Date.parse(time);
  return Number.isNaN(ts) ? null : ts;
};

const compareDepartures = (a: StationDeparture, b: StationDeparture): number => {
  const aTs = getDepartureTimestamp(a);
  const bTs = getDepartureTimestamp(b);
  if (aTs != null && bTs != null && aTs !== bTs) return aTs - bTs;
  if (aTs == null && bTs != null) return 1;
  if (aTs != null && bTs == null) return -1;

  const aEta = a.etaMinutes ?? Number.POSITIVE_INFINITY;
  const bEta = b.etaMinutes ?? Number.POSITIVE_INFINITY;
  if (aEta !== bEta) return aEta - bEta;

  const aSourceRank = a.predictedTime ? 0 : 1;
  const bSourceRank = b.predictedTime ? 0 : 1;
  if (aSourceRank !== bSourceRank) return aSourceRank - bSourceRank;

  const aLabel = a.destination ?? "";
  const bLabel = b.destination ?? "";
  return aLabel.localeCompare(bLabel);
};

const getDepartureMinuteKey = (departure: StationDeparture): number | null => {
  const ts = getDepartureTimestamp(departure);
  if (ts == null) return null;
  return Math.floor(ts / 60000);
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
  tripId: eta.tripId,
});

const getRouteDotLabel = (routeLabel: string, routeId: string): string => {
  if (routeId.startsWith("Green-")) {
    return routeId.split("-")[1] ?? "G";
  }
  if (/^\d+$/.test(routeLabel)) {
    return routeLabel;
  }
  return routeLabel.charAt(0).toUpperCase();
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

const ALERT_EFFECT_LABELS: Record<string, string> = {
  DELAY: "Delay",
  SERVICE_CHANGE: "Service change",
  SHUTTLE: "Shuttle",
  DETOUR: "Detour",
  STOP_CLOSED: "Stop closed",
  STATION_CLOSED: "Station closed",
  SUSPENSION: "Suspension",
  CANCELLATION: "Cancellation",
  MODIFIED_SERVICE: "Modified service",
  ADDITIONAL_SERVICE: "Additional service",
  TRACK_CHANGE: "Track change",
  DOCK_CLOSED: "Dock closed",
  DOCK_ISSUE: "Dock issue",
  ACCIDENT: "Accident",
  WEATHER: "Weather",
  MAINTENANCE: "Maintenance",
  UNKNOWN: "Service alert",
};

const formatAlertEffect = (effect?: string | null) => {
  if (!effect) return null;
  const trimmed = effect.trim();
  if (!trimmed) return null;
  const normalized = ALERT_EFFECT_LABELS[trimmed];
  if (normalized) return normalized;
  return trimmed
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

const normalizeAlertText = (value?: string | null) => value?.trim() ?? "";

const AlertList = ({ alerts, isLoading }: { alerts: StationAlert[]; isLoading: boolean }) => {
  const dedupedAlerts = useMemo(() => {
    const map = new Map<string, {
      key: string;
      title: string;
      description?: string;
      effectLabel: string | null;
      severity: StationAlert["severity"];
      count: number;
    }>();
    alerts.forEach((alert) => {
      const effectLabel = formatAlertEffect(alert.effect);
      const title = normalizeAlertText(alert.header) || effectLabel || "Service alert";
      const description = normalizeAlertText(alert.description) || undefined;
      const key = `${title}|${description ?? ""}|${alert.severity}|${effectLabel ?? ""}`;
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
        return;
      }
      map.set(key, {
        key,
        title,
        description,
        effectLabel,
        severity: alert.severity,
        count: 1,
      });
    });
    return Array.from(map.values());
  }, [alerts]);

  if (isLoading) {
    return (
      <div className="chip flex items-center gap-2 text-sm">
        <FiInfo /> Loading alerts…
      </div>
    );
  }
  if (dedupedAlerts.length === 0) {
    return (
      <div className="chip chip-success flex items-center gap-2 text-sm">
        <FiCheckCircle /> No active alerts for this stop.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {dedupedAlerts.map((alert) => (
        <div key={alert.key} className="panel border-[color:var(--line-orange)]/40 bg-white text-[color:var(--foreground)] shadow-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-[0.3em]" style={{ color: "var(--line-orange)" }}>
            <span className="flex items-center gap-2">
              <FiAlertTriangle /> {alert.severity}
            </span>
            {alert.effectLabel && alert.effectLabel !== alert.title && (
              <span className="chip text-[10px]" style={{ borderColor: "var(--border)", color: "var(--muted-strong)" }}>
                {alert.effectLabel}
              </span>
            )}
            {alert.count > 1 && (
              <span className="chip text-[10px]" style={{ borderColor: "var(--border)", color: "var(--muted-strong)" }}>
                {alert.count} alerts
              </span>
            )}
          </div>
          <p className="mt-1 font-semibold">{alert.title}</p>
          {alert.description && <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>{alert.description}</p>}
        </div>
      ))}
    </div>
  );
};

type FacilityCategory = "elevator" | "escalator" | "boarding" | "ticketing" | "parking" | "bike" | "other";

const normalizeFacilityLabel = (label: string) => {
  return label
    .replace(/\b(Elevator|Escalator|fare vending machine|portable boarding lift)\s+\d+\b/gi, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
};

const FACILITY_SUBTYPE_LABELS: Record<string, string> = {
  fare_vending_machine: "Fare vending machine",
  ticket_window: "Ticket window",
  fare_media_assistant: "Customer service",
  portable_boarding_lift: "Boarding lift",
  high_level_platform: "High-level platform",
  mini_high_platform: "Mini-high platform",
  bike_storage: "Bike storage",
  bike_rack: "Bike rack",
  ramp: "Ramp access",
  parking: "Parking",
};

const resolveFacilityLabel = (facility: StationFacility) => {
  const description = normalizeFacilityLabel(facility.description ?? "");
  const subtype = (facility.subtype ?? "").toLowerCase();
  const subtypeLabel = FACILITY_SUBTYPE_LABELS[subtype];
  if (!description) return subtypeLabel ?? "Facility";
  if (!subtypeLabel) return description;
  const lower = description.toLowerCase();
  const hasKeyword =
    lower.includes("elevator") ||
    lower.includes("escalator") ||
    lower.includes("fare") ||
    lower.includes("ticket") ||
    lower.includes("boarding") ||
    lower.includes("platform") ||
    lower.includes("lift") ||
    lower.includes("bike") ||
    lower.includes("parking") ||
    lower.includes("ramp");
  if (!hasKeyword && description.length <= 36) {
    return `${description} - ${subtypeLabel}`;
  }
  return description;
};

const categorizeFacility = (facility: StationFacility): FacilityCategory => {
  const subtype = (facility.subtype ?? "").toLowerCase();
  if (facility.type === "elevator" || subtype === "elevator") return "elevator";
  if (facility.type === "escalator" || subtype === "escalator") return "escalator";
  if (facility.type === "parking" || subtype === "parking" || subtype === "parking_area" || subtype === "garage") {
    return "parking";
  }
  if (
    subtype === "fare_vending_machine" ||
    subtype === "ticket_window" ||
    subtype === "fare_media_assistant"
  ) {
    return "ticketing";
  }
  if (
    subtype === "portable_boarding_lift" ||
    subtype === "high_level_platform" ||
    subtype === "mini_high_platform" ||
    subtype === "elevated_subplatform" ||
    subtype === "fully_elevated_platform" ||
    subtype === "ramp"
  ) {
    return "boarding";
  }
  if (subtype === "bike_storage" || subtype === "bike_rack") {
    return "bike";
  }
  return "other";
};

const FACILITY_GROUPS = [
  { type: "elevator" as const, label: "Elevators", icon: FiArrowUpCircle, accent: "var(--line-blue)" },
  { type: "escalator" as const, label: "Escalators", icon: FiShuffle, accent: "var(--line-green)" },
  { type: "boarding" as const, label: "Boarding access", icon: FiNavigation, accent: "var(--line-purple)" },
  { type: "ticketing" as const, label: "Ticketing", icon: FiCreditCard, accent: "var(--line-orange)" },
  { type: "parking" as const, label: "Parking", icon: FiTruck, accent: "var(--line-silver)" },
  { type: "bike" as const, label: "Bike storage", icon: FiLock, accent: "var(--line-silver)" },
  { type: "other" as const, label: "Other facilities", icon: FiGrid, accent: "var(--muted)" },
];

const FacilitiesList = ({ facilities, isLoading }: { facilities: StationFacility[]; isLoading: boolean }) => {
  const grouped = useMemo(() => {
    const buckets = new Map<FacilityCategory, Map<string, {
      key: string;
      label: string;
      count: number;
      statuses: Set<StationFacility["status"]>;
      capacityLabel: string | null;
    }>>();
    facilities.forEach((facility) => {
      const category = categorizeFacility(facility);
      const label = resolveFacilityLabel(facility);
      const capacityLabel =
        facility.capacity != null
          ? `${facility.available ?? "?"}/${facility.capacity}`
          : facility.available != null
            ? `${facility.available} available`
            : null;
      const bucket = buckets.get(category) ?? new Map();
      const existing = bucket.get(label);
      if (existing) {
        existing.count += 1;
        existing.statuses.add(facility.status ?? "unknown");
        existing.capacityLabel = null;
      } else {
        bucket.set(label, {
          key: label,
          label,
          count: 1,
          statuses: new Set([facility.status ?? "unknown"]),
          capacityLabel,
        });
      }
      buckets.set(category, bucket);
    });
    return FACILITY_GROUPS.map((group) => ({
      ...group,
      facilities: Array.from(buckets.get(group.type)?.values() ?? [])
        .map((entry) => {
          const statuses = Array.from(entry.statuses.values());
          const status = statuses.length === 1 ? statuses[0] : null;
          return {
            key: entry.key,
            label: entry.label,
            count: entry.count,
            status,
            capacityLabel: entry.count === 1 ? entry.capacityLabel : null,
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label)),
    }));
  }, [facilities]);

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const defaults: Record<string, boolean> = {};
    const hasElevator = grouped.find((group) => group.type === "elevator" && group.facilities.length > 0);
    const hasEscalator = grouped.find((group) => group.type === "escalator" && group.facilities.length > 0);
    if (hasElevator) defaults.elevator = true;
    if (hasEscalator) defaults.escalator = true;
    if (!hasElevator && !hasEscalator) {
      const first = grouped.find((group) => group.facilities.length > 0);
      if (first) defaults[first.type] = true;
    }
    const raf = requestAnimationFrame(() => setOpenGroups(defaults));
    return () => cancelAnimationFrame(raf);
  }, [grouped]);

  if (isLoading) {
    return (
      <div className="chip flex items-center gap-2 text-sm">
        <FiInfo /> Loading facilities…
      </div>
    );
  }
  if (facilities.length === 0) {
    return (
      <div className="chip flex items-center gap-2 text-sm">
        <FiInfo /> No facilities data available.
      </div>
    );
  }

  const getStatusTone = (status: StationFacility["status"]) => {
    switch (status) {
      case "available":
        return { label: "Available", color: "var(--line-green)" };
      case "limited":
        return { label: "Limited", color: "var(--line-orange)" };
      case "unavailable":
        return { label: "Unavailable", color: "var(--line-red)" };
      case "unknown":
      default:
        return { label: "Unknown", color: "var(--muted)" };
    }
  };

  return (
    <div className="space-y-3">
      {grouped
        .filter((group) => group.facilities.length > 0)
        .map((group) => {
          const isOpen = Boolean(openGroups[group.type]);
          const Icon = group.icon as ComponentType<{ className?: string }>;
          const sectionId = `facility-${group.type}`;
          return (
            <div key={group.type} className="rounded-2xl border" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                onClick={() => setOpenGroups((prev) => ({ ...prev, [group.type]: !prev[group.type] }))}
                aria-expanded={isOpen}
                aria-controls={sectionId}
                data-interactive="ghost"
              >
                <div className="flex items-center gap-3">
                  <span
                    className="flex h-9 w-9 items-center justify-center rounded-full border"
                    style={{ borderColor: group.accent, color: group.accent }}
                  >
                    <Icon className="text-lg" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold">{group.label}</p>
                    <p className="text-xs" style={{ color: "var(--muted)" }}>
                      {group.facilities.length} {group.facilities.length === 1 ? "item" : "items"}
                    </p>
                  </div>
                </div>
                <FiChevronDown
                  className="text-lg transition"
                  style={{ transform: isOpen ? "rotate(180deg)" : "rotate(0deg)", color: "var(--muted)" }}
                />
              </button>
              {isOpen && (
                <div id={sectionId} className="space-y-2 border-t px-4 py-3" style={{ borderColor: "var(--border)" }}>
                  {group.facilities.map((facility) => {
                    const status = facility.status ?? null;
                    const tone = status ? getStatusTone(status) : null;
                    const metaLabel =
                      facility.capacityLabel ??
                      (facility.count > 1 ? `${facility.count} items` : null);
                    return (
                      <div key={facility.key} className="rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "var(--border)" }}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-2">
                            <FiMapPin className="mt-0.5 text-sm" style={{ color: group.accent }} />
                            <div>
                              <p className="font-semibold">
                                {facility.label ?? group.label.slice(0, -1)}
                              </p>
                              {metaLabel && (
                                <p className="text-xs" style={{ color: "var(--muted)" }}>
                                  {metaLabel}
                                </p>
                              )}
                            </div>
                          </div>
                          {status && status !== "unknown" && tone && (
                            <span className="chip text-xs" style={{ color: tone.color, borderColor: tone.color }}>
                              {tone.label}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
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
        const vehicleId = (departure as StationDepartureWithTrip).vehicleId ?? null;
        const canFollow = Boolean(tripId && vehicleId);
        const lineToken = getLineToken(departure.routeId, themeMode);
        const isStriped = idx % 2 === 1;
        return (
          <button
            key={`${departure.routeId}-${departure.direction}-${departure.destination}-${idx}`}
            type="button"
            className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b px-4 py-2.5 text-left transition last:border-b-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
            onClick={() => canFollow && onFollowTrip(tripId)}
            disabled={!canFollow}
            aria-disabled={!canFollow}
            title={
              !tripId
                ? "Trip tracking not available"
                : !vehicleId
                  ? "Live vehicle tracking unavailable for this trip"
                  : "Follow this trip"
            }
            data-interactive="ghost"
            style={{ 
              color: "var(--foreground)", 
              background: isStriped ? `color-mix(in srgb, ${lineToken.color} 6%, var(--surface))` : "var(--surface)", 
              borderColor: "var(--border)" 
            }}
          >
            <div>
              <p className="text-base font-semibold">
                {(() => {
                  const normalized = normalizeDestinationLabel(departure.destination);
                  if (normalized && !isGenericDirectionLabel(normalized)) return normalized;
                  if (defaultDestinationLabel) return defaultDestinationLabel;
                  return normalized ?? departure.shortName ?? departure.routeId ?? humanizeDirection(departure.direction);
                })()}
              </p>
              <div className="mt-1 flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                <span>{formatTimeLabel(departure.predictedTime ?? departure.scheduledTime)}</span>
                {tone && (
                  <span className="inline-flex items-center gap-1" style={{ color: tone.text }}>
                    {tone.icon}
                    {tone.label}
                  </span>
                )}
                {!canFollow && tripId && (
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.2em]" style={{ color: "var(--muted)" }}>
                    Live tracking unavailable
                    <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
                      <InfoTooltip content="MBTA real-time data doesn't include a vehicle for this trip yet." />
                    </span>
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

const STATION_BOARD_CACHE_KEY = "linelight:stationBoardStopIdByStation";

const readStationBoardCache = (): Record<string, string> => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STATION_BOARD_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, string>;
    }
  } catch {
    // ignore storage errors
  }
  return {};
};

const writeStationBoardCache = (stationId: string, boardStopId: string) => {
  if (typeof window === "undefined") return;
  try {
    const cache = readStationBoardCache();
    cache[stationId] = boardStopId;
    window.localStorage.setItem(STATION_BOARD_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // ignore storage errors
  }
};

export const StopSheetPanel = ({
  stopId,
  stopName: stopNameProp,
  isOpen,
  onClose,
  onFollowTrip,
  platformStopIds,
  preferredDirection,
  onRouteSelect,
  mapPanelRef,
  panelRootRef,
  allowRefs,
  mobileSheetHeight,
  overlayHeight,
  followError,
  followLoading = false,
}: StopSheetPanelProps) => {
  const perfRenderStartRef = useRef<number | null>(null);
  const perfRenderCountRef = useRef(0);
  if (typeof window !== "undefined") {
    perfRenderStartRef.current = performance.now();
  }
  const safeAllowRefs = allowRefs ?? NO_EXTRA_REFS;
  const { mode: themeMode } = useThemeMode();
  const isDarkTheme = themeMode === "dark";
  const headerBadgeBg = isDarkTheme ? "rgba(8,10,18,0.65)" : "rgba(255,255,255,0.85)";
  const headerBadgeBorder = isDarkTheme ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.08)";
  const headerLabelColor = isDarkTheme ? "rgba(229,231,235,0.85)" : "rgba(15,23,42,0.65)";
  const headerTitleColor = isDarkTheme ? "rgba(255,255,255,0.98)" : "rgba(5,5,7,0.95)";
  const closeButtonBg = isDarkTheme ? "rgba(6,7,12,0.7)" : "rgba(255,255,255,0.95)";
  const closeButtonColor = isDarkTheme ? "#f8fafc" : "#0f172a";
  const cachedBoardStopId = useMemo(() => {
    const cache = readStationBoardCache();
    return cache[stopId] ?? null;
  }, [stopId]);

  const isNonBoardableStopId = useCallback((candidate?: string | null) => {
    if (!candidate) return true;
    return (
      candidate.startsWith("node-") ||
      candidate.startsWith("entrance-") ||
      candidate.startsWith("door-") ||
      candidate.startsWith("elevator-")
    );
  }, []);

  const stopOptions = useMemo(() => {
    const base = platformStopIds && platformStopIds.length > 0 ? platformStopIds : [stopId];
    const deduped = Array.from(new Set(base.filter((id) => id && !isNonBoardableStopId(id))));
    const withoutPrimary = deduped.filter((id) => id !== stopId);
    const ordered = isNonBoardableStopId(stopId) ? withoutPrimary : [stopId, ...withoutPrimary];
    if (cachedBoardStopId && ordered.includes(cachedBoardStopId)) {
      return [cachedBoardStopId, ...ordered.filter((id) => id !== cachedBoardStopId)];
    }
    // Always try the canonical stop id first so we fetch the full station board.
    return ordered;
  }, [platformStopIds, stopId, cachedBoardStopId, isNonBoardableStopId]);

  const BOARD_TIMEOUT_MS = 7000;

  const boardQuery = useQuery({
    queryKey: ["stationBoard", stopOptions.join("|")],
    queryFn: async () => {
      const withTimeout = <T,>(promise: Promise<T>, label: string) =>
        new Promise<T>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`Station board timeout for ${label}`));
          }, BOARD_TIMEOUT_MS);
          promise
            .then((value) => {
              clearTimeout(timer);
              resolve(value);
            })
            .catch((error) => {
              clearTimeout(timer);
              reject(error);
          });
        });

      const errors: unknown[] = [];
      for (const optionId of stopOptions) {
        try {
          const board = await withTimeout(
            fetchStationBoard(optionId, { includeAlerts: true, includeFacilities: true }),
            optionId,
          );
          if (!board) {
            throw new Error(`Station board unavailable for ${optionId}`);
          }
          writeStationBoardCache(stopId, optionId);
          return board;
        } catch (error) {
          errors.push(error);
        }
      }

      throw new Error("Station board unavailable");
    },
    enabled: isOpen && stopOptions.length > 0,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const board = boardQuery.data;
  const details = board?.details ?? { alerts: [], facilities: [] };
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
    board?.details?.departures?.forEach((departure) => {
      const key = `${departure.routeId}-${departure.direction}`;
      const normalized = normalizeDestinationLabel(departure.destination);
      if (map.has(key)) return;
      if (normalized) {
        map.set(key, normalized);
      }
    });
    return map;
  }, [board?.details?.departures]);

  const routeDirectionOptions = useMemo(() => {
    const priorityOrder: Record<string, number> = {
      Red: 3,
      "Green-B": 2,
      "Green-C": 2,
      "Green-D": 2,
      "Green-E": 2,
      Mattapan: 1,
      CommuterRail: 1,
      Bus: 0,
    };
    return routeGroups
      .flatMap((group) =>
        group.directions.map((direction) => {
          const directionLabel = humanizeDirection(direction.direction);
          const routeLabel = direction.shortName ?? group.shortName ?? group.routeId;
          const token = getLineToken(group.routeId, themeMode);
        const key = `${direction.routeId}-${direction.direction}`;
        const etaMinutes =
          direction.primaryEta?.etaMinutes ??
          direction.extraEtas?.[0]?.etaMinutes ??
          null;
    return {
      group,
      direction,
      directionId: toDirectionId(direction.direction),
      directionLabel,
      directionKey: getRouteKey(direction),
      routeLabel,
      lineToken: token,
      priority: priorityOrder[token.id] ?? 0,
      etaMinutes,
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
  const lastRouteSelectRef = useRef<string | null>(null);

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
  const collapseEnabled = routeDirectionOptions.length > 4;
  const singleRouteOnly = routeGroups.length <= 1;
  const areRoutesExpanded = collapseEnabled ? routeExpansion[stopId] ?? false : true;
  const visibleRouteOptions = useMemo(() => {
    if (!collapseEnabled || areRoutesExpanded) return routeDirectionOptions;

    const byEta = (a: (typeof routeDirectionOptions)[number], b: (typeof routeDirectionOptions)[number]) => {
      const etaA = a.etaMinutes ?? Number.POSITIVE_INFINITY;
      const etaB = b.etaMinutes ?? Number.POSITIVE_INFINITY;
      if (etaA !== etaB) return etaA - etaB;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.routeLabel.localeCompare(b.routeLabel);
    };

    const inbound = routeDirectionOptions.filter((opt) => opt.directionId === 0).sort(byEta).slice(0, 2);
    const outbound = routeDirectionOptions.filter((opt) => opt.directionId === 1).sort(byEta).slice(0, 2);
    const neutral = routeDirectionOptions.filter((opt) => opt.directionId == null).sort(byEta);
    const picked: Array<(typeof routeDirectionOptions)[number]> = [];
    const maxPairs = Math.max(inbound.length, outbound.length);
    for (let i = 0; i < maxPairs; i += 1) {
      if (inbound[i]) picked.push(inbound[i]);
      if (outbound[i]) picked.push(outbound[i]);
    }
    const seen = new Set(picked.map((opt) => opt.directionKey));
    neutral.forEach((opt) => {
      if (picked.length >= 4) return;
      if (seen.has(opt.directionKey)) return;
      seen.add(opt.directionKey);
      picked.push(opt);
    });
    if (picked.length < 4) {
      [...routeDirectionOptions].sort(byEta).forEach((opt) => {
        if (picked.length >= 4) return;
        if (seen.has(opt.directionKey)) return;
        seen.add(opt.directionKey);
        picked.push(opt);
      });
    }
    return picked;
  }, [areRoutesExpanded, collapseEnabled, routeDirectionOptions]);

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

  useEffect(() => {
    if (!onRouteSelect) return;
    const nextRouteId = activeRouteGroup?.routeId ?? null;
    if (lastRouteSelectRef.current === nextRouteId) return;
    lastRouteSelectRef.current = nextRouteId;
    onRouteSelect(nextRouteId);
  }, [activeRouteGroup?.routeId, onRouteSelect]);

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
      onRouteSelect?.(option.group.routeId);
      if (collapseEnabled) {
        setRouteExpansion((prev) => ({ ...prev, [stopId]: false }));
      }
    },
    [setSelectedRouteId, setSelectedDirectionKey, stopId, collapseEnabled, onRouteSelect],
  );

  const activeDirectionOption = useMemo(
    () => routeDirectionOptions.find((option) => option.directionKey === activeDirectionKey) ?? null,
    [routeDirectionOptions, activeDirectionKey],
  );

  const displayRouteOptions = useMemo(() => {
    if (!collapseEnabled || areRoutesExpanded) return routeDirectionOptions;
    let options = [...visibleRouteOptions];
    if (activeDirectionOption && !options.some((opt) => opt.directionKey === activeDirectionOption.directionKey)) {
      options = [...options.slice(0, Math.max(0, 3)), activeDirectionOption];
    }
    return options;
  }, [activeDirectionOption, areRoutesExpanded, collapseEnabled, routeDirectionOptions, visibleRouteOptions]);

  const preferSingleColumnRoutes = singleRouteOnly || displayRouteOptions.length <= 1;
  const routeListGridClass = `grid gap-2 ${preferSingleColumnRoutes ? "sm:grid-cols-1" : "sm:grid-cols-2"}`;

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
          data-interactive="ghost"
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
    const activeDirectionId = toDirectionId(activeRoute.direction);
    const detailed =
      board?.details?.departures?.filter((departure) => {
        if (departure.routeId !== activeRoute.routeId) return false;
        const departureDirectionId = toDirectionId(departure.direction);
        if (activeDirectionId != null && departureDirectionId != null) {
          return activeDirectionId === departureDirectionId;
        }
        if (!activeRoute.direction || !departure.direction) return true;
        return directionsMatch(departure.direction, activeRoute.direction);
      }) ?? [];
    const etaCandidates = [activeRoute.primaryEta, ...activeRoute.extraEtas].filter(
      Boolean,
    ) as StationEta[];
    const mapped = etaCandidates.map((eta) => mapEtaToDeparture(eta, activeRoute));

    const combinedDepartures = [...detailed, ...mapped].sort(compareDepartures);
    const uniqueDepartures: StationDeparture[] = [];
    const seenKeys = new Set<string>();

    const getDepartureKey = (departure: StationDeparture) => {
      const tripId = (departure as StationDepartureWithTrip).tripId ?? null;
      if (tripId) return `trip:${tripId}`;
      const minuteKey = getDepartureMinuteKey(departure);
      const destination = normalizeDestinationLabel(departure.destination) ?? "";
      return `${departure.routeId}-${departure.direction ?? ""}-${minuteKey ?? "na"}-${destination}`;
    };

    combinedDepartures.forEach((departure) => {
      const key = getDepartureKey(departure);
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      uniqueDepartures.push(departure);
    });

    const hero = uniqueDepartures[0] ?? null;
    const upcoming = uniqueDepartures.slice(1, 13);

    return {
      heroDeparture: hero,
      upcomingDepartures: upcoming,
    };
  }, [board?.details?.departures, activeRoute]);
  const heroTone = heroDeparture?.status ? statusTone(heroDeparture.status) : null;
  const heroSource = heroDeparture?.source ?? activeRoute?.primaryEta?.source;
  const heroTripId =
    (heroDeparture as StationDepartureWithTrip | null)?.tripId ?? activeRoute?.primaryEta?.tripId ?? null;
  const heroVehicleId = (heroDeparture as StationDepartureWithTrip | null)?.vehicleId ?? null;
  const heroCanFollow = Boolean(heroTripId && heroVehicleId);
  const heroEta = heroDeparture?.etaMinutes ?? activeRoute?.primaryEta?.etaMinutes ?? null;
  const heroClock =
    heroDeparture?.predictedTime ??
    heroDeparture?.scheduledTime ??
    activeRoute?.primaryEta?.predictedTime ??
    activeRoute?.primaryEta?.scheduledTime;
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
  const routeLabel = activeRoute?.shortName ?? activeRoute?.routeId ?? null;
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
    if (typeof window === "undefined") return;
    if (window.localStorage?.getItem("perf-debug") !== "1") return;
    const start = perfRenderStartRef.current;
    perfRenderCountRef.current += 1;
    if (!start) return;
    requestAnimationFrame(() => {
      void (performance.now() - start);
    });
  });

  const stopName = board?.primary.stopName ?? stopNameProp ?? stopId;
  const primaryStopId = board?.primary.stopId ?? stopId;
  const landmarkImage = useMemo(
    () => getLandmarkImage({ stopName, stopId: primaryStopId }),
    [stopName, primaryStopId],
  );

  const mobileSheetRef = useRef<HTMLElement | null>(null);
  const desktopSheetRef = useRef<HTMLElement | null>(null);
  const mobileScrollRef = useRef<HTMLDivElement | null>(null);
  const desktopScrollRef = useRef<HTMLDivElement | null>(null);
  const departuresSectionRef = useRef<HTMLDivElement | null>(null);
  const alertsSectionRef = useRef<HTMLDivElement | null>(null);
  const facilitiesSectionRef = useRef<HTMLDivElement | null>(null);
  const [activeSheetTab, setActiveSheetTab] = useState<"departures" | "alerts" | "facilities">("departures");
  const mobileSheetHeightValue = mobileSheetHeight ?? MOBILE_SHEET_DEFAULT_HEIGHT;
  const overlayHeightValue = overlayHeight ?? mobileSheetHeightValue;

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

  useEffect(() => {
    if (!isOpen) return;
    setActiveSheetTab("departures");
    const scrollNode = mobileScrollRef.current ?? desktopScrollRef.current;
    if (!scrollNode) return;
    requestAnimationFrame(() => {
      scrollNode.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    });
  }, [isOpen, stopId]);

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
    const scrollRef = variant === "mobile" ? mobileScrollRef : desktopScrollRef;
    const sheetStyle =
      variant === "mobile"
        ? {
            height: mobileSheetHeightValue,
            maxHeight: mobileSheetHeightValue,
            "--stop-sheet-mobile-height": mobileSheetHeightValue,
          }
        : undefined;
    const showTabs = variant === "mobile";
    const scrollToSection = (section: "departures" | "alerts" | "facilities") => {
      setActiveSheetTab(section);
      const target =
        section === "departures"
          ? departuresSectionRef.current
          : section === "alerts"
            ? alertsSectionRef.current
            : facilitiesSectionRef.current;
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    return (
      <section
        className={`stop-sheet-panel flex h-full w-full flex-col overflow-hidden bg-[color:var(--card)] text-[color:var(--foreground)] shadow-2xl ${
          variant === "desktop" ? "rounded-r-3xl" : "rounded-t-3xl"
        }`}
        role="dialog"
        aria-modal="true"
        aria-label={`Stop sheet for ${stopName}`}
        ref={sheetRef}
        style={sheetStyle as CSSProperties | undefined}
      >
      <header
        className={`stop-sheet-header sticky top-0 z-10 overflow-hidden border-b px-6 py-5 ${
          variant === "desktop" ? "rounded-tr-3xl" : "rounded-t-3xl"
        }`}
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
              className="touch-target flex h-10 w-10 items-center justify-center rounded-full text-lg font-semibold shadow transition"
              onClick={handleClose}
              aria-label="Close stop sheet"
              data-interactive="icon"
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
                  <div className={routeListGridClass}>
                    {displayRouteOptions.map((option) => routeOptionButton(option))}
                  </div>
                  {collapseEnabled && !areRoutesExpanded && routeDirectionOptions.length > displayRouteOptions.length && (
                    <button
                      type="button"
                      className="btn btn-ghost mt-2 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.2em]"
                      onClick={() => setRouteExpansion((prev) => ({ ...prev, [stopId]: true }))}
                      aria-label="Show all routes at this stop"
                      data-interactive="ghost"
                      style={{
                        border: "1px solid var(--border)",
                        color: "var(--foreground)",
                        background: "var(--surface)",
                      }}
                    >
                      <FiChevronDown />
                      <span>More routes</span>
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </header>
      <div
        ref={scrollRef}
        className="stop-sheet-scroll flex-1 overflow-y-auto pb-8 pt-5"
        style={{
          background: "var(--surface-soft)",
          paddingBottom: `calc(env(safe-area-inset-bottom, 0px) + 1.5rem)`,
        }}
      >
        {showTabs && (
          <div
            className="sticky top-0 z-20 -mx-6 mb-4 border-b px-6 pb-3 pt-2"
            style={{
              borderColor: "color-mix(in srgb, var(--border) 70%, transparent)",
              background: "color-mix(in srgb, var(--card) 90%, transparent)",
              backdropFilter: "blur(10px)",
            }}
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-full px-3 py-1 text-xs font-semibold transition"
                aria-pressed={activeSheetTab === "departures"}
                onClick={() => scrollToSection("departures")}
                style={{
                  background:
                    activeSheetTab === "departures"
                      ? "color-mix(in srgb, var(--accent) 22%, transparent)"
                      : "transparent",
                  color: "var(--foreground)",
                  border: "1px solid var(--border)",
                }}
              >
                Departures
              </button>
              <button
                type="button"
                className="rounded-full px-3 py-1 text-xs font-semibold transition"
                aria-pressed={activeSheetTab === "alerts"}
                onClick={() => scrollToSection("alerts")}
                style={{
                  background:
                    activeSheetTab === "alerts"
                      ? "color-mix(in srgb, var(--accent) 22%, transparent)"
                      : "transparent",
                  color: "var(--foreground)",
                  border: "1px solid var(--border)",
                }}
              >
                Alerts
              </button>
              <button
                type="button"
                className="rounded-full px-3 py-1 text-xs font-semibold transition"
                aria-pressed={activeSheetTab === "facilities"}
                onClick={() => scrollToSection("facilities")}
                style={{
                  background:
                    activeSheetTab === "facilities"
                      ? "color-mix(in srgb, var(--accent) 22%, transparent)"
                      : "transparent",
                  color: "var(--foreground)",
                  border: "1px solid var(--border)",
                }}
              >
                Facilities
              </button>
            </div>
          </div>
        )}
        {boardQuery.isLoading && <div className="px-6"><LoadingSkeleton /></div>}
        {boardQuery.isError && (
          <div className="px-6">
            <div className="panel border-[color:var(--line-red)]/40 text-sm" style={{ background: "color-mix(in srgb, var(--line-red) 8%, var(--card))" }}>
              <p className="font-semibold" style={{ color: "var(--line-red)" }}>
                We couldn&apos;t load departures for this stop.
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
            <div id="stop-sheet-departures" ref={departuresSectionRef} style={{ scrollMarginTop: "96px" }}>
              <p className="text-xs uppercase tracking-[0.35em] mb-3" style={{ color: "var(--muted)" }}>
                Next departure
              </p>
              {showHeroPlaceholder ? (
                <HeroPlaceholder />
              ) : heroDeparture ? (
                <div className="panel shadow-inner" style={{ background: heroHue.background, borderColor: heroHue.borderColor }}>
                  <button
                    type="button"
                    className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
                    onClick={() => heroCanFollow && !followLoading && onFollowTrip(heroTripId)}
                    disabled={!heroCanFollow || followLoading}
                    aria-disabled={!heroCanFollow || followLoading}
                    title={
                      !heroTripId
                        ? "Trip tracking not available"
                        : !heroVehicleId
                          ? "Live vehicle tracking unavailable for this trip"
                          : "Follow this trip on the map"
                    }
                    data-interactive="ghost"
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
                      {heroCanFollow ? (
                        <div
                          className="btn btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm transition"
                          style={{ position: "relative", opacity: followLoading ? 0.75 : 1 }}
                        >
                          <FiArrowRightCircle className="text-base" />
                          <span>{followLoading ? "Checking…" : "Follow"}</span>
                          <span className="inline-flex ml-0.5" onClick={(e) => e.stopPropagation()}>
                            <InfoTooltip content="Track this vehicle in real-time on the map" />
                          </span>
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs" style={{ color: "var(--muted)" }}>
                          Live tracking unavailable
                          <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
                            <InfoTooltip content="MBTA real-time data doesn't include a vehicle for this trip yet." />
                          </span>
                        </span>
                      )}
                    </div>
                  </button>
                  {followError && (
                    <div className="mt-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "rgba(244,63,94,0.35)", color: "#fecdd3", background: "rgba(244,63,94,0.12)" }}>
                      {followError}
                    </div>
                  )}
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
            {(boardQuery.isLoading || board?.details) && (
              <div className="space-y-6">
                <div id="stop-sheet-alerts" ref={alertsSectionRef} style={{ scrollMarginTop: "96px" }}>
                  <p className="heading-label text-slate-400">Alerts</p>
                  <div className="mt-3">
                    <AlertList alerts={details.alerts} isLoading={boardQuery.isLoading} />
                  </div>
                </div>
                <div id="stop-sheet-facilities" ref={facilitiesSectionRef} style={{ scrollMarginTop: "96px" }}>
                  <p className="heading-label text-slate-400">Facilities</p>
                  <div className="mt-3">
                    <FacilitiesList facilities={details.facilities} isLoading={boardQuery.isLoading} />
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
      <div className="fixed inset-0 z-50 flex flex-col md:hidden pointer-events-none">
        <div
          className="mt-auto w-full pointer-events-auto"
          style={{ height: overlayHeightValue }}
          onClick={(evt) => evt.stopPropagation()}
        >
          {renderSheet("mobile")}
        </div>
      </div>
      <div className="fixed inset-0 z-50 hidden md:block pointer-events-none">
        <div className="flex h-full w-full justify-start">
          <div className="pointer-events-auto flex h-full" onClick={(evt) => evt.stopPropagation()}>
            {renderSheet("desktop")}
          </div>
        </div>
      </div>
    </>
  );
};
