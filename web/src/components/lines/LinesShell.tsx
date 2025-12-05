"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { fetchLines, fetchLineOverview, fetchLineShapes, type LineSummary, type LineShapeResponse } from "@/lib/api";
import MapGL, { type ViewState } from "react-map-gl/maplibre";
import DeckGL from "@deck.gl/react";
import { PathLayer } from "@deck.gl/layers";
import maplibregl from "maplibre-gl";
import { envConfig } from "@/lib/config";
import type { Color } from "@deck.gl/core";

const hexToColor = (hex: string | null | undefined): Color => {
  if (!hex) return [255, 255, 255, 200];
  const normalized = hex.replace("#", "");
  const bigint = Number.parseInt(normalized, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return [r, g, b, 220];
};

export const LinesShell = () => {
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

  return (
    <div className="flex min-h-screen flex-col" style={{ background: "var(--background)", color: "var(--foreground)" }}>
      <header
        className="border-b px-6 py-4 backdrop-blur"
        style={{ borderColor: "var(--border)", background: "color-mix(in srgb, var(--background) 85%, transparent)" }}
      >
        <div className="mx-auto flex max-w-6xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.4em]" style={{ color: "var(--muted)" }}>
              Lines
            </p>
            <h1 className="text-2xl font-semibold text-white">Network health overview</h1>
            <p className="text-sm text-slate-400">Select a line to view headways, segments, and live topology.</p>
          </div>
          <Link href="/" className="text-sm text-emerald-200 underline">
            ← Back to Home
          </Link>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-6 lg:flex-row">
        <aside
          className="w-full rounded-3xl border p-4 shadow-inner shadow-slate-300 lg:w-80"
          style={{ borderColor: "var(--border)", background: "var(--card)" }}
        >
          <p className="text-xs uppercase tracking-[0.4em] text-[color:var(--muted)]">Lines</p>
          <div className="mt-3 flex flex-col gap-2">
            {linesQuery.isLoading && <p className="text-sm text-slate-400">Loading lines…</p>}
            {linesQuery.isError && (
              <p className="text-sm text-rose-400">Unable to load lines. Ensure backend is running.</p>
            )}
            {linesQuery.data?.map((line: LineSummary) => (
              <button
                key={line.id}
                type="button"
                onClick={() => setSelectedLineId(line.id)}
                className={`rounded-2xl border px-3 py-2 text-left text-sm transition ${
                  selectedLineId === line.id
                    ? "border-white/40 bg-white/10 text-white"
                    : "border-white/5 bg-black/20 text-slate-300 hover:border-white/20"
                }`}
                style={{
                  borderColor: selectedLineId === line.id ? "var(--accent)" : "var(--border)",
                  background:
                    selectedLineId === line.id ? "var(--accent-soft)" : "color-mix(in srgb, var(--surface) 85%, transparent)",
                  color: "var(--foreground)",
                }}
              >
                <p className="font-semibold">{line.shortName}</p>
                <p className="text-xs text-slate-400 capitalize">{line.status ?? "unknown"}</p>
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
                <p className="text-xs uppercase tracking-[0.4em] text-slate-400">Line detail</p>
                <h2 className="text-xl font-semibold text-white">
                  {selectedLineId ?? "Select a line"}
                </h2>
              </div>
              {lineOverviewQuery.data && (
                <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-200">
                  Headway:{" "}
                  {lineOverviewQuery.data.headwaySummary.observedHeadwayMinutes ?? "—"} min
                </span>
              )}
            </div>
            {selectedLineId && (
              <div
                className="mt-4 h-[360px] overflow-hidden rounded-2xl border"
                style={{ borderColor: "var(--border)" }}
              >
                <DeckGL
                  initialViewState={viewState}
                  controller
                  viewState={viewState}
                  onViewStateChange={(evt) => setViewState(evt.viewState as ViewState)}
                  layers={pathLayers}
                >
                  <MapGL
                    reuseMaps
                    mapLib={maplibregl}
                    mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
                  />
                </DeckGL>
                {lineShapesQuery.isLoading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-sm text-slate-200">
                    Loading geometry…
                  </div>
                )}
              </div>
            )}
            {!selectedLineId && <p className="mt-4 text-sm text-slate-400">Select a line to render its map.</p>}
          </div>
          {lineOverviewQuery.data && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div
                className="rounded-3xl border p-4 text-slate-900 shadow"
                style={{ borderColor: "var(--border)", background: "var(--card)" }}
              >
                <p className="text-xs uppercase tracking-[0.4em] text-[color:var(--muted)]">Headway summary</p>
                <div className="mt-3 flex gap-6 text-lg">
                  <div>
                    <p className="text-3xl font-semibold">
                      {lineOverviewQuery.data.headwaySummary.observedHeadwayMinutes ?? "—"}
                    </p>
                    <p className="text-xs text-slate-400">Observed</p>
                  </div>
                  <div>
                    <p className="text-3xl font-semibold">
                      {lineOverviewQuery.data.headwaySummary.typicalHeadwayMinutes ?? "—"}
                    </p>
                    <p className="text-xs text-slate-400">Typical</p>
                  </div>
                </div>
              </div>
              <div
                className="rounded-3xl border p-4 text-slate-900 shadow"
                style={{ borderColor: "var(--border)", background: "var(--card)" }}
              >
                <p className="text-xs uppercase tracking-[0.4em] text-[color:var(--muted)]">Alerts</p>
                {lineOverviewQuery.data.alerts.length === 0 ? (
                  <p className="text-sm text-slate-300">No active alerts for this line.</p>
                ) : (
                  <ul className="mt-2 space-y-2 text-sm">
                    {lineOverviewQuery.data.alerts.map((alert, idx) => {
                      const alertKey = (alert as unknown as { alertId?: string }).alertId ?? alert.id ?? idx;
                      return (
                        <li key={alertKey} className="rounded-2xl border border-white/10 bg-black/30 p-3">
                          <p className="font-semibold">{alert.header}</p>
                          <p className="text-xs text-slate-400">{alert.effect}</p>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
};
