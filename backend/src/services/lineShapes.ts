import type { MbtaCache } from "../cache/mbtaCache";
import type { Coordinate } from "../models/domain";
import type { MbtaRoute } from "../models/mbta";
import type { MbtaClient } from "../mbta/client";
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

const ensureArray = <T>(value: T | T[] | undefined | null): T[] => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

export const buildLineShapes = async (
  cache: MbtaCache,
  client: MbtaClient,
  lineId: string,
): Promise<LineShapePayload | null> => {
  let shapesEntry = cache.getShapes();
  let shapes = shapesEntry?.data.get(lineId);

  if (!shapes || shapes.length === 0) {
    const fetchedShapes = await fetchShapesForLine(client, lineId);
    if (fetchedShapes.length === 0) {
      return null;
    }
    const shapeMap = shapesEntry?.data ?? new Map();
    shapeMap.set(lineId, fetchedShapes);
    cache.setShapes(shapeMap);
    shapesEntry = cache.getShapes();
    shapes = fetchedShapes;
  }

  const routesEntry = cache.getRoutes();
  const routeMeta: MbtaRoute | undefined = routesEntry?.data.find((route) => route.id === lineId);

  return {
    lineId,
    color: formatColor(routeMeta?.attributes.color),
    textColor: formatColor(routeMeta?.attributes.text_color),
    shapes,
  };
};
