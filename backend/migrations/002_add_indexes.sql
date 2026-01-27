CREATE INDEX IF NOT EXISTS idx_shapes_route_id ON shapes (route_id);
CREATE INDEX IF NOT EXISTS idx_stop_routes_route_id ON stop_routes (route_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_route_id ON graph_edges (route_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to_stop_id ON graph_edges (to_stop_id);
CREATE INDEX IF NOT EXISTS idx_route_patterns_route_id ON route_patterns (route_id);
CREATE INDEX IF NOT EXISTS idx_stops_parent_station_id ON stops (parent_station_id);
