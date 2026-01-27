// Trip tracking payload builder: current vehicle position + upcoming stops.
import type { MbtaClient } from "../mbta/client";
import type { MbtaCache } from "../cache/mbtaCache";
import type { TripTrackResponse, TripUpcomingStop, TripVehicle, LatLng } from "@linelight/core";
import type { MbtaPrediction, MbtaStop, MbtaVehicle } from "../models/mbta";
import { extractFirstRelationshipId } from "../utils/jsonApi";
import { ensureArray } from "../utils/collections";
import { computeEtaMinutes } from "../utils/time";

const toLatLng = (vehicle: MbtaVehicle): LatLng | undefined => {
  if (vehicle.attributes.latitude == null || vehicle.attributes.longitude == null) return undefined;
  return { lat: vehicle.attributes.latitude, lng: vehicle.attributes.longitude };
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

  const fallbackVehicleId = predictions
    .map((prediction) => extractFirstRelationshipId(prediction.relationships?.vehicle))
    .find((id): id is string => Boolean(id));

  const vehicleResponse = await client.getVehicles({
    "filter[trip]": tripId,
  });
  let vehicle = ensureArray(vehicleResponse.data)[0];
  if (!vehicle && fallbackVehicleId) {
    const fallbackResponse = await client.getVehicles({
      "filter[id]": fallbackVehicleId,
    });
    vehicle = ensureArray(fallbackResponse.data)[0];
  }

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
