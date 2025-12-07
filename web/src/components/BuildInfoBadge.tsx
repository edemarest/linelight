"use client";

import { useEffect, useState } from "react";

type BuildInfo = {
  commit?: string | null;
  commitDate?: string | null;
  latestChangedFile?: string | null;
  latestChangedTime?: string | null;
  generatedAt?: string | null;
};

function formatShortDate(iso?: string | null) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export const BuildInfoBadge = () => {
  const [info, setInfo] = useState<BuildInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/build-info.json", { cache: "no-store" });
        if (!res.ok) throw new Error("no build-info");
        const data = (await res.json()) as BuildInfo;
        if (!cancelled) setInfo(data);
      } catch {
        if (!cancelled) setInfo(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const now = Date.now();
  let ageMs: number | null = null;
  if (info?.latestChangedTime) {
    const t = Date.parse(info.latestChangedTime);
    if (!Number.isNaN(t)) ageMs = now - t;
  } else if (info?.commitDate) {
    const t = Date.parse(info.commitDate);
    if (!Number.isNaN(t)) ageMs = now - t;
  }

  const ageLabel = ageMs == null ? "unknown" : ageMs < 1000 * 60 ? "just now" : ageMs < 1000 * 60 * 60 ? `${Math.round(ageMs / (1000 * 60))}m` : ageMs < 1000 * 60 * 60 * 24 ? `${Math.round(ageMs / (1000 * 60 * 60))}h` : `${Math.round(ageMs / (1000 * 60 * 60 * 24))}d`;

  // color: green < 5m, amber < 24h, red otherwise
  const color = ageMs == null ? "#94a3b8" : ageMs < 5 * 60 * 1000 ? "#16a34a" : ageMs < 24 * 60 * 60 * 1000 ? "#f59e0b" : "#ef4444";

  return (
    <div style={{ position: "fixed", right: 12, bottom: 12, zIndex: 9999 }}>
      <div
        className="rounded-full px-3 py-1 text-xs font-medium shadow-lg"
        style={{
          display: "inline-flex",
          gap: 8,
          alignItems: "center",
          background: "rgba(0,0,0,0.65)",
          color: "white",
          border: `1px solid ${color}`,
        }}
        title={info?.latestChangedFile ? `${info.latestChangedFile} — ${formatShortDate(info.latestChangedTime ?? info.commitDate ?? info.generatedAt)}` : info?.commit ? `commit ${info.commit} — ${formatShortDate(info.commitDate ?? info.generatedAt)}` : "Build info not available"}
      >
        <span style={{ width: 10, height: 10, borderRadius: 10, background: color, display: "inline-block" }} />
        <span style={{ minWidth: 64, textAlign: "left" }}>Build: {info?.commit ?? "—"}</span>
        <span style={{ opacity: 0.9 }}>|</span>
        <span style={{ opacity: 0.9 }}>Updated: {ageLabel}</span>
      </div>
      {info?.latestChangedFile && (
        <div
          style={{
            marginTop: 6,
            background: "rgba(255,255,255,0.02)",
            color: "var(--muted)",
            padding: "4px 8px",
            borderRadius: 8,
            fontSize: 11,
            maxWidth: 320,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            border: "1px solid rgba(255,255,255,0.03)",
          }}
        >
          {info.latestChangedFile} • {formatShortDate(info.latestChangedTime ?? info.commitDate ?? info.generatedAt)}
        </div>
      )}
    </div>
  );
};

export default BuildInfoBadge;
