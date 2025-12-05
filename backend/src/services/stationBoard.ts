import type { MbtaCache } from "../cache/mbtaCache";
import type {
  StationBoard,
  LineAlertSummary,
  LineDepartures,
  DeparturePrediction,
} from "../models/domain";
import type { MbtaPrediction, MbtaTrip, MbtaVehicle } from "../models/mbta";
import { extractFirstRelationshipId, extractRelationshipIds } from "../utils/jsonApi";

const directionLabel = (directionId: number | null | undefined) => {
  if (directionId === 1) return "Outbound";
  if (directionId === 0) return "Inbound";
  return "Unknown";
};

const toTimestamp = (value: string | null) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const computeCountdownSeconds = (timestamp: string | null) => {
  const parsed = toTimestamp(timestamp);
  if (!parsed) return null;
  return Math.max(0, Math.round((parsed - Date.now()) / 1000));
};

const deriveReliability = (prediction: MbtaPrediction, countdownSeconds: number | null) => {
  const status = prediction.attributes.status?.toLowerCase() ?? "";
  if (status.includes("delay")) return "delayed";
  if (status.includes("gap")) return "gap";
  if (countdownSeconds != null && countdownSeconds > 600) return "gap";
  if (countdownSeconds != null) return "normal";
  return "unknown";
};

const mapPredictionToDeparture = (
  prediction: MbtaPrediction,
  tripsMap: Map<string, MbtaTrip>,
  vehiclesById: Map<string, MbtaVehicle>,
  vehiclesByTrip: Map<string, MbtaVehicle>,
): DeparturePrediction => {
  const tripId = extractFirstRelationshipId(prediction.relationships?.trip);
  const vehicleId = extractFirstRelationshipId(prediction.relationships?.vehicle);
  const predictedTime = prediction.attributes.arrival_time ?? prediction.attributes.departure_time;
  const countdownSeconds = computeCountdownSeconds(predictedTime);
  const trip = tripId ? tripsMap.get(tripId) : null;
  const vehicle =
    (vehicleId ? vehiclesById.get(vehicleId) : undefined) ||
    (tripId ? vehiclesByTrip.get(tripId) : undefined) ||
    null;

  return {
    tripId,
    routeId: extractFirstRelationshipId(prediction.relationships?.route),
    vehicleId: vehicleId ?? vehicle?.id ?? null,
    destination: trip?.attributes.headsign ?? prediction.attributes.status,
    scheduledTime: prediction.attributes.departure_time,
    predictedTime,
    countdownSeconds,
    crowdingLevel: "unknown",
    reliabilityFlag: deriveReliability(prediction, countdownSeconds),
    vehicleStatus: vehicle?.attributes.current_status ?? null,
  };
};

type DirectionId = 0 | 1 | null;

interface DepartureWithDirection {
  departure: DeparturePrediction;
  directionId: DirectionId;
}

const groupByRouteAndDirection = (
  departures: DepartureWithDirection[],
): LineDepartures[] => {
  const groups = new Map<string, LineDepartures>();

  departures.forEach(({ departure, directionId }) => {
    const key = `${departure.routeId ?? "unknown"}-${directionId ?? "na"}`;
    const existing: LineDepartures =
      groups.get(key) ?? {
        lineId: departure.routeId,
        directionId,
        directionLabel: directionLabel(directionId),
        departures: [],
      };
    existing.departures = [...existing.departures, departure];
    groups.set(key, existing);
  });

  return Array.from(groups.values()).map((group) => ({
    ...group,
    departures: group.departures
      .sort((a, b) => (toTimestamp(a.predictedTime) ?? Infinity) - (toTimestamp(b.predictedTime) ?? Infinity))
      .slice(0, 5),
  }));
};

const filterAlertsForStop = (cache: MbtaCache, stopId: string): LineAlertSummary[] => {
  const alerts = cache.getAlerts()?.data ?? [];
  return alerts
    .filter((alert) => extractRelationshipIds(alert.relationships?.stops).includes(stopId))
    .map((alert) => ({
      alertId: alert.id,
      header: alert.attributes.header_text ?? "Service alert",
      severity: alert.attributes.severity,
      effect: alert.attributes.effect,
      lifecycle: alert.attributes.lifecycle,
    }));
};

export const buildStationBoard = (cache: MbtaCache, stopId: string): StationBoard | null => {
  const stopsEntry = cache.getStops();
  const predictionsEntry = cache.getPredictions();
  const tripsEntry = cache.getTrips();
  const vehiclesEntry = cache.getVehicles();

  if (!stopsEntry || !predictionsEntry) {
    return null;
  }

  const stop = stopsEntry.data.find((candidate) => candidate.id === stopId);
  if (!stop) {
    return null;
  }

  const tripsMap = new Map<string, MbtaTrip>(
    (tripsEntry?.data ?? []).map((trip) => [trip.id, trip]),
  );
  const vehicles = vehiclesEntry?.data ?? [];
  const vehiclesById = new Map<string, MbtaVehicle>(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const vehiclesByTrip = new Map<string, MbtaVehicle>();
  vehicles.forEach((vehicle) => {
    const tripId = extractFirstRelationshipId(vehicle.relationships?.trip);
    if (tripId) {
      vehiclesByTrip.set(tripId, vehicle);
    }
  });

  const predictionsForStop = predictionsEntry.data.filter((prediction) => {
    const predictionStopId = extractFirstRelationshipId(prediction.relationships?.stop);
    return predictionStopId === stopId;
  });

  const departures = predictionsForStop.map((prediction) => ({
    departure: mapPredictionToDeparture(prediction, tripsMap, vehiclesById, vehiclesByTrip),
    directionId: (prediction.attributes.direction_id ?? null) as DirectionId,
  }));
  const board: StationBoard = {
    stopId,
    name: stop.attributes.name,
    linesServed: Array.from(
      new Set(
        departures
          .map(({ departure }) => departure.routeId)
          .filter((routeId): routeId is string => Boolean(routeId)),
      ),
    ),
    departuresByLine: groupByRouteAndDirection(departures),
    alerts: filterAlertsForStop(cache, stopId),
    updatedAt: new Date(predictionsEntry.fetchedAt).toISOString(),
  };

  return board;
};
