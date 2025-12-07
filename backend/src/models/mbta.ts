import type { JsonApiResource } from "./jsonApi";

export type RouteType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type DirectionId = 0 | 1;

export interface MbtaRouteAttributes {
  short_name: string | null;
  long_name: string;
  description: string | null;
  type: RouteType;
  color: string | null;
  text_color: string | null;
  sort_order: number | null;
  direction_destinations?: string[] | null;
  direction_names?: string[] | null;
}

export type MbtaRoute = JsonApiResource<MbtaRouteAttributes> & { type: "route" };

export interface MbtaLineAttributes {
  short_name: string | null;
  long_name: string;
  color: string | null;
  text_color: string | null;
}

export type MbtaLine = JsonApiResource<MbtaLineAttributes> & { type: "line" };

export interface MbtaStopAttributes {
  name: string;
  description: string | null;
  latitude: number;
  longitude: number;
  wheelchair_boarding: number | null;
  location_type?: number | null;
  platform_code?: string | null;
  platform_name?: string | null;
}

export type MbtaStop = JsonApiResource<MbtaStopAttributes> & { type: "stop" };

export interface MbtaPredictionAttributes {
  arrival_time: string | null;
  departure_time: string | null;
  status: string | null;
  direction_id: DirectionId;
  stop_sequence: number | null;
  schedule_relationship?: string | null;
}

export type MbtaPrediction = JsonApiResource<MbtaPredictionAttributes> & {
  type: "prediction";
};

export interface MbtaVehicleAttributes {
  latitude: number | null;
  longitude: number | null;
  bearing: number | null;
  speed: number | null;
  current_status: string | null;
  current_stop_sequence: number | null;
  updated_at: string;
}

export type MbtaVehicle = JsonApiResource<MbtaVehicleAttributes> & {
  type: "vehicle";
};

export interface MbtaTripAttributes {
  headsign: string | null;
  direction_id: DirectionId;
}

export type MbtaTrip = JsonApiResource<MbtaTripAttributes> & {
  type: "trip";
};

export interface MbtaScheduleAttributes {
  arrival_time: string | null;
  departure_time: string | null;
  stop_sequence: number | null;
  stop_headsign?: string | null;
  direction_id?: DirectionId | null;
  pickup_type?: number | null;
  drop_off_type?: number | null;
}

export type MbtaSchedule = JsonApiResource<MbtaScheduleAttributes> & {
  type: "schedule";
};

export interface MbtaAlertAttributes {
  header_text: string | null;
  description_text: string | null;
  cause: string | null;
  effect: string | null;
  severity: number | null;
  lifecycle: string | null;
  updated_at?: string | null;
}

export type MbtaAlert = JsonApiResource<MbtaAlertAttributes> & { type: "alert" };

export interface MbtaLiveFacilityAttributes {
  properties: Record<string, unknown>;
  updated_at: string;
}

export type MbtaLiveFacility = JsonApiResource<MbtaLiveFacilityAttributes> & {
  type: "live_facility";
};

export interface MbtaShapeAttributes {
  polyline: string | null;
}

export type MbtaShape = JsonApiResource<MbtaShapeAttributes> & {
  type: "shape";
};
