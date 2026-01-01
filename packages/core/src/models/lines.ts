import type { IsoTimestamp, Mode, LatLng } from "./common";

// These models represent the current LineLight backend API contract.
// The backend provides richer line detail and computed insights than the initial draft models.

export interface LineSummary {
  lineId: string;
  displayName: string;
  color: string;
  mode: Mode;
  hasAlerts: boolean;
  vehicleCount: number;
  updatedAt: IsoTimestamp;
}

export interface LinesResponse {
  ready: boolean;
  lines: LineSummary[];
  generatedAt: IsoTimestamp;
}

export type SegmentHealth = "good" | "minor_issues" | "major_issues" | "no_service";

export interface LineAlertSummary {
  alertId: string;
  header: string;
  severity: number | null;
  effect: string | null;
  lifecycle: string | null;
}

export interface LineSegmentStatus {
  segmentId: string;
  fromStopId: string;
  toStopId: string;
  directionId: 0 | 1 | null;
  headwayMinutes: number | null;
  headwayDeviationMinutes: number | null;
  health: SegmentHealth;
  coordinates: LatLng[];
}

export interface LineOverview {
  lineId: string;
  displayName: string;
  color: string;
  mode: Mode;
  activeVehicles: number;
  expectedVehicles: number | null;
  typicalHeadwayMinutes: number | null;
  alerts: LineAlertSummary[];
  segments: LineSegmentStatus[];
  shapePaths: LatLng[][];
  updatedAt: IsoTimestamp;
}

export interface LineOverviewResponse {
  line: LineOverview;
}

export interface LineInsight {
  lineId: string;
  displayName: string;
  mode: Mode;
  painScore: number;
  averageDelayMinutes: number | null;
  headwayVarianceMinutes: number | null;
  activeAlerts: number;
  activeVehicles: number;
}

export interface SegmentTroubleSummary {
  lineId: string;
  summary: string;
  severity: number;
}

export interface SystemInsights {
  generatedAt: IsoTimestamp;
  lines: LineInsight[];
  topTroubleSegments: SegmentTroubleSummary[];
}

export interface SystemInsightsResponse {
  insights: SystemInsights;
}

export interface LineShapeResponse {
  lineId: string;
  color: string | null;
  textColor: string | null;
  shapes: LatLng[][];
}
