import { HomeShell } from "@/components/home/HomeShell";
import { Suspense } from "react";

export default function Home() {
  return (
    <Suspense fallback={<div className="p-6 text-sm" style={{ color: "var(--muted)" }}>Loading…</div>}>
      <HomeShell />
    </Suspense>
  );
}
