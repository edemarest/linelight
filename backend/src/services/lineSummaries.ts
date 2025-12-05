import type { MbtaLine, MbtaRoute } from "../models/mbta";
import type { MbtaCache } from "../cache/mbtaCache";
import { extractFirstRelationshipId, extractRelationshipIds } from "../utils/jsonApi";
import { mapRouteTypeToMode } from "../utils/routeMode";
import type { LineSummary, Mode } from "../models/domain";

const DEFAULT_COLOR = "#6366f1";

const toArray = <T>(value: T | T[] | null | undefined): T[] => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const getLineRouteIds = (line: MbtaLine): string[] => {
  const relationshipIds = extractRelationshipIds(line.relationships?.routes);
  if (relationshipIds.length > 0) {
    return relationshipIds;
  }
  return [line.id];
};

const buildRoutesMap = (routes: MbtaRoute[]) =>
  new Map<string, MbtaRoute>(routes.map((route) => [route.id, route]));

const determineColor = (line: MbtaLine, routesMap: Map<string, MbtaRoute>): string => {
  const rawColor = line.attributes.color ?? null;
  if (rawColor) return `#${rawColor}`;

  const firstRoute = getLineRouteIds(line)
    .map((routeId) => routesMap.get(routeId))
    .find(Boolean);

  if (firstRoute?.attributes.color) {
    return `#${firstRoute.attributes.color}`;
  }

  return DEFAULT_COLOR;
};

const determineMode = (line: MbtaLine, routesMap: Map<string, MbtaRoute>): Mode => {
  const firstRoute = getLineRouteIds(line)
    .map((routeId) => routesMap.get(routeId))
    .find(Boolean);
  return mapRouteTypeToMode(firstRoute?.attributes.type);
};

const computeVehicleCounts = (
  vehicleRouteIds: Array<{ routeId: string }>,
): Map<string, number> => {
  const counts = new Map<string, number>();

  vehicleRouteIds.forEach(({ routeId }) => {
    counts.set(routeId, (counts.get(routeId) ?? 0) + 1);
  });

  return counts;
};

const collectVehicleRouteIds = (cache: MbtaCache) => {
  const vehiclesEntry = cache.getVehicles();
  const vehicles = vehiclesEntry?.data ?? [];

  return vehicles
    .map((vehicle) => extractFirstRelationshipId(vehicle.relationships?.route))
    .filter((routeId): routeId is string => Boolean(routeId))
    .map((routeId) => ({ routeId }));
};

const collectAlertRouteIds = (cache: MbtaCache) => {
  const alertsEntry = cache.getAlerts();
  const alerts = alertsEntry?.data ?? [];

  return alerts.map((alert) => ({
    alertId: alert.id,
    routeIds: extractRelationshipIds(alert.relationships?.routes),
  }));
};

interface LineSummaryOptions {
  mode?: Mode | undefined;
}

export const buildLineSummaries = (cache: MbtaCache, options: LineSummaryOptions = {}) => {
  const linesEntry = cache.getLines();
  const routesEntry = cache.getRoutes();

  const generatedAt = new Date().toISOString();

  if (!linesEntry || !routesEntry) {
    return {
      ready: false,
      lines: [] as LineSummary[],
      generatedAt,
    };
  }

  const routesMap = buildRoutesMap(routesEntry.data);
  const vehicleCounts = computeVehicleCounts(collectVehicleRouteIds(cache));
  const alertsByRoute = collectAlertRouteIds(cache);

  const lines = linesEntry.data.map<LineSummary>((line) => {
    const routeIds = getLineRouteIds(line);
    const vehicleCount = routeIds.reduce(
      (count, routeId) => count + (vehicleCounts.get(routeId) ?? 0),
      0,
    );
    const hasAlerts = alertsByRoute.some((alert) =>
      alert.routeIds.some((routeId) => routeIds.includes(routeId)),
    );

    const updatedTimestamp = Math.max(
      linesEntry.fetchedAt,
      routesEntry.fetchedAt,
      cache.getVehicles()?.fetchedAt ?? 0,
      cache.getAlerts()?.fetchedAt ?? 0,
    );

    return {
      lineId: line.id,
      displayName: line.attributes.long_name ?? line.attributes.short_name ?? line.id,
      color: determineColor(line, routesMap),
      mode: determineMode(line, routesMap),
      hasAlerts,
      vehicleCount,
      updatedAt: new Date(updatedTimestamp).toISOString(),
    };
  });

  return {
    ready: true,
    lines: options.mode ? lines.filter((line) => line.mode === options.mode) : lines,
    generatedAt,
  };
};
