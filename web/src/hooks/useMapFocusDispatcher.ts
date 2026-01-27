// Focus queue for map camera + optional scroll syncing across UI modes.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { MapUiMode } from "@/hooks/useMapUiMode";

export type FocusPoint = { lat: number; lng: number };
export type FocusKind = "deeplink" | "trip" | "follow" | "stop" | "stop-route" | "leg" | "suggested";
export type FocusRequest = {
  id: string;
  points: FocusPoint[];
  scroll?: boolean;
  priority?: number;
  kind: FocusKind;
};

type FocusDispatcherParams = {
  mapReady: boolean;
  mapPickMode: "origin" | "destination" | null;
  mapUiMode: MapUiMode;
  mapSectionRef: RefObject<HTMLDivElement | null>;
  focusOnMapPoints: (points: FocusPoint[]) => void;
};

export const useMapFocusDispatcher = ({
  mapReady,
  mapPickMode,
  mapUiMode,
  mapSectionRef,
  focusOnMapPoints,
}: FocusDispatcherParams) => {
  const focusQueueRef = useRef<FocusRequest[]>([]);
  const lastAppliedFocusRef = useRef<string | null>(null);
  const lastScrollPositionRef = useRef<number | null>(null);
  const [tick, setTick] = useState(0);

  const requestMapFocus = useCallback((request: FocusRequest | null) => {
    if (!request) {
      focusQueueRef.current = [];
      lastAppliedFocusRef.current = null;
      if (lastScrollPositionRef.current != null) {
        window.scrollTo({ top: lastScrollPositionRef.current, behavior: "smooth" });
        lastScrollPositionRef.current = null;
      }
      setTick((prev) => prev + 1);
      return;
    }
    focusQueueRef.current = [...focusQueueRef.current, request];
    setTick((prev) => prev + 1);
  }, []);

  useEffect(() => {
    if (!mapReady) return;
    if (mapPickMode) {
      focusQueueRef.current = [];
      return;
    }
    const queue = focusQueueRef.current;
    if (queue.length === 0) return;

    const allowedKinds: FocusKind[] = (() => {
      if (mapUiMode === "FOLLOW") return ["follow"];
      if (mapUiMode === "STOP_SHEET") return ["stop", "stop-route", "deeplink"];
      if (mapUiMode === "TRIP") return ["trip", "leg", "deeplink"];
      if (mapUiMode === "HOME") return ["suggested", "deeplink"];
      return [];
    })();

    const candidates = queue.filter((request) => allowedKinds.includes(request.kind));
    if (candidates.length === 0) {
      focusQueueRef.current = [];
      return;
    }

    const winner = candidates.reduce((best, next) => {
      if (!best) return next;
      const bestPriority = best.priority ?? 1;
      const nextPriority = next.priority ?? 1;
      if (nextPriority !== bestPriority) return nextPriority > bestPriority ? next : best;
      return next;
    }, candidates[0]);

    focusQueueRef.current = [];
    if (lastAppliedFocusRef.current === winner.id) return;
    lastAppliedFocusRef.current = winner.id;
    focusOnMapPoints(winner.points);
    if (winner.scroll && mapSectionRef.current && typeof window !== "undefined") {
      if (lastScrollPositionRef.current == null) {
        lastScrollPositionRef.current = window.scrollY;
      }
      const targetTop = mapSectionRef.current.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
    }
  }, [focusOnMapPoints, mapPickMode, mapReady, mapSectionRef, mapUiMode, tick]);

  return requestMapFocus;
};
