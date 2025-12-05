import type { IsoTimestamp, Mode, LatLng } from "./common";
import type { StationAlert } from "./stationBoard";

export interface LineSummary {
  id: string;
  shortName: string;
  mode: Mode;
  status: "good" | "minor" | "major" | "unknown";
}

export interface LineOverview {
  line: LineSummary;
  segments: LineSegmentHealth[];
  headwaySummary: HeadwaySummary;
  alerts: StationAlert[];
}

export interface LineSegmentHealth {
  segmentId: string;
  fromStopId: string;
  toStopId: string;
  status: "good" | "minor" | "major" | "unknown";
  notes?: string;
}

export interface HeadwaySummary {
  typicalHeadwayMinutes: number | null;
  observedHeadwayMinutes: number | null;
  reliabilityScore?: number;
}

export interface SystemInsights {
  generatedAt: IsoTimestamp;
  lines: LineSummary[];
  worstSegments: LineSegmentHealth[];
  notes?: string;
}

export interface LineShapeResponse {
  lineId: string;
  color: string | null;
  textColor: string | null;
  shapes: LatLng[][];
}
