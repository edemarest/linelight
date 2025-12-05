import type { EtaSource, IsoTimestamp, ServiceStatus, Mode } from "./common";

export interface GetStationBoardResponse {
  primary: StationBoardPrimary;
  details?: StationBoardDetails;
}

export interface StationBoardPrimary {
  stopId: string;
  stopName: string;
  distanceMeters?: number;
  walkMinutes?: number;
  routes: StationBoardRoutePrimary[];
}

export interface StationBoardRoutePrimary {
  routeId: string;
  shortName: string;
  mode: Mode;
  direction: string;
  primaryEta: StationEta | null;
  extraEtas: StationEta[];
}

export interface StationEta {
  etaMinutes: number | null;
  scheduledTime?: IsoTimestamp;
  predictedTime?: IsoTimestamp;
  source: EtaSource;
  status: ServiceStatus;
  tripId?: string;
}

export interface StationBoardDetails {
  departures: StationDeparture[];
  alerts: StationAlert[];
  facilities: StationFacility[];
}

export interface StationDeparture {
  routeId: string;
  shortName: string;
  direction: string;
  destination: string;
  scheduledTime?: IsoTimestamp;
  predictedTime?: IsoTimestamp;
  etaMinutes?: number | null;
  source: EtaSource;
  status: ServiceStatus;
}

export interface StationAlert {
  id: string;
  severity: "minor" | "moderate" | "major";
  header: string;
  description?: string;
  effect: string;
}

export interface StationFacility {
  id: string;
  type: "elevator" | "escalator" | "parking" | "other";
  status: "available" | "unavailable" | "limited" | "unknown";
  description?: string;
  capacity?: number;
  available?: number;
}
