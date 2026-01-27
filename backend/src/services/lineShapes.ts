// Line geometry builder: prefers cached DB shapes, falls back to MBTA API.
import type { MbtaCache } from "../cache/mbtaCache";
import type { Coordinate } from "../models/domain";
import type { MbtaLine, MbtaRoute } from "../models/mbta";
import type { MbtaClient } from "../mbta/client";
import { logger } from "../utils/logger";
import { chunkArray, ensureArray } from "../utils/collections";
import { normalizeHexColor } from "../utils/colors";
import { getLineRouteIds } from "../utils/mbta";
import polyline from "@mapbox/polyline";
import { getRoutesCached, getLineShapesByRouteCached, getLineShapesByRoutesCached } from "../db";
import { createTimings } from "../utils/timing";

const formatColor = (value: string | null | undefined): string | null =>
  normalizeHexColor(value, { uppercase: true });

export interface LineShapePayload {
  lineId: string;
  color: string | null;
  textColor: string | null;
  shapes: Coordinate[][];
}

const decodePolylineToCoords = (encoded: string | null | undefined): Coordinate[] => {
  if (!encoded) return [];
  return (polyline.decode(encoded) as [number, number][]).map(([lat, lng]) => ({ lat, lng }));
};

const fetchShapesForLine = async (
  client: MbtaClient,
  lineId: string,
): Promise<Coordinate[][]> => {
  const response = await client.getShapes({
    "filter[route]": lineId,
    "page[limit]": 2000,
  });
  return ensureArray(response.data)
    .map((shape) => decodePolylineToCoords(shape.attributes.polyline))
    .filter((coords) => coords.length > 1);
};

const formatLineColor = (line: MbtaLine, routesEntry: MbtaRoute[] | undefined, routeIds: string[]) => {
  const rawColor = line.attributes.color;
  if (rawColor) return formatColor(rawColor);
  if (!routesEntry) return null;
  const route = routeIds.map((id) => routesEntry.find((r) => r.id === id)).find(Boolean);
  return route ? formatColor(route.attributes.color) : null;
};

const formatLineTextColor = (line: MbtaLine, routesEntry: MbtaRoute[] | undefined, routeIds: string[]) => {
  const rawTextColor = line.attributes.text_color;
  if (rawTextColor) return formatColor(rawTextColor);
  if (!routesEntry) return null;
  const route = routeIds.map((id) => routesEntry.find((r) => r.id === id)).find(Boolean);
  return route ? formatColor(route.attributes.text_color) : null;
};

export const buildLineShapes = async (
  cache: MbtaCache,
  client: MbtaClient,
  lineId: string,
): Promise<LineShapePayload | null> => {
  const timing = createTimings();
  const logTiming = (source: string, count: number) => {
    logger.debug("Line shapes timing", {
      lineId,
      source,
      durationMs: timing.totalMs(),
      shapes: count,
    });
  };

  // Special handling for CommuterRail meta-line: fetch all CR-* routes
  if (lineId === "CommuterRail") {
    try {
      const dbRoutes = await getRoutesCached();
      const crRouteIds = dbRoutes.filter((r) => r.id.startsWith("CR-")).map((r) => r.id);

      if (crRouteIds.length > 0) {
        logger.debug("Fetching CommuterRail shapes for routes", { count: crRouteIds.length, routes: crRouteIds });
        const allShapes: Coordinate[][] = [];

        const shapeMap = await getLineShapesByRoutesCached(crRouteIds);
        for (const routeId of crRouteIds) {
          const polylines = shapeMap.get(routeId) ?? [];
          const routeShapes = polylines
            .map((shape) => decodePolylineToCoords(shape))
            .filter((coords) => coords.length > 1);
          allShapes.push(...routeShapes);
        }

        if (allShapes.length > 0) {
          logTiming("db-commuter-rail", allShapes.length);
          return {
            lineId: "CommuterRail",
            color: "#B15CFF", // Purple color for CR
            textColor: "#FFFFFF",
            shapes: allShapes,
          };
        }
      }
      logger.warn("No CommuterRail routes found in database", { lineId });
    } catch (error) {
      logger.error("Failed to fetch CommuterRail shapes", { lineId, message: String(error) });
    }
    const routesEntry = cache.getRoutes();
    const cachedCrRoutes = (routesEntry?.data ?? []).filter((route) => route.id.startsWith("CR-")).map((route) => route.id);
    if (cachedCrRoutes.length === 0) {
      logger.warn("No CommuterRail routes available in cache for fallback", { lineId });
      return null;
    }

    try {
      const allShapes: Coordinate[][] = [];
      const routeChunks = chunkArray(cachedCrRoutes, 10);
      for (const chunk of routeChunks) {
        const response = await client.getShapes({
          "filter[route]": chunk.join(","),
          "page[limit]": 2000,
        });
        const chunkShapes = ensureArray(response.data)
          .map((shape) => decodePolylineToCoords(shape.attributes.polyline))
          .filter((coords) => coords.length > 1);
        allShapes.push(...chunkShapes);
      }
      if (allShapes.length > 0) {
        logTiming("mbta-commuter-rail", allShapes.length);
        return {
          lineId: "CommuterRail",
          color: "#B15CFF",
          textColor: "#FFFFFF",
          shapes: allShapes,
        };
      }
    } catch (error) {
      logger.error("Failed to fetch CommuterRail shapes from MBTA", { lineId, message: String(error) });
    }
    return null;
  }

  try {
    const polylines = await getLineShapesByRouteCached(lineId);
    if (polylines.length > 0) {
      const dbRoutes = await getRoutesCached();
      const route = dbRoutes.find((entry) => entry.id === lineId) ?? null;
      const shapes = polylines
        .map((shape) => decodePolylineToCoords(shape))
        .filter((coords) => coords.length > 1);
      if (shapes.length > 0) {
        logTiming("db", shapes.length);
        return {
          lineId,
          color: formatColor(route?.color ?? null),
          textColor: formatColor(route?.textColor ?? null),
          shapes,
        };
      }
    }
  } catch (error) {
    logger.warn("DB shapes lookup failed, falling back to MBTA", { lineId, message: String(error) });
  }

  const linesEntry = cache.getLines();
  const routesEntry = cache.getRoutes();
  const cachedLine = linesEntry?.data.find((line) => line.id === lineId);
  const routeIdsForLine = cachedLine ? getLineRouteIds(cachedLine, { fallbackToLineId: false }) : [];

  if (cachedLine && routeIdsForLine.length > 0) {
    let shapesEntry = cache.getShapes();
    let shapes = shapesEntry?.data.get(lineId);

    if (shapes && shapes.length > 0) {
      logger.debug("Line shapes cache hit (line)", { lineId, routes: routeIdsForLine.length, count: shapes.length });
      logTiming("cache", shapes.length);
    } else {
      logger.debug("Line shapes cache miss — fetching from MBTA (line)", { lineId, routes: routeIdsForLine.length });
      const fetchedShapes = (
        await Promise.all(routeIdsForLine.map((routeId) => fetchShapesForLine(client, routeId)))
      )
        .flat()
        .filter((coords) => coords.length > 1);

      if (fetchedShapes.length === 0) {
        logger.warn("No shapes returned from MBTA for line routes", { lineId, routes: routeIdsForLine });
        return null;
      }

      const shapeMap = shapesEntry?.data ?? new Map();
      shapeMap.set(lineId, fetchedShapes);
      cache.setShapes(shapeMap);
      shapesEntry = cache.getShapes();
      shapes = fetchedShapes;
      logger.debug("Fetched line shapes (line)", { lineId, fetchedCount: shapes.length });
      logTiming("mbta", shapes.length);
    }

    return {
      lineId,
      color: formatLineColor(cachedLine, routesEntry?.data, routeIdsForLine),
      textColor: formatLineTextColor(cachedLine, routesEntry?.data, routeIdsForLine),
      shapes,
    };
  }

  let shapesEntry = cache.getShapes();
  let shapes = shapesEntry?.data.get(lineId);

  if (shapes && shapes.length > 0) {
    logger.debug("Line shapes cache hit", { lineId, count: shapes.length });
    logTiming("cache", shapes.length);
  } else {
    logger.debug("Line shapes cache miss — fetching from MBTA", { lineId });
    const fetchedShapes = await fetchShapesForLine(client, lineId);
    if (fetchedShapes.length === 0) {
      logger.warn("No shapes returned from MBTA for line", { lineId });
      return null;
    }
    const shapeMap = shapesEntry?.data ?? new Map();
    shapeMap.set(lineId, fetchedShapes);
    cache.setShapes(shapeMap);
    shapesEntry = cache.getShapes();
    shapes = fetchedShapes;
    logger.debug("Fetched line shapes", { lineId, fetchedCount: shapes.length });
    logTiming("mbta", shapes.length);
  }

  const routeMeta: MbtaRoute | undefined = routesEntry?.data.find((route) => route.id === lineId);

  return {
    lineId,
    color: formatColor(routeMeta?.attributes.color),
    textColor: formatColor(routeMeta?.attributes.text_color),
    shapes,
  };
};
