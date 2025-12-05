"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { fetchSystemInsights } from "@/lib/api";

export const InsightsShell = () => {
  const insightsQuery = useQuery({
    queryKey: ["systemInsights"],
    queryFn: fetchSystemInsights,
    staleTime: 60_000,
  });

  const insights = insightsQuery.data;

  return (
    <div className="flex min-h-screen flex-col" style={{ background: "var(--background)", color: "var(--foreground)" }}>
      <header
        className="border-b px-6 py-4 backdrop-blur"
        style={{ borderColor: "var(--border)", background: "color-mix(in srgb, var(--background) 85%, transparent)" }}
      >
        <div className="mx-auto flex max-w-5xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.4em] text-[color:var(--muted)]">Insights</p>
            <h1 className="text-2xl font-semibold">System wide performance</h1>
            <p className="text-sm text-[color:var(--muted)]">Quick look at line reliability and trouble segments.</p>
          </div>
          <Link href="/" className="text-sm text-[color:var(--accent)] underline">
            ← Back to Home
          </Link>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-6">
        {insightsQuery.isLoading && <p className="text-sm text-[color:var(--muted)]">Loading system insights…</p>}
        {insightsQuery.isError && (
          <p className="text-sm text-rose-500">Unable to load insights. Try again shortly.</p>
        )}
        {insights && (
          <>
            <div
              className="rounded-3xl border p-4 shadow-inner shadow-slate-200"
              style={{ borderColor: "var(--border)", background: "var(--card)" }}
            >
              <p className="text-xs uppercase tracking-[0.4em] text-[color:var(--muted)]">Lines overview</p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {insights.lines.map((line) => (
                  <div
                    key={line.id}
                    className="flex items-center justify-between rounded-2xl border px-3 py-2 text-sm"
                    style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--foreground)" }}
                  >
                    <div>
                      <p className="font-semibold">{line.shortName}</p>
                      <p className="text-xs text-[color:var(--muted)] capitalize">{line.status}</p>
                    </div>
                    <span
                      className={`rounded-full border px-3 py-0.5 text-xs ${
                        line.status === "major"
                          ? "border-rose-400/60 text-rose-200"
                          : line.status === "minor"
                            ? "border-amber-400/60 text-amber-200"
                            : "border-emerald-400/60 text-emerald-200"
                      }`}
                    >
                      {line.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div
              className="rounded-3xl border p-4 shadow-inner shadow-slate-200"
              style={{ borderColor: "var(--border)", background: "var(--card)" }}
            >
              <p className="text-xs uppercase tracking-[0.4em] text-[color:var(--muted)]">Trouble segments</p>
              {insights.worstSegments.length === 0 ? (
                <p className="text-sm text-[color:var(--muted)]">No major issues reported.</p>
              ) : (
                <ul className="mt-3 space-y-2 text-sm">
                  {insights.worstSegments.map((segment) => (
                    <li
                      key={segment.segmentId}
                      className="rounded-2xl border p-3"
                      style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--foreground)" }}
                    >
                      <p className="font-semibold">
                        {segment.fromStopId} → {segment.toStopId}
                      </p>
                      <p className="text-xs text-slate-300 capitalize">Status: {segment.status}</p>
                      {segment.notes && <p className="text-xs text-slate-400">{segment.notes}</p>}
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
