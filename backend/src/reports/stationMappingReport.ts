import type { MbtaStop } from "../models/mbta";
import { extractFirstRelationshipId } from "../utils/jsonApi";

export type StopKind = "station" | "platform" | "entrance" | "other";

export interface StationMappingRow {
  stopId: string;
  name: string;
  kind: StopKind;
  locationType: number | null | undefined;
  parentStationId: string | null;
  parentStationName: string | null;
  platformCode: string | null;
  latitude: number;
  longitude: number;
  isBoardable: boolean;
  issues: string[];
}

export interface StationMappingOptions {
  stopIds?: string[];
  boundingBox?: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  limit?: number;
}

export interface StationMappingReport {
  generatedAt: string;
  rows: StationMappingRow[];
  countsByKind: Record<StopKind, number>;
  csv: string;
}

const deriveStopKind = (stop: MbtaStop): StopKind => {
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

const withinBoundingBox = (
  stop: MbtaStop,
  box?: StationMappingOptions["boundingBox"],
): boolean => {
  if (!box) return true;
  return (
    stop.attributes.latitude <= box.north &&
    stop.attributes.latitude >= box.south &&
    stop.attributes.longitude >= box.west &&
    stop.attributes.longitude <= box.east
  );
};

const toCsv = (rows: StationMappingRow[]): string => {
  const header = [
    "stop_id",
    "name",
    "kind",
    "location_type",
    "parent_station_id",
    "parent_station_name",
    "platform_code",
    "latitude",
    "longitude",
    "is_boardable",
    "issues",
  ].join(",");

  const lines = rows.map((row) =>
    [
      row.stopId,
      row.name,
      row.kind,
      row.locationType ?? "",
      row.parentStationId ?? "",
      row.parentStationName ?? "",
      row.platformCode ?? "",
      row.latitude,
      row.longitude,
      row.isBoardable,
      row.issues.join("|"),
    ]
      .map((value) => `"${String(value).replace(/"/g, '""')}"`)
      .join(","),
  );

  return [header, ...lines].join("\n");
};

export const buildStationMappingReport = (
  stops: MbtaStop[],
  options: StationMappingOptions = {},
): StationMappingReport => {
  const stopMap = new Map(stops.map((stop) => [stop.id, stop]));
  const focusIds = options.stopIds && options.stopIds.length > 0 ? new Set(options.stopIds) : null;

  const filtered = stops
    .filter((stop) => {
      if (!withinBoundingBox(stop, options.boundingBox)) return false;
      if (!focusIds) return true;
      const parentId = extractFirstRelationshipId(stop.relationships?.parent_station);
      return focusIds.has(stop.id) || (parentId ? focusIds.has(parentId) : false);
    })
    .sort((a, b) => a.attributes.name.localeCompare(b.attributes.name))
    .slice(0, options.limit ?? stops.length);

  const rows: StationMappingRow[] = filtered.map((stop) => {
    const parentStationId = extractFirstRelationshipId(stop.relationships?.parent_station) ?? null;
    const parentStationName = parentStationId ? stopMap.get(parentStationId)?.attributes.name ?? null : null;
    const rowKind = deriveStopKind(stop);
    const isBoardable = rowKind === "station" || rowKind === "platform";
    const issues: string[] = [];
    if (!isBoardable) {
      issues.push("non_boardable");
    }
    if (rowKind === "platform" && !parentStationId) {
      issues.push("missing_parent_station");
    }
    if (parentStationId && !parentStationName) {
      issues.push("parent_not_loaded");
    }

    return {
      stopId: stop.id,
      name: stop.attributes.name,
      kind: rowKind,
      locationType: stop.attributes.location_type,
      parentStationId,
      parentStationName,
      platformCode: stop.attributes.platform_code ?? null,
      latitude: stop.attributes.latitude,
      longitude: stop.attributes.longitude,
      isBoardable,
      issues,
    };
  });

  const countsByKind: Record<StopKind, number> = {
    station: 0,
    platform: 0,
    entrance: 0,
    other: 0,
  };
  rows.forEach((row) => {
    countsByKind[row.kind] += 1;
  });

  return {
    generatedAt: new Date().toISOString(),
    rows,
    countsByKind,
    csv: toCsv(rows),
  };
};
