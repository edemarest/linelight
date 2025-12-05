import type { EtaSource, IsoTimestamp, LatLng } from "./common";

export interface TripTrackResponse {
  tripId: string;
  routeId: string;
  destination: string;
  vehicle?: TripVehicle;
  upcomingStops: TripUpcomingStop[];
}

export interface TripVehicle {
  id: string;
  position: LatLng;
  bearing?: number;
  lastUpdated: IsoTimestamp;
}

export interface TripUpcomingStop {
  stopId: string;
  stopName: string;
  etaMinutes: number | null;
  source: EtaSource;
}
