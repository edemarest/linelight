"use client";

// Maps API trip planner responses into UI-friendly view models.
import type { TripPlannerLeg, TripPlannerResponse } from "@linelight/core";

export type TripModeState =
  | "HOME"
  | "TRIP_EDITING"
  | "TRIP_PLANNING"
  | "TRIP_READY"
  | "TRIP_ERROR"
  | "TRIP_FOLLOW_LEG";

export type TripPoint = {
  label: string;
  lat: number;
  lon: number;
  stopId?: string | null;
};

export type TripPlanView = {
  tripId: string;
  label: "Best route" | `Alternate ${number}`;
  totalMinutes: number;
  transfers: number;
  walkMinutes: number;
  waitMinutes: number;
  rideMinutes: number;
  confidence: TripPlannerResponse["summary"]["confidence"];
  legs: TripPlannerLeg[];
  map: TripPlannerResponse["primary"]["map"];
};

export type TripPlannerViewModel = {
  origin: TripPoint | null;
  destination: TripPoint | null;
  activeTripId: string | null;
  plans: TripPlanView[];
  summary: TripPlannerResponse["summary"] | null;
  warnings: TripPlannerResponse["warnings"];
};

export const mapTripPlannerResponse = (resp: TripPlannerResponse): TripPlannerViewModel => {
  const toPlan = (trip: TripPlannerResponse["primary"], label: TripPlanView["label"]): TripPlanView => ({
    tripId: trip.tripId,
    label,
    totalMinutes: resp.summary.totalMinutes,
    transfers: resp.summary.transfers,
    walkMinutes: resp.summary.walkMinutes,
    waitMinutes: resp.summary.waitMinutes,
    rideMinutes: resp.summary.rideMinutes,
    confidence: resp.summary.confidence,
    legs: trip.legs,
    map: trip.map,
  });

  return {
    origin: null,
    destination: null,
    activeTripId: resp.primary.tripId,
    plans: [
      toPlan(resp.primary, "Best route"),
      ...resp.alternates.map((trip, idx) => ({
        tripId: trip.tripId,
        label: `Alternate ${idx + 1}` as const,
        totalMinutes: trip.totalMinutes,
        transfers: trip.transfers,
        walkMinutes: resp.summary.walkMinutes,
        waitMinutes: resp.summary.waitMinutes,
        rideMinutes: resp.summary.rideMinutes,
        confidence: resp.summary.confidence,
        legs: trip.legs,
        map: resp.primary.map,
      })),
    ],
    summary: resp.summary,
    warnings: resp.warnings,
  };
};
