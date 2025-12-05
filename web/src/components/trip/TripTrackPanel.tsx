"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchTripTrack } from "@/lib/api";
import { formatEta } from "@/lib/time";
import { EtaSourceIndicator } from "@/components/stop/EtaSourceIndicator";

interface TripTrackPanelProps {
  tripId: string;
  onClose: () => void;
}

const colorForRoute = (routeId?: string) => {
  if (!routeId) return "var(--line-blue)";
  if (/red/i.test(routeId)) return "var(--line-red)";
  if (/orange/i.test(routeId)) return "var(--line-orange)";
  if (/blue/i.test(routeId)) return "var(--line-blue)";
  if (/green/i.test(routeId)) return "var(--line-green)";
  if (/silver/i.test(routeId)) return "var(--line-silver)";
  if (/purple|commuter/i.test(routeId)) return "var(--line-purple)";
  return "var(--line-blue)";
};

export const TripTrackPanel = ({ tripId, onClose }: TripTrackPanelProps) => {
  const tripQuery = useQuery({
    queryKey: ["tripTrack", tripId],
    queryFn: () => fetchTripTrack(tripId),
    enabled: Boolean(tripId),
    refetchInterval: 10_000,
  });

  const trip = tripQuery.data;

  const vehicleInfo = trip?.vehicle
    ? `${trip.vehicle.position.lat.toFixed(3)}, ${trip.vehicle.position.lng.toFixed(3)}`
    : null;

  const upcomingStops = useMemo(() => trip?.upcomingStops ?? [], [trip?.upcomingStops]);

  const lineColor = colorForRoute(trip?.routeId);

  return (
    <div className="panel fixed bottom-4 right-4 z-40 w-full max-w-lg border" style={{ borderColor: lineColor }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="heading-label" style={{ color: lineColor }}>
            Trip tracking
          </p>
          <h3 className="text-2xl font-semibold">{trip?.destination ?? trip?.tripId ?? tripId}</h3>
          <p className="text-xs text-muted">Route {trip?.routeId}</p>
        </div>
        <button
          type="button"
          className="btn btn-ghost touch-target px-3 py-1 text-xs"
          onClick={onClose}
          aria-label="Close trip tracker"
        >
          Close
        </button>
      </div>
      {tripQuery.isLoading && <p className="mt-4 text-sm text-muted">Tracking vehicle…</p>}
      {tripQuery.isError && (
        <p className="mt-4 text-sm" style={{ color: "var(--line-red)" }}>
          Unable to fetch trip tracking data right now.
        </p>
      )}
      {!tripQuery.isLoading && trip && (
        <div className="mt-4 space-y-3 text-sm">
          {vehicleInfo && (
            <div className="panel text-xs">
              <p>Vehicle {trip.vehicle?.id}</p>
              <p className="text-slate-300">Position: {vehicleInfo}</p>
              <p>Updated: {new Date(trip.vehicle!.lastUpdated).toLocaleTimeString()}</p>
            </div>
          )}
          {upcomingStops.length === 0 ? (
            <p className="text-muted">No upcoming stops available.</p>
          ) : (
            <div className="space-y-2">
              {upcomingStops.map((stop, idx) => {
                const etaLabel = formatEta(stop.etaMinutes);
                const unitLabel =
                  stop.etaMinutes == null
                    ? "ETA"
                    : stop.etaMinutes <= 0
                    ? "Due"
                    : stop.etaMinutes < 60
                    ? "min"
                    : "ETA";
                return (
                  <div key={`${stop.stopId}-${idx}`} className="flex items-center gap-3">
                    <div className="flex flex-col items-center text-xs text-slate-200">
                      <span className="chip chip-live font-semibold" style={{ borderColor: lineColor, color: lineColor }}>
                        {etaLabel}
                      </span>
                      <span className="text-[10px] uppercase tracking-wide text-muted">{unitLabel}</span>
                    </div>
                    <div className="panel flex-1 px-3 py-2">
                      <p className="font-semibold">{stop.stopName}</p>
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <EtaSourceIndicator source={stop.source} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
