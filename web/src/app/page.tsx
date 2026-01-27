"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";

const HomeShell = dynamic(() => import("@/components/home/HomeShell").then((m) => m.HomeShell), {
  ssr: false,
  loading: () => <div className="p-6 text-sm" style={{ color: "var(--muted)" }}>Loading…</div>,
});

export default function Home() {
  return (
    <Suspense fallback={<div className="p-6 text-sm" style={{ color: "var(--muted)" }}>Loading…</div>}>
      <HomeShell />
    </Suspense>
  );
}
