import type { RouteType } from "../models/mbta";
import type { Mode } from "../models/domain";

export const mapRouteTypeToMode = (routeType: RouteType | null | undefined): Mode => {
  switch (routeType) {
    case 0: // light rail
    case 1: // heavy rail
      return "subway";
    case 2:
      return "commuter_rail";
    case 3:
      return "bus";
    case 4:
      return "ferry";
    default:
      return "other";
  }
};

const MODES: Mode[] = ["subway", "bus", "commuter_rail", "ferry", "other"];

export const isMode = (value?: string | null): value is Mode => {
  if (!value) return false;
  return MODES.includes(value as Mode);
};
