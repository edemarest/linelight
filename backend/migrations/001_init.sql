CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  short_name TEXT,
  long_name TEXT,
  type INT,
  color TEXT,
  text_color TEXT
);

CREATE TABLE IF NOT EXISTS stops (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  parent_station_id TEXT,
  wheelchair_boarding INT
);

CREATE TABLE IF NOT EXISTS route_patterns (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id),
  direction_id INT NOT NULL,
  name TEXT
);

CREATE TABLE IF NOT EXISTS route_pattern_stops (
  pattern_id TEXT NOT NULL REFERENCES route_patterns(id),
  stop_id TEXT NOT NULL REFERENCES stops(id),
  stop_sequence INT NOT NULL,
  PRIMARY KEY (pattern_id, stop_id, stop_sequence)
);

CREATE TABLE IF NOT EXISTS shapes (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id),
  polyline TEXT
);

CREATE TABLE IF NOT EXISTS stop_routes (
  stop_id TEXT NOT NULL REFERENCES stops(id),
  route_id TEXT NOT NULL REFERENCES routes(id),
  PRIMARY KEY (stop_id, route_id)
);

CREATE TABLE IF NOT EXISTS graph_edges (
  from_stop_id TEXT NOT NULL REFERENCES stops(id),
  to_stop_id TEXT NOT NULL REFERENCES stops(id),
  route_id TEXT NOT NULL REFERENCES routes(id),
  direction_id INT NOT NULL,
  weight_minutes REAL,
  PRIMARY KEY (from_stop_id, to_stop_id, route_id, direction_id)
);

CREATE TABLE IF NOT EXISTS address_cache (
  query_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_stops_lat_lon ON stops (lat, lon);
CREATE INDEX IF NOT EXISTS idx_route_pattern_stops_pattern ON route_pattern_stops (pattern_id, stop_sequence);
CREATE INDEX IF NOT EXISTS idx_stop_routes_stop ON stop_routes (stop_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges (from_stop_id);
