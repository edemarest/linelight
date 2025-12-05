import type { MbtaClient } from "../mbta/client";
import type { MbtaCache } from "../cache/mbtaCache";
import type { TripTrackResponse, TripUpcomingStop, TripVehicle, LatLng } from "@linelight/core";
import type { MbtaPrediction, MbtaStop, MbtaVehicle } from "../models/mbta";
import { extractFirstRelationshipId } from "../utils/jsonApi";

const ensureArray = <T>(value: T | T[] | undefined | null): T[] => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const toLatLng = (vehicle: MbtaVehicle): LatLng | undefined => {
  if (vehicle.attributes.latitude == null || vehicle.attributes.longitude == null) return undefined;
  return { lat: vehicle.attributes.latitude, lng: vehicle.attributes.longitude };
};

const computeEtaMinutes = (timestamp: string | null): number | null => {
  if (!timestamp) return null;
  const target = Date.parse(timestamp);
  if (!Number.isFinite(target)) return null;
  return Math.max(0, Math.round((target - Date.now()) / 60000));
};

const mapUpcomingStops = (
  predictions: MbtaPrediction[],
  stopLookup: Map<string, MbtaStop>,
): TripUpcomingStop[] => {
  const sorted = [...predictions].sort(
    (a, b) => (a.attributes.stop_sequence ?? Infinity) - (b.attributes.stop_sequence ?? Infinity),
  );
  return sorted.map((prediction) => {
    const stopId = extractFirstRelationshipId(prediction.relationships?.stop);
    const stop = stopId ? stopLookup.get(stopId) : undefined;
    return {
      stopId: stopId ?? prediction.id,
      stopName: stop?.attributes.name ?? "Upcoming stop",
      etaMinutes: computeEtaMinutes(prediction.attributes.departure_time ?? prediction.attributes.arrival_time),
      source: prediction.attributes.departure_time || prediction.attributes.arrival_time ? "prediction" : "unknown",
    };
  });
};

export const buildTripTrack = async (
  client: MbtaClient,
  cache: MbtaCache,
  tripId: string,
): Promise<TripTrackResponse | null> => {
  const predictionResponse = await client.getPredictions({
    "filter[trip]": tripId,
    include: "stop,route",
    "page[limit]": 50,
  });
  const predictions = ensureArray(predictionResponse.data);
  if (predictions.length === 0) {
    return null;
  }

  const stopLookup = new Map<string, MbtaStop>();
  const stopsEntry = cache.getStops();
  (stopsEntry?.data ?? []).forEach((stop) => stopLookup.set(stop.id, stop));
  ensureArray(predictionResponse.included).forEach((resource) => {
    if (resource.type === "stop") {
      const stopResource = resource as unknown as MbtaStop;
      stopLookup.set(stopResource.id, stopResource);
    }
  });

  const primaryPrediction = predictions[0]!;
  const routeId = extractFirstRelationshipId(primaryPrediction.relationships?.route);

  const vehicleResponse = await client.getVehicles({
    "filter[trip]": tripId,
  });
  const vehicle = ensureArray(vehicleResponse.data)[0];

  let vehiclePayload: TripVehicle | undefined;
  if (vehicle) {
    const position = toLatLng(vehicle);
    if (position) {
      const payload: TripVehicle = {
        id: vehicle.id,
        position,
        lastUpdated: vehicle.attributes.updated_at,
      };
      if (vehicle.attributes.bearing != null) {
        payload.bearing = vehicle.attributes.bearing;
      }
      vehiclePayload = payload;
    }
  }

  const response: TripTrackResponse = {
    tripId,
    routeId: routeId ?? "unknown",
    destination: primaryPrediction.attributes.direction_id === 0 ? "Inbound trip" : "Outbound trip",
    upcomingStops: mapUpcomingStops(predictions, stopLookup),
  };
  if (vehiclePayload) {
    response.vehicle = vehiclePayload;
  }
  return response;
};
