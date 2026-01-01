import { LinesShell } from "@/components/lines/LinesShell";
import { Suspense } from "react";

export default function LinesPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm" style={{ color: "var(--muted)" }}>Loading…</div>}>
      <LinesShell />
    </Suspense>
  );
}
