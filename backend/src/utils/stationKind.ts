import type { MbtaStop } from "../models/mbta";
import { extractFirstRelationshipId } from "./jsonApi";

export type StationKind = "station" | "platform" | "entrance" | "other";

export const resolveStationKind = (stop: MbtaStop | null | undefined): StationKind => {
  if (!stop) return "other";
  const locationType = stop.attributes.location_type ?? 0;
  switch (locationType) {
    case 1:
      return "station";
    case 2:
      return "entrance";
    case 0:
    case 4:
      return "platform";
    default:
      return "other";
  }
};

export const isBoardableKind = (kind: StationKind): boolean => kind === "station" || kind === "platform";

export const resolveBoardableParent = (stop: MbtaStop, stopMap: Map<string, MbtaStop>): MbtaStop | null => {
  const kind = resolveStationKind(stop);
  if (isBoardableKind(kind)) {
    return stop;
  }
  const parentId = extractFirstRelationshipId(stop.relationships?.parent_station) ?? null;
  if (!parentId) {
    return null;
  }
  const parentStop = stopMap.get(parentId);
  if (!parentStop) {
    return null;
  }
  const parentKind = resolveStationKind(parentStop);
  return isBoardableKind(parentKind) ? parentStop : null;
};
