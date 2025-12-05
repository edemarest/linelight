import type { IsoTimestamp, Mode, EtaSource, ServiceStatus } from "./common";

export interface HomeResponse {
  favorites: HomeStopSummary[];
  nearby: HomeStopSummary[];
  generatedAt: IsoTimestamp;
}

export interface HomeStopSummary {
  stopId: string;
  name: string;
  distanceMeters: number;
  modes: Mode[];
  routes: HomeRouteSummary[];
  platformStopIds: string[];
}

export interface HomeRouteSummary {
  routeId: string;
  shortName: string;
  direction: string;
  destination?: string | null;
  directionId: 0 | 1 | null;
  nextTimes: HomeEta[];
}

export interface HomeEta {
  etaMinutes: number | null;
  source: EtaSource;
  status: ServiceStatus;
}
