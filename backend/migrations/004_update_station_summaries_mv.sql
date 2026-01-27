ALTER TABLE stops
  ADD COLUMN IF NOT EXISTS location_type smallint;

UPDATE stops
SET location_type = CASE
  WHEN parent_station_id IS NULL THEN 1
  ELSE 0
END
WHERE location_type IS NULL;

DROP MATERIALIZED VIEW IF EXISTS station_summaries_mv;

CREATE MATERIALIZED VIEW station_summaries_mv AS
  WITH base_stops AS (
    SELECT
      s.id AS stop_id,
      COALESCE(s.parent_station_id, s.id) AS station_id,
      s.name,
      s.lat,
      s.lon
    FROM stops s
    WHERE s.location_type IS NULL OR s.location_type IN (0, 1, 4)
  ),
  station_base AS (
    SELECT
      s.id AS station_id,
      s.name,
      s.lat,
      s.lon
    FROM stops s
    WHERE s.parent_station_id IS NULL
      AND (s.location_type IS NULL OR s.location_type IN (1))
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_station_summaries_mv_station_id
  ON station_summaries_mv (station_id);
