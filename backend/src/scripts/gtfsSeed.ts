import fs from "node:fs";
import dotenv from "dotenv";
import AdmZip from "adm-zip";
import { Pool } from "pg";
import {
  downloadGtfs,
  insertBatch,
  parseCsv,
  readEntry,
} from "./gtfs/helpers";
import {
  buildPatternStops,
  buildRoutePatternRows,
  buildShapeGroups,
  buildShapeRowsToInsert,
  buildTripMaps,
  type RouteRow,
  type ShapeRow,
  type StopRow,
  type StopTimeRow,
  type TripRow,
} from "./gtfs/transform";

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
const gtfsUrl = process.env.GTFS_URL ?? "https://cdn.mbta.com/MBTA_GTFS.zip";

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run the GTFS seed.");
}

const sslRootCertPath = process.env.PGSSLROOTCERT;
const sslServerName = process.env.PGSSL_SERVERNAME;
const sslConfig = sslRootCertPath
  ? {
      ca: fs.readFileSync(sslRootCertPath, "utf-8"),
      rejectUnauthorized: true,
      servername: sslServerName,
    }
  : undefined;

const pool = new Pool({ connectionString: databaseUrl, ssl: sslConfig });

const run = async () => {
  const gtfsBuffer = await downloadGtfs(gtfsUrl);
  const zip = new AdmZip(gtfsBuffer);

  const routes = parseCsv<RouteRow>(readEntry(zip, "routes.txt"));
  const stops = parseCsv<StopRow>(readEntry(zip, "stops.txt"));
  const trips = parseCsv<TripRow>(readEntry(zip, "trips.txt"));
  const stopTimes = parseCsv<StopTimeRow>(readEntry(zip, "stop_times.txt"));
  const shapeRows = parseCsv<ShapeRow>(readEntry(zip, "shapes.txt"));

  const tripMaps = buildTripMaps(trips);
  const { patternStops, stopRoutes } = buildPatternStops(stopTimes, tripMaps);
  const shapeGroups = buildShapeGroups(shapeRows);

  console.log("Parsed GTFS feed. Starting database upserts.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    console.log(`Upserting ${routes.length} routes.`);
    await insertBatch(
      client,
      "routes",
      ["id", "short_name", "long_name", "type", "color", "text_color"],
      routes.map((route) => [
        route.route_id,
        route.route_short_name || null,
        route.route_long_name || null,
        Number(route.route_type),
        route.route_color ? `#${route.route_color}` : null,
        route.route_text_color ? `#${route.route_text_color}` : null,
      ]),
      "ON CONFLICT (id) DO UPDATE SET short_name = EXCLUDED.short_name, long_name = EXCLUDED.long_name, type = EXCLUDED.type, color = EXCLUDED.color, text_color = EXCLUDED.text_color",
    );

    console.log(`Upserting ${stops.length} stops.`);
    await insertBatch(
      client,
      "stops",
      ["id", "name", "lat", "lon", "parent_station_id", "wheelchair_boarding", "location_type"],
      stops.map((stop) => [
        stop.stop_id,
        stop.stop_name,
        Number(stop.stop_lat),
        Number(stop.stop_lon),
        stop.parent_station || null,
        stop.wheelchair_boarding ? Number(stop.wheelchair_boarding) : null,
        stop.location_type ?? stop.stop_location_type
          ? Number(stop.location_type ?? stop.stop_location_type)
          : null,
      ]),
      "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, lat = EXCLUDED.lat, lon = EXCLUDED.lon, parent_station_id = EXCLUDED.parent_station_id, wheelchair_boarding = EXCLUDED.wheelchair_boarding, location_type = EXCLUDED.location_type",
    );

    const { routePatternRows, routePatternStopRows, graphEdgeRows } =
      buildRoutePatternRows(tripMaps, patternStops);

    console.log(`Upserting ${routePatternRows.length} route patterns.`);
    await insertBatch(
      client,
      "route_patterns",
      ["id", "route_id", "direction_id", "name"],
      routePatternRows,
      "ON CONFLICT (id) DO UPDATE SET route_id = EXCLUDED.route_id, direction_id = EXCLUDED.direction_id, name = EXCLUDED.name",
    );

    console.log(`Upserting ${routePatternStopRows.length} route pattern stops.`);
    await insertBatch(
      client,
      "route_pattern_stops",
      ["pattern_id", "stop_id", "stop_sequence"],
      routePatternStopRows,
      "ON CONFLICT (pattern_id, stop_id, stop_sequence) DO NOTHING",
    );

    const shapeRowsToInsert = buildShapeRowsToInsert(shapeGroups, tripMaps.shapeRouteMap);

    console.log(`Upserting ${shapeRowsToInsert.length} shapes.`);
    await insertBatch(
      client,
      "shapes",
      ["id", "route_id", "polyline"],
      shapeRowsToInsert,
      "ON CONFLICT (id) DO UPDATE SET route_id = EXCLUDED.route_id, polyline = EXCLUDED.polyline",
    );

    console.log(`Upserting ${stopRoutes.size} stop-route links.`);
    await insertBatch(
      client,
      "stop_routes",
      ["stop_id", "route_id"],
      Array.from(stopRoutes)
        .map((key) => {
          const [stopId, routeId] = key.split("|");
          if (!stopId || !routeId) return null;
          return [stopId, routeId];
        })
        .filter((row): row is [string, string] => Boolean(row)),
      "ON CONFLICT (stop_id, route_id) DO NOTHING",
    );

    console.log(`Upserting ${graphEdgeRows.length} graph edges.`);
    await insertBatch(
      client,
      "graph_edges",
      ["from_stop_id", "to_stop_id", "route_id", "direction_id", "weight_minutes"],
      graphEdgeRows,
      "ON CONFLICT (from_stop_id, to_stop_id, route_id, direction_id) DO NOTHING",
    );

    await client.query("COMMIT");
    try {
      console.log("Refreshing materialized views...");
      await client.query("REFRESH MATERIALIZED VIEW CONCURRENTLY station_summaries_mv");
      await client.query("REFRESH MATERIALIZED VIEW CONCURRENTLY line_shapes_mv");
      console.log("Materialized views refreshed.");
    } catch (refreshError) {
      console.warn("Materialized view refresh failed", refreshError);
    }
    console.log("GTFS seed completed.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

run()
  .then(async () => {
    await pool.end();
  })
  .catch(async (error) => {
    console.error("GTFS seed failed:", error);
    await pool.end();
    process.exit(1);
  });
