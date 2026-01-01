import type { MbtaCache } from "../cache/mbtaCache";
import type { Coordinate } from "../models/domain";
import type { MbtaLine, MbtaRoute } from "../models/mbta";
import type { MbtaClient } from "../mbta/client";
import { extractRelationshipIds } from "../utils/jsonApi";
import { logger } from "../utils/logger";
import polyline from "@mapbox/polyline";

const formatColor = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const normalized = value.startsWith("#") ? value : `#${value}`;
  return normalized.toUpperCase();
};

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

const getLineRouteIds = (line: MbtaLine): string[] => {
  const routeIds = extractRelationshipIds(line.relationships?.routes);
  return routeIds.length > 0 ? routeIds : [];
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

const ensureArray = <T>(value: T | T[] | undefined | null): T[] => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

export const buildLineShapes = async (
  cache: MbtaCache,
  client: MbtaClient,
  lineId: string,
): Promise<LineShapePayload | null> => {
  const linesEntry = cache.getLines();
  const routesEntry = cache.getRoutes();
  const cachedLine = linesEntry?.data.find((line) => line.id === lineId);
  const routeIdsForLine = cachedLine ? getLineRouteIds(cachedLine) : [];

  if (cachedLine && routeIdsForLine.length > 0) {
    let shapesEntry = cache.getShapes();
    let shapes = shapesEntry?.data.get(lineId);

    if (shapes && shapes.length > 0) {
      logger.info("Line shapes cache hit (line)", { lineId, routes: routeIdsForLine.length, count: shapes.length });
    } else {
      logger.info("Line shapes cache miss — fetching from MBTA (line)", { lineId, routes: routeIdsForLine.length });
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
      logger.info("Fetched line shapes (line)", { lineId, fetchedCount: shapes.length });
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
    logger.info("Line shapes cache hit", { lineId, count: shapes.length });
  } else {
    logger.info("Line shapes cache miss — fetching from MBTA", { lineId });
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
    logger.info("Fetched line shapes", { lineId, fetchedCount: shapes.length });
  }

  const routeMeta: MbtaRoute | undefined = routesEntry?.data.find((route) => route.id === lineId);

  return {
    lineId,
    color: formatColor(routeMeta?.attributes.color),
    textColor: formatColor(routeMeta?.attributes.text_color),
    shapes,
  };
};
