// Derives map UI mode and visibility flags from trip/stop/follow state.
import { useMemo } from "react";
import type { TripModeState } from "@/lib/tripPlannerViewModel";

export type MapUiMode = "HOME" | "TRIP" | "STOP_SHEET" | "FOLLOW" | "PICK_ORIGIN" | "PICK_DEST";

export type MapVisibility = {
  showBaseLayers: boolean;
  showStationMarkers: boolean;
  showSavedLocationMarkers: boolean;
  showMapControls: boolean;
  showCenterTarget: boolean;
  showHomeHeader: boolean;
  showTripMarkers: boolean;
};

type MapUiModeParams = {
  tripMode: TripModeState;
  mapPickMode: "origin" | "destination" | null;
  isFollowingTrip: boolean;
  isStopSheetOpen: boolean;
};

export const useMapUiMode = ({
  tripMode,
  mapPickMode,
  isFollowingTrip,
  isStopSheetOpen,
}: MapUiModeParams): MapUiMode =>
  useMemo(() => {
    if (mapPickMode === "origin") return "PICK_ORIGIN";
    if (mapPickMode === "destination") return "PICK_DEST";
    if (isFollowingTrip) return "FOLLOW";
    if (isStopSheetOpen) return "STOP_SHEET";
    if (
      tripMode === "TRIP_EDITING" ||
      tripMode === "TRIP_PLANNING" ||
      tripMode === "TRIP_READY" ||
      tripMode === "TRIP_ERROR"
    ) {
      return "TRIP";
    }
    return "HOME";
  }, [isFollowingTrip, isStopSheetOpen, mapPickMode, tripMode]);

export const useMapVisibility = ({
  mapUiMode,
  hasActiveTripPlan,
  isFollowingTrip,
}: {
  mapUiMode: MapUiMode;
  hasActiveTripPlan: boolean;
  isFollowingTrip: boolean;
}): MapVisibility =>
  useMemo(() => {
    const showHomeLayers = mapUiMode === "HOME" || mapUiMode === "STOP_SHEET" || mapUiMode === "TRIP";
    const showTripLayers = mapUiMode === "TRIP" || mapUiMode === "PICK_ORIGIN" || mapUiMode === "PICK_DEST";
    const showFollowLayers = mapUiMode === "FOLLOW";
    return {
      showBaseLayers: showHomeLayers || showFollowLayers,
      showStationMarkers: showHomeLayers || showFollowLayers,
      showSavedLocationMarkers: showHomeLayers,
      showMapControls: mapUiMode === "HOME" || mapUiMode === "STOP_SHEET" || mapUiMode === "TRIP",
      showCenterTarget: mapUiMode === "HOME" || mapUiMode === "TRIP" || mapUiMode === "STOP_SHEET" || mapUiMode === "FOLLOW",
      showHomeHeader: mapUiMode === "HOME",
      showTripMarkers: hasActiveTripPlan && !isFollowingTrip && showTripLayers,
    };
  }, [hasActiveTripPlan, isFollowingTrip, mapUiMode]);
