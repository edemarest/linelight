import { Pool } from "pg";
import { buildPgSslConfig } from "../utils/dbSsl";

export interface DbRoute {
  id: string;
  shortName: string | null;
  longName: string | null;
  type: number;
  color: string | null;
  textColor: string | null;
}

export interface DbStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  parentStationId: string | null;
  wheelchairBoarding: number | null;
  locationType: number | null;
}

export interface DbGraphEdge {
  fromStopId: string;
  toStopId: string;
  routeId: string;
  directionId: number;
  weightMinutes: number | null;
}

export interface DbShape {
  id: string;
  routeId: string;
  polyline: string | null;
}

export interface DbStationSummary {
  stationId: string;
  name: string;
  lat: number;
  lon: number;
  platformStopIds: string[];
  routesServing: string[];
  modesServed: string[];
}

export interface DbDonation {
  sessionId: string;
  paymentIntentId: string | null;
  status: string;
  amountCents: number;
  currency: string;
  donorName: string | null;
  donorEmail: string | null;
  livemode: boolean;
  metadata: Record<string, unknown> | null;
}

export interface DbDonationBoardEntry {
  amountCents: number;
  currency: string;
  donorName: string | null;
  createdAt: string;
}

export interface DbDonationBoardSummary {
  supporterCount: number;
  totalAmountCents: number;
}

let pool: Pool | null = null;
const CACHE_TTL_MS = 5 * 60_000;
const GRAPH_EDGES_BY_ROUTE_CACHE_MAX = 2;
const GTFS_SNAPSHOT_TTL_MS = Number(process.env.GTFS_SNAPSHOT_TTL_MS ?? String(6 * 60 * 60 * 1000));
type GtfsSnapshot = {
  routes: DbRoute[];
  stops: DbStop[];
  stopRoutes: Map<string, Set<string>>;
  graphEdges: DbGraphEdge[];
};
const cache = {
  routes: { fetchedAt: 0, data: [] as DbRoute[] },
  stops: { fetchedAt: 0, data: [] as DbStop[] },
  stopRoutes: { fetchedAt: 0, data: new Map<string, Set<string>>() },
  graphEdges: { fetchedAt: 0, data: [] as DbGraphEdge[] },
  gtfsSnapshot: { fetchedAt: 0, data: null as GtfsSnapshot | null },
  stationSummaries: { fetchedAt: 0, data: [] as DbStationSummary[] },
  lineShapesByRoute: new Map<string, { fetchedAt: number; data: string[] }>(),
  graphEdgesByRouteKey: new Map<string, { fetchedAt: number; data: DbGraphEdge[] }>(),
  shapesByRoute: new Map<string, { fetchedAt: number; data: DbShape[] }>(),
};

const getLruEntry = <T>(map: Map<string, T>, key: string) => {
  const value = map.get(key);
  if (!value) return null;
  map.delete(key);
  map.set(key, value);
  return value;
};

const setLruEntry = <T>(map: Map<string, T>, key: string, value: T, max: number) => {
  map.set(key, value);
  while (map.size > max) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
};

const getPool = () => {
  if (pool) return pool;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for database access.");
  }

  const sslConfig = buildPgSslConfig(databaseUrl);
  const max = Number(process.env.PG_POOL_MAX ?? "");
  const idleTimeoutMillis = Number(process.env.PG_POOL_IDLE_MS ?? "");
  const connectionTimeoutMillis = Number(process.env.PG_POOL_CONN_MS ?? "");
  const maxUses = Number(process.env.PG_POOL_MAX_USES ?? "");

  pool = new Pool({
    connectionString: databaseUrl,
    ssl: sslConfig,
    ...(Number.isFinite(max) ? { max } : {}),
    ...(Number.isFinite(idleTimeoutMillis) ? { idleTimeoutMillis } : {}),
    ...(Number.isFinite(connectionTimeoutMillis) ? { connectionTimeoutMillis } : {}),
    ...(Number.isFinite(maxUses) ? { maxUses } : {}),
  });
  return pool;
};

export const closeDb = async () => {
  if (!pool) return;
  await pool.end();
  pool = null;
};

export const getRoutes = async (): Promise<DbRoute[]> => {
  const client = getPool();
  const result = await client.query(
    `SELECT id, short_name, long_name, type, color, text_color FROM routes`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    shortName: row.short_name ?? null,
    longName: row.long_name ?? null,
    type: Number(row.type),
    color: row.color ?? null,
    textColor: row.text_color ?? null,
  }));
};

export const getRoutesCached = async (): Promise<DbRoute[]> => {
  const snapshot = await getGtfsSnapshot();
  return snapshot.routes;
};

export const getRoutesCachedLight = async (): Promise<DbRoute[]> => {
  if (Date.now() - cache.routes.fetchedAt < CACHE_TTL_MS && cache.routes.data.length > 0) {
    return cache.routes.data;
  }
  const routes = await getRoutes();
  cache.routes = { fetchedAt: Date.now(), data: routes };
  return routes;
};

export const getStops = async (): Promise<DbStop[]> => {
  const client = getPool();
  const result = await client.query(
    `SELECT id, name, lat, lon, parent_station_id, wheelchair_boarding, location_type FROM stops`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    lat: Number(row.lat),
    lon: Number(row.lon),
    parentStationId: row.parent_station_id ?? null,
    wheelchairBoarding: row.wheelchair_boarding ?? null,
    locationType: row.location_type ?? null,
  }));
};

export const getStopsCached = async (): Promise<DbStop[]> => {
  const snapshot = await getGtfsSnapshot();
  return snapshot.stops;
};

export const getStopsCachedLight = async (): Promise<DbStop[]> => {
  if (Date.now() - cache.stops.fetchedAt < CACHE_TTL_MS && cache.stops.data.length > 0) {
    return cache.stops.data;
  }
  const stops = await getStops();
  cache.stops = { fetchedAt: Date.now(), data: stops };
  return stops;
};

export const getStopRoutes = async (): Promise<Map<string, Set<string>>> => {
  const client = getPool();
  const result = await client.query(`SELECT stop_id, route_id FROM stop_routes`);
  const map = new Map<string, Set<string>>();
  result.rows.forEach((row) => {
    const entry = map.get(row.stop_id) ?? new Set<string>();
    entry.add(row.route_id);
    map.set(row.stop_id, entry);
  });
  return map;
};

export const getStopRoutesCached = async (): Promise<Map<string, Set<string>>> => {
  const snapshot = await getGtfsSnapshot();
  return snapshot.stopRoutes;
};

export const getStopRoutesCachedLight = async (): Promise<Map<string, Set<string>>> => {
  if (Date.now() - cache.stopRoutes.fetchedAt < CACHE_TTL_MS && cache.stopRoutes.data.size > 0) {
    return cache.stopRoutes.data;
  }
  const stopRoutes = await getStopRoutes();
  cache.stopRoutes = { fetchedAt: Date.now(), data: stopRoutes };
  return stopRoutes;
};

export const getGraphEdges = async (): Promise<DbGraphEdge[]> => {
  const client = getPool();
  const result = await client.query(
    `SELECT from_stop_id, to_stop_id, route_id, direction_id, weight_minutes FROM graph_edges`,
  );
  return result.rows.map((row) => ({
    fromStopId: row.from_stop_id,
    toStopId: row.to_stop_id,
    routeId: row.route_id,
    directionId: Number(row.direction_id),
    weightMinutes: row.weight_minutes ?? null,
  }));
};

export const getGraphEdgesByRoutes = async (routeIds: string[]): Promise<DbGraphEdge[]> => {
  if (routeIds.length === 0) return [];
  const client = getPool();
  const result = await client.query(
    `SELECT from_stop_id, to_stop_id, route_id, direction_id, weight_minutes
     FROM graph_edges
     WHERE route_id = ANY($1::text[])`,
    [routeIds],
  );
  return result.rows.map((row) => ({
    fromStopId: row.from_stop_id,
    toStopId: row.to_stop_id,
    routeId: row.route_id,
    directionId: Number(row.direction_id),
    weightMinutes: row.weight_minutes ?? null,
  }));
};

export const getGraphEdgesCached = async (): Promise<DbGraphEdge[]> => {
  const snapshot = await getGtfsSnapshot();
  return snapshot.graphEdges;
};

export const getGraphEdgesByRoutesCached = async (routeIds: string[]): Promise<DbGraphEdge[]> => {
  if (routeIds.length === 0) return [];
  const key = routeIds.slice().sort().join("|");
  const cached = getLruEntry(cache.graphEdgesByRouteKey, key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  const edges = await getGraphEdgesByRoutes(routeIds);
  setLruEntry(cache.graphEdgesByRouteKey, key, { fetchedAt: Date.now(), data: edges }, GRAPH_EDGES_BY_ROUTE_CACHE_MAX);
  return edges;
};

export const getShapesByRoute = async (routeId: string): Promise<DbShape[]> => {
  const client = getPool();
  const result = await client.query(
    `SELECT id, route_id, polyline FROM shapes WHERE route_id = $1`,
    [routeId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    routeId: row.route_id,
    polyline: row.polyline ?? null,
  }));
};

export const getShapesByRouteCached = async (routeId: string): Promise<DbShape[]> => {
  const cached = cache.shapesByRoute.get(routeId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  const shapes = await getShapesByRoute(routeId);
  cache.shapesByRoute.set(routeId, { fetchedAt: Date.now(), data: shapes });
  return shapes;
};

export const getStationSummaries = async (): Promise<DbStationSummary[]> => {
  const client = getPool();
  const result = await client.query(
    `SELECT station_id, name, lat, lon, platform_stop_ids, routes_serving, modes_served
     FROM station_summaries_mv`,
  );
  return result.rows.map((row) => ({
    stationId: row.station_id,
    name: row.name,
    lat: Number(row.lat),
    lon: Number(row.lon),
    platformStopIds: row.platform_stop_ids ?? [],
    routesServing: row.routes_serving ?? [],
    modesServed: row.modes_served ?? [],
  }));
};

export const getStationSummariesCached = async (): Promise<DbStationSummary[]> => {
  if (Date.now() - cache.stationSummaries.fetchedAt < GTFS_SNAPSHOT_TTL_MS && cache.stationSummaries.data.length > 0) {
    return cache.stationSummaries.data;
  }
  const summaries = await getStationSummaries();
  cache.stationSummaries = { fetchedAt: Date.now(), data: summaries };
  return summaries;
};

export const upsertDonation = async (donation: DbDonation): Promise<void> => {
  const client = getPool();
  await client.query(
    `INSERT INTO donations (
      session_id,
      payment_intent_id,
      status,
      amount_cents,
      currency,
      donor_name,
      donor_email,
      livemode,
      metadata,
      updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW()
    )
    ON CONFLICT (session_id) DO UPDATE SET
      payment_intent_id = EXCLUDED.payment_intent_id,
      status = EXCLUDED.status,
      amount_cents = EXCLUDED.amount_cents,
      currency = EXCLUDED.currency,
      donor_name = EXCLUDED.donor_name,
      donor_email = EXCLUDED.donor_email,
      livemode = EXCLUDED.livemode,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()`,
    [
      donation.sessionId,
      donation.paymentIntentId,
      donation.status,
      donation.amountCents,
      donation.currency,
      donation.donorName,
      donation.donorEmail,
      donation.livemode,
      donation.metadata,
    ],
  );
};

const DONATION_BOARD_STATUSES = ["complete", "paid"];

const buildDonationBoardFilter = (onlyLive?: boolean) =>
  `lower(status) = ANY($1::text[])${onlyLive ? " AND livemode = true" : ""}`;

export const getDonationBoardTop = async (
  limit: number,
  onlyLive?: boolean,
): Promise<DbDonationBoardEntry[]> => {
  const client = getPool();
  const result = await client.query(
    `SELECT amount_cents, currency, donor_name, created_at
     FROM donations
     WHERE ${buildDonationBoardFilter(onlyLive)}
     ORDER BY amount_cents DESC, created_at DESC
     LIMIT $2`,
    [DONATION_BOARD_STATUSES, limit],
  );
  return result.rows.map((row) => ({
    amountCents: Number(row.amount_cents),
    currency: row.currency ?? "usd",
    donorName: row.donor_name ?? null,
    createdAt: row.created_at,
  }));
};

export const getDonationBoardRecent = async (
  limit: number,
  onlyLive?: boolean,
): Promise<DbDonationBoardEntry[]> => {
  const client = getPool();
  const result = await client.query(
    `SELECT amount_cents, currency, donor_name, created_at
     FROM donations
     WHERE ${buildDonationBoardFilter(onlyLive)}
     ORDER BY created_at DESC
     LIMIT $2`,
    [DONATION_BOARD_STATUSES, limit],
  );
  return result.rows.map((row) => ({
    amountCents: Number(row.amount_cents),
    currency: row.currency ?? "usd",
    donorName: row.donor_name ?? null,
    createdAt: row.created_at,
  }));
};

export const getDonationBoardSummary = async (
  onlyLive?: boolean,
): Promise<DbDonationBoardSummary> => {
  const client = getPool();
  const result = await client.query(
    `SELECT COUNT(*)::int AS supporter_count,
            COALESCE(SUM(amount_cents), 0)::int AS total_amount_cents
     FROM donations
     WHERE ${buildDonationBoardFilter(onlyLive)}`,
    [DONATION_BOARD_STATUSES],
  );
  const row = result.rows[0] ?? { supporter_count: 0, total_amount_cents: 0 };
  return {
    supporterCount: Number(row.supporter_count ?? 0),
    totalAmountCents: Number(row.total_amount_cents ?? 0),
  };
};

export const getLineShapesByRoute = async (routeId: string): Promise<string[]> => {
  const client = getPool();
  const result = await client.query(
    `SELECT polylines FROM line_shapes_mv WHERE route_id = $1`,
    [routeId],
  );
  const polylines = result.rows[0]?.polylines;
  return Array.isArray(polylines) ? polylines.filter((entry): entry is string => Boolean(entry)) : [];
};

export const getLineShapesByRouteCached = async (routeId: string): Promise<string[]> => {
  const cached = cache.lineShapesByRoute.get(routeId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  const polylines = await getLineShapesByRoute(routeId);
  cache.lineShapesByRoute.set(routeId, { fetchedAt: Date.now(), data: polylines });
  return polylines;
};

export const getLineShapesByRoutes = async (routeIds: string[]): Promise<Map<string, string[]>> => {
  if (routeIds.length === 0) return new Map();
  const client = getPool();
  const result = await client.query(
    `SELECT route_id, polylines FROM line_shapes_mv WHERE route_id = ANY($1::text[])`,
    [routeIds],
  );
  const map = new Map<string, string[]>();
  result.rows.forEach((row) => {
    const polylines = Array.isArray(row.polylines) ? row.polylines.filter((entry: string) => Boolean(entry)) : [];
    map.set(row.route_id, polylines);
  });
  return map;
};

export const getLineShapesByRoutesCached = async (routeIds: string[]): Promise<Map<string, string[]>> => {
  const now = Date.now();
  const result = new Map<string, string[]>();
  const missing: string[] = [];
  routeIds.forEach((routeId) => {
    const cached = cache.lineShapesByRoute.get(routeId);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      result.set(routeId, cached.data);
    } else {
      missing.push(routeId);
    }
  });
  if (missing.length > 0) {
    const fetched = await getLineShapesByRoutes(missing);
    fetched.forEach((polylines, routeId) => {
      cache.lineShapesByRoute.set(routeId, { fetchedAt: now, data: polylines });
      result.set(routeId, polylines);
    });
  }
  return result;
};

const getGtfsSnapshot = async (): Promise<GtfsSnapshot> => {
  if (cache.gtfsSnapshot.data && Date.now() - cache.gtfsSnapshot.fetchedAt < GTFS_SNAPSHOT_TTL_MS) {
    return cache.gtfsSnapshot.data;
  }
  const [routes, stops, stopRoutes, graphEdges] = await Promise.all([
    getRoutes(),
    getStops(),
    getStopRoutes(),
    getGraphEdges(),
  ]);
  const snapshot: GtfsSnapshot = {
    routes,
    stops,
    stopRoutes,
    graphEdges,
  };
  cache.gtfsSnapshot = { fetchedAt: Date.now(), data: snapshot };
  cache.routes = { fetchedAt: cache.gtfsSnapshot.fetchedAt, data: routes };
  cache.stops = { fetchedAt: cache.gtfsSnapshot.fetchedAt, data: stops };
  cache.stopRoutes = { fetchedAt: cache.gtfsSnapshot.fetchedAt, data: stopRoutes };
  cache.graphEdges = { fetchedAt: cache.gtfsSnapshot.fetchedAt, data: graphEdges };
  return snapshot;
};
