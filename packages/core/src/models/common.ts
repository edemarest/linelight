export type Mode = "subway" | "bus" | "commuter_rail" | "ferry" | "other";

export interface LatLng {
  lat: number;
  lng: number;
}

export type IsoTimestamp = string;

export type EtaSource = "prediction" | "schedule" | "blended" | "unknown";

export type ServiceStatus =
  | "on_time"
  | "delayed"
  | "cancelled"
  | "skipped"
  | "no_service"
  | "unknown";

export interface LineLightErrorResponse {
  error: string;
  message?: string;
}
