import dotenv from "dotenv";
import { closeDb, getGraphEdges, getRoutes, getShapesByRoute, getStops } from "../db";

dotenv.config();

const time = async <T,>(label: string, fn: () => Promise<T>) => {
  const start = Date.now();
  const result = await fn();
  const duration = Date.now() - start;
  console.log(`${label}: ${duration}ms`);
  return result;
};

const run = async () => {
  const routes = await time("routes", getRoutes);
  const stops = await time("stops", getStops);
  const edges = await time("graph_edges", getGraphEdges);
  const sampleRoute = routes[0]?.id ?? "Red";
  const shapes = await time(`shapes(${sampleRoute})`, () => getShapesByRoute(sampleRoute));

  console.log({
    routes: routes.length,
    stops: stops.length,
    graphEdges: edges.length,
    shapes: shapes.length,
  });
};

run()
  .catch((error) => {
    console.error("DB smoke test failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await closeDb();
  });
