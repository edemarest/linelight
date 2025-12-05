export type IsoTimestamp = string;
export type LineId = string;
export type StopId = string;
export type TripId = string;
export type VehicleId = string;

export type SegmentHealth = "good" | "minor_issues" | "major_issues" | "no_service";
export type Mode = "subway" | "bus" | "commuter_rail" | "ferry" | "other";

export interface Coordinate {
  lat: number;
  lng: number;
}

export interface StationPlatformMarker {
  stopId: StopId;
  name: string;
  latitude: number;
  longitude: number;
}

export interface LineAlertSummary {
  alertId: string;
  header: string;
  severity: number | null;
  effect: string | null;
  lifecycle: string | null;
}

export interface SegmentStatus {
  segmentId: string;
  fromStopId: StopId;
  toStopId: StopId;
  directionId: 0 | 1 | null;
  headwayMinutes: number | null;
  headwayDeviationMinutes: number | null;
  health: SegmentHealth;
  coordinates: Coordinate[];
}

export interface LineOverview {
  lineId: LineId;
  displayName: string;
  color: string;
  mode: Mode;
  activeVehicles: number;
  expectedVehicles: number | null;
  typicalHeadwayMinutes: number | null;
  alerts: LineAlertSummary[];
  segments: SegmentStatus[];
  shapePaths: Coordinate[][];
  updatedAt: IsoTimestamp;
}

export interface LineSummary {
  lineId: LineId;
  displayName: string;
  color: string;
  mode: Mode;
  hasAlerts: boolean;
  vehicleCount: number;
  updatedAt: IsoTimestamp;
}

export interface DeparturePrediction {
  tripId: TripId | null;
  routeId: string | null;
  vehicleId: VehicleId | null;
  destination: string | null;
  scheduledTime: IsoTimestamp | null;
  predictedTime: IsoTimestamp | null;
  countdownSeconds: number | null;
  crowdingLevel: "low" | "medium" | "high" | "unknown";
  reliabilityFlag: "normal" | "delayed" | "gap" | "unknown";
  vehicleStatus: string | null;
}

export interface LineDepartures {
  lineId: LineId | null;
  directionId: 0 | 1 | null;
  directionLabel: string;
  departures: DeparturePrediction[];
}

export interface StationBoard {
  stopId: StopId;
  name: string;
  linesServed: LineId[];
  departuresByLine: LineDepartures[];
  alerts: LineAlertSummary[];
  updatedAt: IsoTimestamp;
}

export interface StationSummary {
  stopId: StopId;
  name: string;
  latitude: number;
  longitude: number;
  routesServing: string[];
  modesServed: Mode[];
  platformStopIds: StopId[];
  platformMarkers: StationPlatformMarker[];
}

export interface VehicleSnapshot {
  vehicleId: VehicleId;
  routeId: string | null;
  lineId: LineId | null;
  mode: Mode;
  latitude: number | null;
  longitude: number | null;
  bearing: number | null;
  updatedAt: IsoTimestamp;
}

export interface LineInsight {
  lineId: LineId;
  displayName: string;
  mode: Mode;
  painScore: number;
  averageDelayMinutes: number | null;
  headwayVarianceMinutes: number | null;
  activeAlerts: number;
  activeVehicles: number;
}

export interface SegmentTroubleSummary {
  lineId: LineId;
  summary: string;
  severity: number;
}

export interface SystemInsights {
  generatedAt: IsoTimestamp;
  lines: LineInsight[];
  topTroubleSegments: SegmentTroubleSummary[];
}
