import { createMbtaClient } from "../../mbta/client";
import type { MbtaStop } from "../../models/mbta";
import { ensureArray } from "../../utils/collections";

export interface DiagnosticsArgs {
  stopIds: string[];
  routeIds: string[];
  boundingBox?: { north: number; south: number; east: number; west: number };
  limit?: number;
  windowMinutes?: number;
}

export const DEFAULT_STOP_IDS = ["place-davis", "place-harsq"];
export const DEFAULT_BBOX_LIMIT = 10;

export const parseArgs = (argv: string[]): DiagnosticsArgs => {
  const args: DiagnosticsArgs = {
    stopIds: [],
    routeIds: [],
  };

  argv.forEach((arg) => {
    if (!arg.startsWith("--")) {
      args.stopIds.push(arg);
      return;
    }

    const [key, rawValue] = arg.slice(2).split("=");
    const value = rawValue ?? "";
    switch (key) {
      case "stops":
        args.stopIds.push(
          ...value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        );
        break;
      case "routes":
        args.routeIds.push(
          ...value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        );
        break;
      case "bbox": {
        const parts = value.split(",").map((entry) => Number(entry.trim()));
        const [north, south, east, west] = parts;
        if (
          parts.length === 4 &&
          Number.isFinite(north) &&
          Number.isFinite(south) &&
          Number.isFinite(east) &&
          Number.isFinite(west)
        ) {
          args.boundingBox = {
            north: north!,
            south: south!,
            east: east!,
            west: west!,
          };
        }
        break;
      }
      case "limit": {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) {
          args.limit = parsed;
        }
        break;
      }
      case "window": {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) {
          args.windowMinutes = parsed;
        }
        break;
      }
      default:
        break;
    }
  });

  return args;
};

const isBoardableStop = (stop: MbtaStop): boolean => {
  const locationType = stop.attributes.location_type ?? 0;
  return locationType === 0 || locationType === 1 || locationType === 4;
};

export const selectStopsInBoundingBox = (
  stops: MbtaStop[],
  bbox: DiagnosticsArgs["boundingBox"],
  limit: number,
): string[] => {
  if (!bbox) return [];
  return stops
    .filter(
      (stop) =>
        isBoardableStop(stop) &&
        stop.attributes.latitude <= bbox.north &&
        stop.attributes.latitude >= bbox.south &&
        stop.attributes.longitude >= bbox.west &&
        stop.attributes.longitude <= bbox.east,
    )
    .slice(0, limit)
    .map((stop) => stop.id);
};

export const fetchRouteStops = async (routeIds: string[], client = createMbtaClient()): Promise<string[]> => {
  if (routeIds.length === 0) return [];
  const results = await Promise.all(
    routeIds.map((routeId) =>
      client
        .getStops({
          "filter[route]": routeId,
          "page[limit]": 500,
        })
        .then((response) => ensureArray(response.data).map((stop) => stop.id)),
    ),
  );
  return Array.from(new Set(results.flat()));
};
