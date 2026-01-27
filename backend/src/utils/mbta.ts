import type { MbtaLine } from "../models/mbta";
import { extractRelationshipIds } from "./jsonApi";

export const getLineRouteIds = (
  line: MbtaLine,
  options?: { fallbackToLineId?: boolean },
): string[] => {
  const routeIds = extractRelationshipIds(line.relationships?.routes);
  if (routeIds.length > 0) return routeIds;
  return options?.fallbackToLineId === false ? [] : [line.id];
};
