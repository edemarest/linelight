import type { MbtaCache } from "../cache/mbtaCache";
import type {
  LineOverview,
  LineAlertSummary,
  SegmentStatus,
  LineId,
  Coordinate,
} from "../models/domain";
import type { MbtaLine, MbtaRoute, MbtaAlert, MbtaPrediction, MbtaStop } from "../models/mbta";
import { extractFirstRelationshipId, extractRelationshipIds } from "../utils/jsonApi";
import { mapRouteTypeToMode } from "../utils/routeMode";

const getLineById = (cache: MbtaCache, lineId: LineId) => {
  const lines = cache.getLines();
  if (!lines) return null;
  return lines.data.find((line) => line.id === lineId) ?? null;
};

const buildRoutesMap = (routes: MbtaRoute[] = []) =>
  new Map<string, MbtaRoute>(routes.map((route) => [route.id, route]));

const resolveColor = (line: MbtaLine, routesMap: Map<string, MbtaRoute>) => {
  if (line.attributes.color) return `#${line.attributes.color}`;
  const firstRoute = getRouteIdsForLine(line)
    .map((routeId) => routesMap.get(routeId))
    .find(Boolean);
  return firstRoute?.attributes.color ? `#${firstRoute.attributes.color}` : "#6366f1";
};

const getRouteIdsForLine = (line: MbtaLine) => {
  const relationshipIds = extractRelationshipIds(line.relationships?.routes);
  if (relationshipIds.length > 0) return relationshipIds;
  return [line.id];
};

const filterAlertsForRoutes = (alerts: MbtaAlert[] = [], routeIds: string[]) =>
  alerts
    .filter((alert) =>
      extractRelationshipIds(alert.relationships?.routes).some((id) => routeIds.includes(id)),
    )
    .map<LineAlertSummary>((alert) => ({
      alertId: alert.id,
      header: alert.attributes.header_text ?? "Service alert",
      severity: alert.attributes.severity,
      effect: alert.attributes.effect,
      lifecycle: alert.attributes.lifecycle,
    }));

const getPredictionsForRoutes = (predictions: MbtaPrediction[] = [], routeIds: string[]) =>
  predictions.filter((prediction) => {
    const routeId = extractFirstRelationshipId(prediction.relationships?.route);
    return routeId ? routeIds.includes(routeId) : false;
  });

const toTimestamp = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const computeHeadwayMinutes = (predictions: MbtaPrediction[]) => {
  const groups = new Map<number, number[]>();

  predictions.forEach((prediction) => {
    const direction = prediction.attributes.direction_id ?? 0;
    const timestamp =
      toTimestamp(prediction.attributes.arrival_time) ??
      toTimestamp(prediction.attributes.departure_time);

    if (timestamp) {
      const list = groups.get(direction) ?? [];
      list.push(timestamp);
      groups.set(direction, list);
    }
  });

  const averages: number[] = [];

  groups.forEach((timestamps) => {
    const sorted = timestamps.sort((a, b) => a - b);
    if (sorted.length < 2) return;
    const deltas: number[] = [];
    for (let i = 1; i < sorted.length; i += 1) {
      const current = sorted[i];
      const previous = sorted[i - 1];
      if (current == null || previous == null) continue;
      const deltaMinutes = (current - previous) / 60000;
      if (deltaMinutes > 0) deltas.push(deltaMinutes);
    }

    if (deltas.length > 0) {
      const avg = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
      averages.push(avg);
    }
  });

  if (averages.length === 0) return null;

  return averages.reduce((sum, value) => sum + value, 0) / averages.length;
};

const buildStopsMap = (stops: MbtaStop[] = []) =>
  new Map<string, MbtaStop>(stops.map((stop) => [stop.id, stop]));

const buildCoordinates = (
  fromStopId: string,
  toStopId: string,
  stopsMap: Map<string, MbtaStop>,
): Coordinate[] => {
  const from = stopsMap.get(fromStopId);
  const to = stopsMap.get(toStopId);
  if (!from || !to) return [];
  return [
    { lat: from.attributes.latitude, lng: from.attributes.longitude },
    { lat: to.attributes.latitude, lng: to.attributes.longitude },
  ];
};

const computeStopHeadways = (predictions: MbtaPrediction[]) => {
  const headways = new Map<string, number>();
  const grouped = new Map<string, number[]>();

  predictions.forEach((prediction) => {
    const stopId = extractFirstRelationshipId(prediction.relationships?.stop);
    if (!stopId) return;
    const directionId = prediction.attributes.direction_id ?? 0;
    const key = `${directionId}-${stopId}`;

    const predictedTime =
      toTimestamp(prediction.attributes.arrival_time) ??
      toTimestamp(prediction.attributes.departure_time);

    if (!predictedTime) return;

    const times = grouped.get(key) ?? [];
    times.push(predictedTime);
    grouped.set(key, times);
  });

  grouped.forEach((timestamps, key) => {
    const sorted = timestamps.sort((a, b) => a - b);
    if (sorted.length < 2) return;
    const first = sorted[0];
    const second = sorted[1];
    if (first == null || second == null) return;
    const deltaMinutes = (second - first) / 60000;
    if (deltaMinutes > 0) {
      headways.set(key, deltaMinutes);
    }
  });

  return headways;
};

const determineSegmentHealth = (
  headway: number | null,
  typical: number | null,
): SegmentStatus["health"] => {
  if (headway == null) return "minor_issues";
  if (typical == null) return "good";
  if (headway > typical * 2) return "major_issues";
  if (headway - typical > 2) return "minor_issues";
  return "good";
};

const buildSegments = (
  line: MbtaLine,
  predictions: MbtaPrediction[],
  stopsMap: Map<string, MbtaStop>,
  typicalHeadway: number | null,
): SegmentStatus[] => {
  if (predictions.length === 0) return [];

  const directionSequences = new Map<number, Map<number, string>>();

  predictions.forEach((prediction) => {
    const sequence = prediction.attributes.stop_sequence;
    const stopId = extractFirstRelationshipId(prediction.relationships?.stop);
    if (!stopId || sequence == null) return;
    const direction = prediction.attributes.direction_id ?? 0;
    const mapForDirection = directionSequences.get(direction) ?? new Map<number, string>();
    if (!mapForDirection.has(sequence)) {
      mapForDirection.set(sequence, stopId);
    }
    directionSequences.set(direction, mapForDirection);
  });

  const stopHeadways = computeStopHeadways(predictions);
  const segments: SegmentStatus[] = [];

  directionSequences.forEach((sequenceMap, directionId) => {
    const orderedStops = Array.from(sequenceMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1])
      .filter((stopId): stopId is string => Boolean(stopId));

    for (let i = 0; i < orderedStops.length - 1; i += 1) {
      const fromStopId = orderedStops[i]!;
      const toStopId = orderedStops[i + 1]!;
      if (!fromStopId || !toStopId || fromStopId === toStopId) continue;

      const stopKey = `${directionId}-${toStopId}`;
      const headway = stopHeadways.get(stopKey) ?? typicalHeadway ?? null;
      const deviation =
        headway != null && typicalHeadway != null ? headway - typicalHeadway : null;

      segments.push({
        segmentId: `${line.id}-${directionId}-${fromStopId}-${toStopId}`,
        fromStopId,
        toStopId,
        directionId: directionId as 0 | 1 | null,
        headwayMinutes: headway,
        headwayDeviationMinutes: deviation,
        health: determineSegmentHealth(headway, typicalHeadway),
        coordinates: buildCoordinates(fromStopId, toStopId, stopsMap),
      });
    }
  });

  return segments;
};

export const buildLineOverview = (
  cache: MbtaCache,
  lineId: LineId,
): LineOverview | null => {
  const line = getLineById(cache, lineId);
  const routesEntry = cache.getRoutes();
  const vehiclesEntry = cache.getVehicles();
  const alertsEntry = cache.getAlerts();
  const predictionsEntry = cache.getPredictions();
  const stopsEntry = cache.getStops();
  const shapesEntry = cache.getShapes();

  if (!line || !routesEntry || !stopsEntry) {
    return null;
  }

  const routesMap = buildRoutesMap(routesEntry.data);
  const routeIds = getRouteIdsForLine(line);
  const primaryRouteId = routeIds[0] ?? line.id;
  const primaryRoute = routesMap.get(primaryRouteId);
  const stopsMap = buildStopsMap(stopsEntry.data);
  const vehicles = vehiclesEntry?.data ?? [];
  const activeVehicles = vehicles.filter((vehicle) => {
    const routeId = extractFirstRelationshipId(vehicle.relationships?.route);
    return routeId ? routeIds.includes(routeId) : false;
  }).length;

  const predictions = getPredictionsForRoutes(predictionsEntry?.data ?? [], routeIds);
  const typicalHeadwayMinutes = computeHeadwayMinutes(predictions);
  const shapePaths =
    shapesEntry?.data
      ? routeIds.flatMap((routeId) => shapesEntry.data.get(routeId) ?? [])
      : [];

  const overview: LineOverview = {
    lineId: line.id,
    displayName: line.attributes.long_name ?? line.attributes.short_name ?? line.id,
    color: resolveColor(line, routesMap),
    mode: mapRouteTypeToMode(primaryRoute?.attributes.type),
    activeVehicles,
    expectedVehicles: null,
    typicalHeadwayMinutes,
    alerts: filterAlertsForRoutes(alertsEntry?.data ?? [], routeIds),
    segments: buildSegments(line, predictions, stopsMap, typicalHeadwayMinutes),
    shapePaths,
    updatedAt: new Date(
      Math.max(
        cache.getLines()?.fetchedAt ?? 0,
        cache.getVehicles()?.fetchedAt ?? 0,
        cache.getPredictions()?.fetchedAt ?? 0,
      ),
    ).toISOString(),
  };

  return overview;
};
