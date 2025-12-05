import type { MbtaCache } from "../cache/mbtaCache";
import type { VehicleSnapshot, Mode } from "../models/domain";
import type { MbtaLine, MbtaRoute } from "../models/mbta";
import { extractFirstRelationshipId, extractRelationshipIds } from "../utils/jsonApi";
import { mapRouteTypeToMode } from "../utils/routeMode";

interface VehicleOptions {
  mode?: Mode | undefined;
}

const buildRouteLookup = (routes: MbtaRoute[], lines: MbtaLine[]) => {
  const routeMap = new Map<string, { lineId: string | null; mode: Mode }>();
  const routeIdToLineId = new Map<string, string>();

  lines.forEach((line) => {
    const routeIds = extractRelationshipIds(line.relationships?.routes);
    routeIds.forEach((routeId) => {
      routeIdToLineId.set(routeId, line.id);
    });
  });

  routes.forEach((route) => {
    const lineId = routeIdToLineId.get(route.id) ?? null;
    routeMap.set(route.id, {
      lineId,
      mode: mapRouteTypeToMode(route.attributes.type),
    });
  });

  return routeMap;
};

export const buildVehicleSnapshots = (
  cache: MbtaCache,
  options: VehicleOptions = {},
): { vehicles: VehicleSnapshot[]; generatedAt: string } => {
  const vehiclesEntry = cache.getVehicles();
  const routesEntry = cache.getRoutes();
  const linesEntry = cache.getLines();

  const generatedAt = new Date().toISOString();

  if (!vehiclesEntry || !routesEntry || !linesEntry) {
    return { vehicles: [], generatedAt };
  }

  const routeLookup = buildRouteLookup(routesEntry.data, linesEntry.data);

  const vehicles = vehiclesEntry.data
    .map<VehicleSnapshot>((vehicle) => {
      const routeId = extractFirstRelationshipId(vehicle.relationships?.route);
      const lookup = routeId ? routeLookup.get(routeId) : null;
      return {
        vehicleId: vehicle.id,
        routeId,
        lineId: lookup?.lineId ?? null,
        mode: lookup?.mode ?? "other",
        latitude: vehicle.attributes.latitude,
        longitude: vehicle.attributes.longitude,
        bearing: vehicle.attributes.bearing,
        updatedAt: vehicle.attributes.updated_at,
      };
    })
    .filter((vehicle) => vehicle.latitude != null && vehicle.longitude != null)
    .filter((vehicle) => {
      if (!options.mode) return true;
      return vehicle.mode === options.mode;
    });

  return { vehicles, generatedAt };
};
