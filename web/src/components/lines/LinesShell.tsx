"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { fetchLines, fetchLineOverview, fetchLineShapes, fetchStations, fetchStopLookup, type LineSummary, type StopLookupEntry } from "@/lib/api";
import type { ModeFilter } from "@/lib/modes";
import MapGL, { type MapRef, type ViewState } from "react-map-gl/maplibre";
import DeckGL from "@deck.gl/react";
import { PathLayer } from "@deck.gl/layers";
import maplibregl from "maplibre-gl";
import { envConfig } from "@/lib/config";
import type { Color } from "@deck.gl/core";
import { FiArrowRight, FiExternalLink, FiCheckCircle, FiAlertCircle, FiXCircle, FiSlash } from "react-icons/fi";

const hexToColor = (hex: string | null | undefined): Color => {
  if (!hex) return [255, 255, 255, 200];
  const normalized = hex.replace("#", "");
  const bigint = Number.parseInt(normalized, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return [r, g, b, 220];
};

const formatMinutes = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) < 1) return value.toFixed(2);
  return value.toFixed(1);
};

const formatCount = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return "—";
  return Math.round(value).toString();
};

type SegmentHealth = "good" | "minor_issues" | "major_issues" | "no_service";

type LineOverview = Awaited<ReturnType<typeof fetchLineOverview>>;

const segmentHealthRank = (health: SegmentHealth): number => {
  switch (health) {
    case "no_service":
      return 4;
    case "major_issues":
      return 3;
    case "minor_issues":
      return 2;
    case "good":
    default:
      return 1;
  }
};

const segmentHealthLabel = (health: SegmentHealth): string => {
  switch (health) {
    case "no_service":
      return "No service";
    case "major_issues":
      return "Major";
    case "minor_issues":
      return "Minor";
    case "good":
    default:
      return "Good";
  }
};

const segmentHealthBadgeClass = (health: SegmentHealth): string => {
  switch (health) {
    case "good":
      return "--state-success";
    case "minor_issues":
      return "--state-warning";
    case "major_issues":
    case "no_service":
    default:
      return "--state-danger";
  }
};

const segmentHealthBadgeStyle = (health: SegmentHealth): React.CSSProperties => {
  const stateVar = segmentHealthBadgeClass(health);
  const stateColor = `var(${stateVar})`;
  return {
    borderColor: `color-mix(in srgb, ${stateColor} 55%, var(--border))`,
    background: `color-mix(in srgb, ${stateColor} 12%, var(--surface))`,
    color: stateColor,
  };
};

const segmentHealthIcon = (health: SegmentHealth) => {
  switch (health) {
    case "no_service":
      return <FiSlash aria-hidden="true" className="inline-block align-[-2px]" />;
    case "major_issues":
      return <FiXCircle aria-hidden="true" className="inline-block align-[-2px]" />;
    case "minor_issues":
      return <FiAlertCircle aria-hidden="true" className="inline-block align-[-2px]" />;
    case "good":
    default:
      return <FiCheckCircle aria-hidden="true" className="inline-block align-[-2px]" />;
  }
};

export const LinesShell = () => {
  const searchParams = useSearchParams();
  const mapRef = useRef<MapRef | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [viewState, setViewState] = useState<ViewState>({
    latitude: envConfig.defaultMap.lat,
    longitude: envConfig.defaultMap.lng,
    zoom: envConfig.defaultMap.zoom,
    bearing: 0,
    pitch: 0,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
  });

  const linesQuery = useQuery({
    queryKey: ["lines"],
    queryFn: fetchLines,
    staleTime: 60_000,
  });

  const lines = useMemo(() => {
    const data = linesQuery.data as unknown;
    if (Array.isArray(data)) return data as LineSummary[];
    if (data && typeof data === "object") {
      const maybe = data as { lines?: unknown };
      if (Array.isArray(maybe.lines)) return maybe.lines as LineSummary[];
    }
    return [] as LineSummary[];
  }, [linesQuery.data]);

  const lineOverviewQuery = useQuery({
    queryKey: ["lineOverview", selectedLineId],
    queryFn: () => fetchLineOverview(selectedLineId!),
    enabled: Boolean(selectedLineId),
    staleTime: 60_000,
  });

  const lineShapesQuery = useQuery({
    queryKey: ["lineShapes", selectedLineId],
    queryFn: () => fetchLineShapes(selectedLineId!),
    enabled: Boolean(selectedLineId),
    staleTime: 300_000,
  });

  const stationsQuery = useQuery({
    queryKey: ["stations", "mode", lineOverviewQuery.data?.mode ?? "unknown"],
    queryFn: () => fetchStations(lineOverviewQuery.data!.mode as ModeFilter, 900),
    enabled: Boolean(lineOverviewQuery.data?.mode),
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    const lineIdFromQuery = searchParams.get("lineId");
    if (!lineIdFromQuery) return;
    const normalized = lineIdFromQuery.trim();
    if (!normalized) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedLineId(normalized);
  }, [searchParams]);

  const stopNameById = useMemo(() => {
    const map = new Map<string, string>();
    (stationsQuery.data ?? []).forEach((station) => {
      if (station.stopId) map.set(station.stopId, station.name);
      (station.platformStopIds ?? []).forEach((platformId) => {
        if (!platformId) return;
        map.set(platformId, station.name);
      });
      (station.platformMarkers ?? []).forEach((marker) => {
        if (!marker.stopId) return;
        map.set(marker.stopId, marker.name || station.name);
      });
    });
    return map;
  }, [stationsQuery.data]);

  const segmentStopIds = useMemo(() => {
    const segments = lineOverviewQuery.data?.segments ?? [];
    const ids = new Set<string>();
    segments.forEach((segment) => {
      ids.add(segment.fromStopId);
      ids.add(segment.toStopId);
    });
    return Array.from(ids);
  }, [lineOverviewQuery.data?.segments]);

  const stopLookupQuery = useQuery({
    queryKey: ["stopLookup", segmentStopIds],
    queryFn: () => fetchStopLookup(segmentStopIds),
    enabled: segmentStopIds.length > 0,
    staleTime: 10 * 60_000,
  });

  const stopLabelById = useMemo(() => {
    const merged = new Map(stopNameById);
    (stopLookupQuery.data ?? []).forEach((stop: StopLookupEntry) => {
      if (!stop.stopId || !stop.name) return;
      merged.set(stop.stopId, stop.name);
    });
    return merged;
  }, [stopLookupQuery.data, stopNameById]);

  const worstSegments = useMemo<
    Array<
      LineOverview["segments"][number] & {
        fromName: string;
        toName: string;
        score: number;
      }
    >
  >(() => {
    const overview = lineOverviewQuery.data;
    if (!overview) return [];

    return overview.segments
      .filter((segment) => segment.health !== "good")
      .map((segment) => {
        const deviation = Math.abs(segment.headwayDeviationMinutes ?? 0);
        const score = segmentHealthRank(segment.health as SegmentHealth) * 1_000 + deviation * 10 + (segment.headwayMinutes ?? 0);
        return {
          ...segment,
          fromName: stopLabelById.get(segment.fromStopId) ?? segment.fromStopId,
          toName: stopLabelById.get(segment.toStopId) ?? segment.toStopId,
          score,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }, [lineOverviewQuery.data, stopLabelById]);

  const segmentHealthCounts = useMemo(() => {
    const counts: Record<SegmentHealth, number> = {
      good: 0,
      minor_issues: 0,
      major_issues: 0,
      no_service: 0,
    };
    const overview = lineOverviewQuery.data;
    if (!overview) return counts;
    overview.segments.forEach((segment) => {
      const health = segment.health as SegmentHealth;
      if (health in counts) counts[health] += 1;
    });
    return counts;
  }, [lineOverviewQuery.data]);

  const pathLayers = useMemo(() => {
    if (!lineShapesQuery.data) return [];
    const pathData = lineShapesQuery.data.shapes.map((path) =>
      path.map((coord) => [coord.lng, coord.lat] as [number, number]),
    );
    return [
      new PathLayer({
        id: `line-shapes-${selectedLineId}`,
        data: pathData,
        getPath: (path: [number, number][]) => path,
        getWidth: () => 6,
        getColor: () => hexToColor(lineShapesQuery.data?.color),
        widthUnits: "pixels",
        opacity: 0.9,
        rounded: true,
        parameters: { depthTest: false },
      }),
    ];
  }, [lineShapesQuery.data, selectedLineId]);

  useEffect(() => {
    const shapes = lineShapesQuery.data?.shapes;
    const map = mapRef.current?.getMap?.();
    if (!map || !shapes || shapes.length === 0) return;
    const points = shapes.flat().filter((coord) => Number.isFinite(coord.lat) && Number.isFinite(coord.lng));
    if (points.length === 0) return;
    const lats = points.map((p) => p.lat);
    const lngs = points.map((p) => p.lng);
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ];
    try {
      map.fitBounds(bounds, { padding: 80, duration: 800 });
    } catch {
      // ignore fit errors
    }
  }, [lineShapesQuery.data, selectedLineId]);

  const selectedLine = useMemo(
    () => (selectedLineId ? lines.find((line) => line.lineId === selectedLineId) ?? null : null),
    [lines, selectedLineId],
  );
  const selectedLineLabel = selectedLine?.displayName ?? (selectedLineId ? selectedLineId.replace(/^line-/, "") : "Select a line");

  return (
    <div className="flex min-h-screen flex-col" style={{ background: "var(--background)", color: "var(--foreground)" }}>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-6">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.4em]" style={{ color: "var(--muted)" }}>
              Lines
            </p>
            <h1 className="text-2xl font-semibold">Network health overview</h1>
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              Select a line to view headways, segments, and live topology.
            </p>
          </div>
          {selectedLineId && (
            <Link href={`/?line=${encodeURIComponent(selectedLineId)}`} className="text-sm text-(--accent) underline">
              Open on map
            </Link>
          )}
        </div>

        <div className="flex flex-col gap-6 lg:flex-row">
          <aside
            className="w-full rounded-3xl border p-4 shadow-inner shadow-slate-300 lg:w-80"
            style={{ borderColor: "var(--border)", background: "var(--card)" }}
          >
          <p className="text-xs uppercase tracking-[0.4em] text-(--muted)">Lines</p>
          <div className="mt-3 flex flex-col gap-2">
            {linesQuery.isLoading && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                Loading lines…
              </p>
            )}
            {linesQuery.isError && (
              <p className="text-sm" style={{ color: "var(--state-danger)" }}>
                Unable to load lines. Ensure backend is running.
              </p>
            )}
            {!linesQuery.isLoading && !linesQuery.isError && lines.length === 0 && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                Backend is warming up — check again in a few seconds.
              </p>
            )}
            {lines.map((line: LineSummary) => (
              <button
                key={line.lineId}
                type="button"
                onClick={() => setSelectedLineId(line.lineId)}
                className={`rounded-2xl border px-3 py-2 text-left text-sm transition ${
                  selectedLineId === line.lineId
                    ? "border-white/40 bg-white/10"
                    : "border-white/5 bg-black/20 hover:border-white/20"
                }`}
                style={{
                  borderColor: selectedLineId === line.lineId ? "var(--accent)" : "var(--border)",
                  background:
                    selectedLineId === line.lineId ? "var(--accent-soft)" : "color-mix(in srgb, var(--surface) 85%, transparent)",
                  color: "var(--foreground)",
                }}
              >
                <p className="font-semibold">{line.displayName}</p>
                <p className="text-xs" style={{ color: "var(--muted)" }}>
                  {line.hasAlerts ? "Active alerts" : "No alerts"} · {formatCount(line.vehicleCount)} vehicles
                </p>
              </button>
            ))}
          </div>
          </aside>
          <section className="flex-1 space-y-4">
          <div
            className="rounded-3xl border p-4 shadow-inner shadow-slate-300"
            style={{ borderColor: "var(--border)", background: "var(--card)" }}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.4em]" style={{ color: "var(--muted)" }}>
                  Line detail
                </p>
                <h2 className="text-xl font-semibold" style={{ color: "var(--foreground)" }}>
                  {selectedLineLabel}
                </h2>
              </div>
              {lineOverviewQuery.data && (
                <span
                  className="rounded-full border px-3 py-1 text-xs"
                  style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--foreground)" }}
                >
                  Typical headway: {formatMinutes(lineOverviewQuery.data.typicalHeadwayMinutes)} min
                </span>
              )}
            </div>
	            {selectedLineId && (
	              <div
	                className="relative mt-4 h-[360px] overflow-hidden rounded-2xl border"
	                style={{ borderColor: "var(--border)" }}
	              >
	                <div className="absolute inset-0">
	                  <DeckGL
	                    initialViewState={viewState}
	                    controller
	                    viewState={viewState}
	                    onViewStateChange={(evt) => setViewState(evt.viewState as ViewState)}
	                    layers={pathLayers}
		                  >
		                    <MapGL
		                      ref={mapRef}
		                      reuseMaps
		                      mapLib={maplibregl}
		                      mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
		                      style={{ width: "100%", height: "100%" }}
		                    />
		                  </DeckGL>
	                </div>
	                {lineShapesQuery.isLoading && (
	                  <div
	                    className="absolute inset-0 flex items-center justify-center text-sm"
	                    style={{ background: "color-mix(in srgb, var(--background) 55%, transparent)", color: "var(--foreground)" }}
	                  >
	                    Loading geometry…
	                  </div>
	                )}
	              </div>
	            )}
            {!selectedLineId && (
              <p className="mt-4 text-sm" style={{ color: "var(--muted)" }}>
                Select a line to render its map.
              </p>
            )}
          </div>
          {lineOverviewQuery.data && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div
                className="rounded-3xl border p-4 shadow"
                style={{ borderColor: "var(--border)", background: "var(--card)", color: "var(--foreground)" }}
              >
                <p className="text-xs uppercase tracking-[0.4em] text-(--muted)">Service snapshot</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div
                    className="rounded-2xl border px-4 py-3"
                    style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--foreground)" }}
                  >
                    <p className="text-xs" style={{ color: "var(--muted)" }}>
                      Active vehicles
                    </p>
                    <p className="mt-1 text-3xl font-semibold tabular-nums">{formatCount(lineOverviewQuery.data.activeVehicles)}</p>
                  </div>
                  <div
                    className="rounded-2xl border px-4 py-3"
                    style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--foreground)" }}
                  >
                    <p className="text-xs" style={{ color: "var(--muted)" }}>
                      Typical headway (min)
                    </p>
                    <p className="mt-1 text-3xl font-semibold tabular-nums">
                      {formatMinutes(lineOverviewQuery.data.typicalHeadwayMinutes)}
                    </p>
                  </div>
                </div>
              </div>
              <div
                className="rounded-3xl border p-4 shadow"
                style={{ borderColor: "var(--border)", background: "var(--card)", color: "var(--foreground)" }}
              >
                <p className="text-xs uppercase tracking-[0.4em] text-(--muted)">Alerts</p>
                {lineOverviewQuery.data.alerts.length === 0 ? (
                  <p className="text-sm" style={{ color: "var(--muted)" }}>
                    No active alerts for this line.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2 text-sm">
                    {lineOverviewQuery.data.alerts.map((alert, idx) => {
                      const alertKey = alert.alertId ?? idx;
                      return (
                        <li
                          key={alertKey}
                          className="rounded-2xl border p-3"
                          style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--foreground)" }}
                        >
                          <p className="font-semibold">{alert.header}</p>
                          {alert.effect && (
                            <p className="text-xs" style={{ color: "var(--muted)" }}>
                              {alert.effect}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              <div
                className="rounded-3xl border p-4 shadow lg:col-span-2"
                style={{ borderColor: "var(--border)", background: "var(--card)" }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.4em] text-(--muted)">Worst segments</p>
	                    <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
	                      Ranked by health and headway deviation
	                      {stationsQuery.isLoading || stopLookupQuery.isLoading ? " · resolving stop names…" : ""}
	                    </p>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      {(
                        [
                          { health: "major_issues" as const, label: "Major" },
                          { health: "minor_issues" as const, label: "Minor" },
                          { health: "no_service" as const, label: "No service" },
                          { health: "good" as const, label: "Good" },
                        ]
                      ).map(({ health, label }) => (
                        <span
                          key={health}
                          className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1"
                          style={segmentHealthBadgeStyle(health)}
                          aria-label={`${label} segments: ${segmentHealthCounts[health]}`}
                        >
                          {segmentHealthIcon(health)}
                          {label}: {segmentHealthCounts[health]}
                        </span>
                      ))}
                    </div>
                  </div>
                  {selectedLineId && (
                    <Link
                      href={`/?line=${encodeURIComponent(selectedLineId)}`}
                      className="inline-flex items-center gap-2 text-sm underline"
                      style={{ color: "var(--accent)" }}
                      aria-label="Open this line on the home map"
                    >
                      Open line on map <FiExternalLink aria-hidden="true" />
                    </Link>
                  )}
                </div>

                {worstSegments.length === 0 ? (
                  <div
                    className="mt-3 rounded-2xl border p-3 text-sm"
                    style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--foreground)" }}
                  >
                    <div className="flex items-center gap-2">
                      <FiCheckCircle aria-hidden="true" style={{ color: "var(--state-success)" }} />
                      No major segment issues detected for this line.
                    </div>
                  </div>
                ) : (
                  <ul className="mt-3 grid gap-2 md:grid-cols-2">
                    {worstSegments.map((segment) => {
                      const deviation = segment.headwayDeviationMinutes;
                      const deviationLabel =
                        deviation == null ? "—" : `${deviation >= 0 ? "+" : ""}${formatMinutes(deviation)} min`;

                      return (
                        <li
                          key={segment.segmentId}
                          className="rounded-2xl border p-3"
                          style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--foreground)" }}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-semibold">
                                {segment.fromName} <FiArrowRight aria-hidden="true" className="inline-block align-[-2px]" /> {segment.toName}
                              </p>
                              <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                                Headway: {formatMinutes(segment.headwayMinutes)} min · Δ {deviationLabel}
                              </p>
                            </div>
                            <span
                              className="shrink-0 rounded-full border px-3 py-0.5 text-xs"
                              style={segmentHealthBadgeStyle(segment.health as SegmentHealth)}
                              aria-label={`Segment health: ${segmentHealthLabel(segment.health as SegmentHealth)}`}
                            >
                              <span className="inline-flex items-center gap-1">
                                {segmentHealthIcon(segment.health as SegmentHealth)}
                                {segmentHealthLabel(segment.health as SegmentHealth)}
                              </span>
                            </span>
                          </div>
                          {selectedLineId && (
                            <div className="mt-2">
                              <Link
                                href={`/?line=${encodeURIComponent(selectedLineId)}&fromStop=${encodeURIComponent(segment.fromStopId)}&toStop=${encodeURIComponent(segment.toStopId)}&focus=segment`}
                                className="inline-flex items-center gap-2 text-xs underline"
                                style={{ color: "var(--accent)" }}
                                aria-label={`Open segment from ${segment.fromName} to ${segment.toName} on the home map`}
                              >
                                Open this segment on map <FiExternalLink aria-hidden="true" />
                              </Link>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          )}
          </section>
        </div>
      </main>
    </div>
  );
};
