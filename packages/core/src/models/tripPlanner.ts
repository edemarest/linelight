// Shared trip planner request/response models.
export type TripPlannerMode = "subway" | "bus" | "commuter_rail" | "ferry" | "other";
export type TripPlannerLegMode = TripPlannerMode | "walk";
export type TripPlannerLegSource = "prediction" | "schedule" | "fallback";

export interface TripPlannerRequest {
  originLat: number;
  originLon: number;
  destLat: number;
  destLon: number;
  departAt?: string;
  modes?: TripPlannerMode[];
  maxWalkMinutes?: number;
  maxTransfers?: number;
}

export interface TripPlannerStopRef {
  stopId?: string;
  name?: string;
  label?: string;
  lat?: number;
  lon?: number;
}

export interface TripPlannerLeg {
  mode: TripPlannerLegMode;
  routeId?: string;
  lineId?: string | null;
  directionId?: number | null;
  headsign?: string | null;
  from: TripPlannerStopRef;
  to: TripPlannerStopRef;
  departureTime?: string | null;
  arrivalTime?: string | null;
  waitMinutes?: number;
  rideMinutes?: number;
  durationMinutes?: number;
  distanceMeters?: number;
  source?: TripPlannerLegSource;
  transferPenaltyMinutes?: number;
  style?: "walk";
}

export interface TripPlannerSummary {
  totalMinutes: number;
  walkMinutes: number;
  waitMinutes: number;
  rideMinutes: number;
  transferPenaltyMinutes?: number;
  transfers: number;
  confidence: "realtime" | "schedule" | "fallback";
}

export interface TripPlannerMapLayer {
  lineId: string;
  color: string | null;
  polyline: string | null;
}

export interface TripPlannerPrimary {
  tripId: string;
  legs: TripPlannerLeg[];
  map: {
    bounds: [[number, number], [number, number]];
    walkPolyline: string | null;
    walkPolylines?: string[];
    lineShapes: TripPlannerMapLayer[];
  };
}

export interface TripPlannerAlternate {
  tripId: string;
  totalMinutes: number;
  transfers: number;
  legs: TripPlannerLeg[];
}

export interface TripPlannerWarning {
  code: string;
  message: string;
}

export interface TripPlannerResponse {
  generatedAt: string;
  request: TripPlannerRequest;
  summary: TripPlannerSummary;
  primary: TripPlannerPrimary;
  alternates: TripPlannerAlternate[];
  warnings: TripPlannerWarning[];
}

export interface TripPlannerValidationResult {
  ok: boolean;
  errors: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

export const validateTripPlannerResponse = (value: unknown): TripPlannerValidationResult => {
  const errors: string[] = [];
  if (!isObject(value)) {
    return { ok: false, errors: ["response is not an object"] };
  }

  if (!isString(value.generatedAt)) errors.push("generatedAt must be a string");
  if (!isObject(value.request)) errors.push("request must be an object");
  if (!isObject(value.summary)) errors.push("summary must be an object");
  if (!isObject(value.primary)) errors.push("primary must be an object");
  if (!isArray(value.alternates)) errors.push("alternates must be an array");
  if (!isArray(value.warnings)) errors.push("warnings must be an array");

  if (isObject(value.request)) {
    if (!isNumber(value.request.originLat)) errors.push("request.originLat must be a number");
    if (!isNumber(value.request.originLon)) errors.push("request.originLon must be a number");
    if (!isNumber(value.request.destLat)) errors.push("request.destLat must be a number");
    if (!isNumber(value.request.destLon)) errors.push("request.destLon must be a number");
  }

  if (isObject(value.summary)) {
    if (!isNumber(value.summary.totalMinutes)) errors.push("summary.totalMinutes must be a number");
    if (!isNumber(value.summary.walkMinutes)) errors.push("summary.walkMinutes must be a number");
    if (!isNumber(value.summary.waitMinutes)) errors.push("summary.waitMinutes must be a number");
    if (!isNumber(value.summary.rideMinutes)) errors.push("summary.rideMinutes must be a number");
    if (!isNumber(value.summary.transfers)) errors.push("summary.transfers must be a number");
    if (
      value.summary.transferPenaltyMinutes !== undefined &&
      !isNumber(value.summary.transferPenaltyMinutes)
    ) {
      errors.push("summary.transferPenaltyMinutes must be a number");
    }
  }

  if (isObject(value.primary)) {
    if (!isString(value.primary.tripId)) errors.push("primary.tripId must be a string");
    if (!isArray(value.primary.legs)) errors.push("primary.legs must be an array");
    if (isObject(value.primary.map) && value.primary.map.walkPolylines !== undefined) {
      if (
        !isArray(value.primary.map.walkPolylines) ||
        !value.primary.map.walkPolylines.every((entry) => isString(entry))
      ) {
        errors.push("primary.map.walkPolylines must be an array of strings");
      }
    }
  }

  return { ok: errors.length === 0, errors };
};
