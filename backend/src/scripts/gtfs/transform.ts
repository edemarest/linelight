import polyline from "@mapbox/polyline";

export type RouteRow = {
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_type: string;
  route_color?: string;
  route_text_color?: string;
};

export type StopRow = {
  stop_id: string;
  stop_name: string;
  stop_lat: string;
  stop_lon: string;
  parent_station?: string;
  location_type?: string;
  stop_location_type?: string;
  wheelchair_boarding?: string;
};

export type TripRow = {
  route_id: string;
  service_id: string;
  trip_id: string;
  trip_headsign?: string;
  direction_id?: string;
  shape_id?: string;
};

export type StopTimeRow = {
  trip_id: string;
  stop_id: string;
  stop_sequence: string;
};

export type ShapeRow = {
  shape_id: string;
  shape_pt_lat: string;
  shape_pt_lon: string;
  shape_pt_sequence: string;
};

export type TripMaps = {
  tripRouteMap: Map<string, string>;
  tripDirectionMap: Map<string, number>;
  tripHeadsignMap: Map<string, string>;
  tripShapeMap: Map<string, string | null>;
  patternTripMap: Map<string, string>;
  tripPatternMap: Map<string, string>;
  shapeRouteMap: Map<string, string>;
};

export const buildTripMaps = (trips: TripRow[]): TripMaps => {
  const tripRouteMap = new Map<string, string>();
  const tripDirectionMap = new Map<string, number>();
  const tripHeadsignMap = new Map<string, string>();
  const tripShapeMap = new Map<string, string | null>();
  const patternTripMap = new Map<string, string>();
  const tripPatternMap = new Map<string, string>();
  const shapeRouteMap = new Map<string, string>();

  for (const trip of trips) {
    tripRouteMap.set(trip.trip_id, trip.route_id);
    tripDirectionMap.set(trip.trip_id, Number(trip.direction_id ?? 0));
    tripHeadsignMap.set(trip.trip_id, trip.trip_headsign ?? "");
    tripShapeMap.set(trip.trip_id, trip.shape_id ?? null);
    if (trip.shape_id && !shapeRouteMap.has(trip.shape_id)) {
      shapeRouteMap.set(trip.shape_id, trip.route_id);
    }
    const patternKey = `${trip.route_id}:${trip.direction_id ?? "0"}:${trip.shape_id ?? trip.trip_id}`;
    if (!patternTripMap.has(patternKey)) {
      patternTripMap.set(patternKey, trip.trip_id);
    }
    tripPatternMap.set(trip.trip_id, patternKey);
  }

  return {
    tripRouteMap,
    tripDirectionMap,
    tripHeadsignMap,
    tripShapeMap,
    patternTripMap,
    tripPatternMap,
    shapeRouteMap,
  };
};

export const buildPatternStops = (stopTimes: StopTimeRow[], tripMaps: TripMaps) => {
  const patternStops = new Map<string, Array<{ stopId: string; stopSequence: number }>>();
  const stopRoutes = new Set<string>();

  for (const row of stopTimes) {
    const routeId = tripMaps.tripRouteMap.get(row.trip_id);
    if (routeId) {
      stopRoutes.add(`${row.stop_id}|${routeId}`);
    }
    const patternKey = tripMaps.tripPatternMap.get(row.trip_id);
    if (!patternKey) continue;
    const list = patternStops.get(patternKey) ?? [];
    list.push({ stopId: row.stop_id, stopSequence: Number(row.stop_sequence) });
    patternStops.set(patternKey, list);
  }

  return { patternStops, stopRoutes };
};

export const buildShapeGroups = (shapeRows: ShapeRow[]) => {
  const shapeGroups = new Map<string, Array<{ lat: number; lon: number; seq: number }>>();
  for (const row of shapeRows) {
    const list = shapeGroups.get(row.shape_id) ?? [];
    list.push({
      lat: Number(row.shape_pt_lat),
      lon: Number(row.shape_pt_lon),
      seq: Number(row.shape_pt_sequence),
    });
    shapeGroups.set(row.shape_id, list);
  }
  return shapeGroups;
};

export const buildRoutePatternRows = (
  tripMaps: TripMaps,
  patternStops: Map<string, Array<{ stopId: string; stopSequence: number }>>,
) => {
  const routePatternRows: Array<(string | number | null)[]> = [];
  const routePatternStopRows: Array<(string | number | null)[]> = [];
  const graphEdgeRows: Array<(string | number | null)[]> = [];

  for (const [patternKey, tripId] of tripMaps.patternTripMap.entries()) {
    const [routeId, directionId] = patternKey.split(":", 3);
    if (!routeId || directionId == null) continue;
    const name = tripMaps.tripHeadsignMap.get(tripId) ?? null;
    routePatternRows.push([patternKey, routeId, Number(directionId), name]);

    const stopsForPattern = patternStops.get(patternKey) ?? [];
    stopsForPattern.sort((a, b) => a.stopSequence - b.stopSequence);
    for (const stop of stopsForPattern) {
      routePatternStopRows.push([patternKey, stop.stopId, stop.stopSequence]);
    }

    for (let i = 0; i < stopsForPattern.length - 1; i += 1) {
      const from = stopsForPattern[i]?.stopId;
      const to = stopsForPattern[i + 1]?.stopId;
      if (!from || !to || from === to) continue;
      graphEdgeRows.push([from, to, routeId, Number(directionId), null]);
    }
  }

  return { routePatternRows, routePatternStopRows, graphEdgeRows };
};

export const buildShapeRowsToInsert = (
  shapeGroups: Map<string, Array<{ lat: number; lon: number; seq: number }>>,
  shapeRouteMap: Map<string, string>,
) => {
  const shapeRowsToInsert: Array<(string | number | null)[]> = [];
  for (const [shapeId, points] of shapeGroups.entries()) {
    points.sort((a, b) => a.seq - b.seq);
    const coords = points.map((point) => [point.lat, point.lon]) as [number, number][];
    const encoded = coords.length > 0 ? polyline.encode(coords) : null;
    const routeId = shapeRouteMap.get(shapeId) ?? null;
    if (!routeId) continue;
    shapeRowsToInsert.push([shapeId, routeId, encoded]);
  }
  return shapeRowsToInsert;
};
