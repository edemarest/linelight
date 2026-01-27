DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_matviews WHERE matviewname = 'station_summaries_mv') THEN
    CREATE MATERIALIZED VIEW station_summaries_mv AS
      WITH base_stops AS (
        SELECT
          s.id AS stop_id,
          COALESCE(s.parent_station_id, s.id) AS station_id,
          s.name,
          s.lat,
          s.lon
        FROM stops s
      ),
      station_base AS (
        SELECT
          s.id AS station_id,
          s.name,
          s.lat,
          s.lon
        FROM stops s
        WHERE s.parent_station_id IS NULL
      )
      SELECT
        b.station_id,
        COALESCE(sb.name, MAX(b.name)) AS name,
        COALESCE(sb.lat, MAX(b.lat)) AS lat,
        COALESCE(sb.lon, MAX(b.lon)) AS lon,
        ARRAY_AGG(DISTINCT b.stop_id) AS platform_stop_ids,
        ARRAY_AGG(DISTINCT sr.route_id) FILTER (WHERE sr.route_id IS NOT NULL) AS routes_serving,
        ARRAY_AGG(
          DISTINCT CASE r.type
            WHEN 0 THEN 'subway'
            WHEN 1 THEN 'subway'
            WHEN 2 THEN 'commuter_rail'
            WHEN 3 THEN 'bus'
            WHEN 4 THEN 'ferry'
            ELSE 'other'
          END
        ) FILTER (WHERE r.type IS NOT NULL) AS modes_served
      FROM base_stops b
      LEFT JOIN station_base sb ON sb.station_id = b.station_id
      LEFT JOIN stop_routes sr ON sr.stop_id = b.stop_id
      LEFT JOIN routes r ON r.id = sr.route_id
      GROUP BY b.station_id, sb.name, sb.lat, sb.lon;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_matviews WHERE matviewname = 'line_shapes_mv') THEN
    CREATE MATERIALIZED VIEW line_shapes_mv AS
      SELECT
        s.route_id,
        ARRAY_AGG(s.polyline) FILTER (WHERE s.polyline IS NOT NULL) AS polylines
      FROM shapes s
      GROUP BY s.route_id;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_station_summaries_mv_station_id
  ON station_summaries_mv (station_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_line_shapes_mv_route_id
  ON line_shapes_mv (route_id);
