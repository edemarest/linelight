import type { MbtaCache } from "../cache/mbtaCache";
import type { MbtaClient } from "../mbta/client";
import type {
  GetStationBoardResponse,
  StationBoardRoutePrimary,
  StationBoardDetails,
  StationDeparture,
  StationEta,
} from "@linelight/core";
import type { BlendedDeparture } from "./etaBlender";
import { getCachedStopEtaSnapshot, getStopEtaSnapshot, type StopEtaSnapshot } from "./etaService";
import { haversineDistanceMeters } from "../utils/geo";
import { resolveBoardableParent } from "../utils/stationKind";
import { extractFirstRelationshipId } from "../utils/jsonApi";
import { mapRouteTypeToMode } from "../utils/routeMode";
import type { Mode } from "../models/domain";
import { logger } from "../utils/logger";
import type { MbtaRoute, MbtaStop } from "../models/mbta";

const toStationEta = (departure: BlendedDeparture): StationEta => {
  const eta: StationEta = {
    etaMinutes: departure.etaMinutes ?? null,
    source: departure.etaSource,
    status: departure.status,
  };
  if (departure.scheduledTime) {
    eta.scheduledTime = departure.scheduledTime;
  }
  if (departure.predictedTime) {
    eta.predictedTime = departure.predictedTime;
  }
  if (departure.tripId) {
    eta.tripId = departure.tripId;
  }
  return eta;
};

const normalizeLabel = (value?: string | null): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const resolveRouteDestination = (
  departure: BlendedDeparture,
  routesMap: Map<string, MbtaRoute>,
): string | null => {
  const explicit = normalizeLabel(departure.headsign);
  if (explicit) return explicit;
  if (!departure.routeId) return null;
  const route = routesMap.get(departure.routeId);
  if (!route) return null;
  if (departure.directionId != null) {
    const fromRoute = normalizeLabel(route.attributes.direction_destinations?.[departure.directionId] ?? null);
    if (fromRoute) {
      return fromRoute;
    }
  }
  return normalizeLabel(route.attributes.long_name) ?? normalizeLabel(route.attributes.short_name) ?? null;
};

const directionIdToLabel = (directionId: 0 | 1 | null | undefined): string => {
  if (directionId === 0) return "Inbound";
  if (directionId === 1) return "Outbound";
  return "Unknown";
};

const DETAIL_DEPARTURE_DIRECTION_LIMIT = 6;
const DETAIL_DEPARTURE_TOTAL_LIMIT = 60;

const groupDepartures = (
  departures: BlendedDeparture[],
  routesMap: Map<string, MbtaRoute>,
): StationBoardRoutePrimary[] => {
  const groups = new Map<string, BlendedDeparture[]>();
  departures.forEach((departure) => {
    const key = `${departure.routeId ?? "unknown"}-${departure.directionId ?? "na"}`;
    const existing = groups.get(key) ?? [];
    existing.push(departure);
    groups.set(key, existing);
  });

  return Array.from(groups.values()).map((group) => {
    group.sort((a, b) => (a.etaMinutes ?? Infinity) - (b.etaMinutes ?? Infinity));
    const primary = group[0];
    if (!primary) {
      return {
        routeId: "unknown",
        shortName: "Route",
        mode: "other" as Mode,
        direction: "Unknown",
        primaryEta: null,
        extraEtas: [],
      };
    }
    const route = primary.routeId ? routesMap.get(primary.routeId) : undefined;
    const mode = route ? mapRouteTypeToMode(route.attributes.type) : ("other" as Mode);
    const shortName =
      normalizeLabel(route?.attributes.short_name) ?? normalizeLabel(route?.attributes.long_name) ?? primary.routeId ?? "Route";
    return {
      routeId: primary.routeId ?? "unknown",
      shortName,
      mode,
      direction: directionIdToLabel(primary.directionId),
      primaryEta: toStationEta(primary),
      extraEtas: group.slice(1, 4).map(toStationEta),
    };
  });
};

const toStationDeparture = (
  departure: BlendedDeparture,
  routesMap: Map<string, MbtaRoute>,
): StationDeparture => {
  const directionLabel = directionIdToLabel(departure.directionId);
  const row: StationDeparture = {
    routeId: departure.routeId ?? "unknown",
    shortName: departure.routeId ?? "Route",
    direction: directionLabel,
    destination: resolveRouteDestination(departure, routesMap) ?? "—",
    etaMinutes: departure.etaMinutes ?? null,
    source: departure.etaSource,
    status: departure.status,
  };
  if (departure.scheduledTime) {
    row.scheduledTime = departure.scheduledTime;
  }
  if (departure.predictedTime) {
    row.predictedTime = departure.predictedTime;
  }
  return row;
};

const parseTimestamp = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const collectPlatformStopIds = (stopMap: Map<string, MbtaStop>, station: MbtaStop): string[] => {
  const ids = new Set<string>();
  ids.add(station.id);
  stopMap.forEach((stop) => {
    const parentId = extractFirstRelationshipId(stop.relationships?.parent_station);
    if (parentId === station.id) {
      ids.add(stop.id);
    }
  });
  return Array.from(ids);
};

const sortDeparturesByFinalTime = (departures: BlendedDeparture[]): BlendedDeparture[] => {
  return [...departures].sort((a, b) => {
    const aTs = parseTimestamp(a.finalTime);
    const bTs = parseTimestamp(b.finalTime);
    if (aTs == null && bTs == null) return 0;
    if (aTs == null) return 1;
    if (bTs == null) return -1;
    return aTs - bTs;
  });
};

export const buildStationBoardV2 = async (
  cache: MbtaCache,
  client: MbtaClient,
  stopId: string,
  params: { lat?: number; lng?: number } = {},
): Promise<GetStationBoardResponse | null> => {
  const stopsEntry = cache.getStops();
  const stopMap = stopsEntry ? new Map(stopsEntry.data.map((entry) => [entry.id, entry])) : null;
  const requestedStop = stopMap?.get(stopId);
  if (!requestedStop || !stopMap) {
    return null;
  }
  const boardableStop = resolveBoardableParent(requestedStop, stopMap);
  if (!boardableStop) {
    return null;
  }

  const routesEntry = cache.getRoutes();
  const routesMap = new Map<string, MbtaRoute>((routesEntry?.data ?? []).map((route) => [route.id, route]));

  const platformStopIds = collectPlatformStopIds(stopMap, boardableStop);
  const snapshotMap = new Map<string, StopEtaSnapshot>();
  platformStopIds.forEach((platformId) => {
    const cached = getCachedStopEtaSnapshot(cache, platformId, {
      maxLookaheadMinutes: 60,
      minLookaheadMinutes: -2,
    });
    if (cached) {
      snapshotMap.set(platformId, cached);
    }
  });

  const missingPlatformIds = platformStopIds.filter((platformId) => !snapshotMap.has(platformId));
  const fetchedSnapshots = await Promise.all(
    missingPlatformIds.map(async (platformId) => {
      try {
        return await getStopEtaSnapshot(client, platformId, {
          maxLookaheadMinutes: 60,
          minLookaheadMinutes: -2,
        });
      } catch (error) {
        logger.error("Failed to fetch station board snapshot", {
          stopId: platformId,
          message: String(error),
        });
        return null;
      }
    }),
  );
  fetchedSnapshots.forEach((snapshot) => {
    if (snapshot) {
      snapshotMap.set(snapshot.stopId, snapshot);
    }
  });

  const departures = sortDeparturesByFinalTime(
    platformStopIds
      .map((platformId) => snapshotMap.get(platformId))
      .filter((snapshot): snapshot is NonNullable<typeof snapshot> => Boolean(snapshot))
      .flatMap((snapshot) => snapshot.departures ?? []),
  );

  const primaryRoutes = groupDepartures(departures, routesMap);
  const detailDepartureCounts = new Map<string, number>();
  const detailDepartures: StationDeparture[] = [];
  for (const departure of departures) {
    if (detailDepartures.length >= DETAIL_DEPARTURE_TOTAL_LIMIT) {
      break;
    }
    const routeIdKey = departure.routeId ?? "unknown";
    const directionLabel = directionIdToLabel(departure.directionId);
    const detailKey = `${routeIdKey}-${directionLabel}`;
    const count = detailDepartureCounts.get(detailKey) ?? 0;
    if (count >= DETAIL_DEPARTURE_DIRECTION_LIMIT) {
      continue;
    }
    detailDepartureCounts.set(detailKey, count + 1);
    detailDepartures.push(toStationDeparture(departure, routesMap));
  }

  const details: StationBoardDetails = {
    departures: detailDepartures,
    alerts: [],
    facilities: [],
  };

  const distanceMeters =
    params.lat != null && params.lng != null
      ? haversineDistanceMeters(params.lat, params.lng, boardableStop.attributes.latitude, boardableStop.attributes.longitude)
      : undefined;

  const primary: GetStationBoardResponse["primary"] = {
    stopId: boardableStop.id,
    stopName: boardableStop.attributes.name,
    routes: primaryRoutes,
  };

  if (distanceMeters != null) {
    primary.distanceMeters = distanceMeters;
    primary.walkMinutes = Math.round(distanceMeters / 80);
  }

  return {
    primary,
    details,
  };
};
