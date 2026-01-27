"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { fetchLineOverview, fetchStations, fetchSystemInsights, type SystemInsights } from "@/lib/api";
import type { ModeFilter } from "@/lib/modes";
import { FiAlertCircle, FiCheckCircle, FiExternalLink, FiSlash, FiXCircle } from "react-icons/fi";

type SegmentHealth = "good" | "minor_issues" | "major_issues" | "no_service";

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

const formatMinutes = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) < 1) return value.toFixed(2);
  return value.toFixed(1);
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

export const InsightsShell = () => {
  const insightsQuery = useQuery({
    queryKey: ["systemInsights"],
    queryFn: fetchSystemInsights,
    staleTime: 60_000,
  });

  const insights = useMemo<SystemInsights | null>(() => {
    const data = insightsQuery.data as unknown;
    if (!data) return null;
    if (typeof data === "object" && data !== null) {
      const maybeWrapped = data as { insights?: unknown };
      if (maybeWrapped.insights && typeof maybeWrapped.insights === "object") {
        return maybeWrapped.insights as SystemInsights;
      }
    }
    return data as SystemInsights;
  }, [insightsQuery.data]);

  const subwayStationsQuery = useQuery({
    queryKey: ["stations", "subway"],
    queryFn: () => fetchStations("subway" as ModeFilter, 900),
    staleTime: 5 * 60_000,
  });

  const busStationsQuery = useQuery({
    queryKey: ["stations", "bus"],
    queryFn: () => fetchStations("bus" as ModeFilter, 900),
    staleTime: 5 * 60_000,
  });

  const commuterRailStationsQuery = useQuery({
    queryKey: ["stations", "commuter_rail"],
    queryFn: () => fetchStations("commuter_rail" as ModeFilter, 900),
    staleTime: 5 * 60_000,
  });

  const stopNameById = useMemo(() => {
    const map = new Map<string, string>();
    const stations = [...(subwayStationsQuery.data ?? []), ...(busStationsQuery.data ?? []), ...(commuterRailStationsQuery.data ?? [])];
    stations.forEach((station) => {
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
  }, [busStationsQuery.data, commuterRailStationsQuery.data, subwayStationsQuery.data]);

  const overviewsQuery = useQuery({
    queryKey: ["systemSegmentOverviews", insights?.generatedAt],
    enabled: Boolean(insights),
    staleTime: 60_000,
    queryFn: async () => {
      const lineIds = insights!.lines.map((line) => line.lineId);
      const results = await Promise.allSettled(lineIds.map((lineId) => fetchLineOverview(lineId)));
      return results
        .map((result, index) => ({ result, lineId: lineIds[index] }))
        .filter(
          (entry): entry is { result: PromiseFulfilledResult<Awaited<ReturnType<typeof fetchLineOverview>>>; lineId: string } =>
            entry.result.status === "fulfilled",
        )
        .map((entry) => ({ lineId: entry.lineId, overview: entry.result.value }));
    },
  });

  const computedTroubleSegments = useMemo(() => {
    if (!insights) return [] as Array<{
      key: string;
      lineId: string;
      lineName: string;
      health: SegmentHealth;
      fromStopId: string;
      toStopId: string;
      fromName: string;
      toName: string;
      headwayMinutes: number | null;
      headwayDeviationMinutes: number | null;
      score: number;
    }>;

    const lineNameById = new Map(insights.lines.map((line) => [line.lineId, line.displayName]));
    const overviews = overviewsQuery.data ?? [];
    const all = overviews.flatMap(({ lineId, overview }) => {
      const lineName = lineNameById.get(lineId) ?? lineId;
      return overview.segments
        .filter((segment) => segment.health !== "good")
        .map((segment) => {
          const deviation = Math.abs(segment.headwayDeviationMinutes ?? 0);
          const score = segmentHealthRank(segment.health as SegmentHealth) * 1_000 + deviation * 10 + (segment.headwayMinutes ?? 0);
          return {
            key: `${lineId}-${segment.fromStopId}-${segment.toStopId}`,
            lineId,
            lineName,
            health: segment.health as SegmentHealth,
            fromStopId: segment.fromStopId,
            toStopId: segment.toStopId,
            fromName: stopNameById.get(segment.fromStopId) ?? segment.fromStopId,
            toName: stopNameById.get(segment.toStopId) ?? segment.toStopId,
            headwayMinutes: segment.headwayMinutes ?? null,
            headwayDeviationMinutes: segment.headwayDeviationMinutes ?? null,
            score,
          };
        });
    });

    return all.sort((a, b) => b.score - a.score).slice(0, 12);
  }, [insights, overviewsQuery.data, stopNameById]);

  const troubleCounts = useMemo(() => {
    const counts: Record<SegmentHealth, number> = {
      good: 0,
      minor_issues: 0,
      major_issues: 0,
      no_service: 0,
    };
    computedTroubleSegments.forEach((segment) => {
      counts[segment.health] += 1;
    });
    return counts;
  }, [computedTroubleSegments]);

  return (
    <div className="flex min-h-screen flex-col" style={{ background: "var(--background)", color: "var(--foreground)" }}>
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-6">
        <div>
          <p className="text-xs uppercase tracking-[0.4em] text-(--muted)">Insights</p>
          <h1 className="text-2xl font-semibold">System wide performance</h1>
          <p className="text-sm text-(--muted)">Quick look at line reliability and trouble segments.</p>
        </div>

        {insightsQuery.isLoading && <p className="text-sm text-(--muted)">Loading system insights…</p>}
        {insightsQuery.isError && (
          <p className="text-sm" style={{ color: "var(--state-danger)" }}>
            Unable to load insights. Try again shortly.
          </p>
        )}
        {insights && (
          <>
            <div
              className="rounded-3xl border p-4 shadow-inner shadow-slate-200"
              style={{ borderColor: "var(--border)", background: "var(--card)" }}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.4em] text-(--muted)">Lines overview</p>
                  <p className="mt-1 text-xs text-(--muted)">Generated {new Date(insights.generatedAt).toLocaleTimeString()}</p>
                </div>
                <Link href="/lines" className="text-sm text-(--accent) underline">
                  Browse lines
                </Link>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {Array.isArray(insights.lines) && insights.lines.length === 0 && (
                  <p className="text-sm text-(--muted)">Backend is warming up — check again in a few seconds.</p>
                )}
                {(Array.isArray(insights.lines) ? insights.lines : []).map((line) => (
                  <div
                    key={line.lineId}
                    className="flex items-center justify-between rounded-2xl border px-3 py-2 text-sm"
                    style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--foreground)" }}
                  >
                    <div>
                      <p className="font-semibold">{line.displayName}</p>
                      <p className="text-xs text-(--muted)">
                        Pain {line.painScore} · Alerts {line.activeAlerts} · Vehicles {line.activeVehicles}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Link href={`/?line=${encodeURIComponent(line.lineId)}`} className="text-xs text-(--accent) underline">
                        Open on map <FiExternalLink aria-hidden="true" className="inline-block align-[-2px]" />
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div
              className="rounded-3xl border p-4 shadow-inner shadow-slate-200"
              style={{ borderColor: "var(--border)", background: "var(--card)" }}
            >
              <p className="text-xs uppercase tracking-[0.4em] text-(--muted)">Trouble segments</p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {(
                  [
                    { health: "major_issues" as const, label: "Major" },
                    { health: "minor_issues" as const, label: "Minor" },
                    { health: "no_service" as const, label: "No service" },
                  ]
                ).map(({ health, label }) => (
                  <span
                    key={health}
                    className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1"
                    style={segmentHealthBadgeStyle(health)}
                    aria-label={`${label} trouble segments: ${troubleCounts[health]}`}
                  >
                    {segmentHealthIcon(health)}
                    {label}: {troubleCounts[health]}
                  </span>
                ))}
              </div>
              {overviewsQuery.isLoading && (
                <p className="mt-2 text-sm text-(--muted)">Computing system trouble segments…</p>
              )}
              {computedTroubleSegments.length === 0 ? (
                <p className="mt-2 text-sm text-(--muted)">No major stop-to-stop issues detected.</p>
              ) : (
                <ul className="mt-3 space-y-2 text-sm">
                  {computedTroubleSegments.map((segment) => (
                    <li
                      key={segment.key}
                      className="rounded-2xl border p-3"
                      style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--foreground)" }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold">
                            {segment.fromName} → {segment.toName}
                          </p>
                          <p className="text-xs text-(--muted)">{segment.lineName}</p>
                        </div>
                        <span
                          className="shrink-0 rounded-full border px-2.5 py-1 text-[11px]"
                          style={segmentHealthBadgeStyle(segment.health)}
                          aria-label={`Segment health: ${segmentHealthLabel(segment.health)}`}
                        >
                          <span className="inline-flex items-center gap-1">
                            {segmentHealthIcon(segment.health)}
                            {segmentHealthLabel(segment.health)}
                          </span>
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-(--muted)">
                        Headway {formatMinutes(segment.headwayMinutes)} min · deviation {formatMinutes(segment.headwayDeviationMinutes)} min
                      </p>
                      <div className="mt-2 flex items-center gap-3">
                        <Link
                          href={`/?line=${encodeURIComponent(segment.lineId)}&fromStop=${encodeURIComponent(
                            segment.fromStopId,
                          )}&toStop=${encodeURIComponent(segment.toStopId)}&focus=segment`}
                          className="text-xs text-(--accent) underline"
                          aria-label={`Open segment from ${segment.fromName} to ${segment.toName} on the home map`}
                        >
                          Open this segment on map
                        </Link>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
};
