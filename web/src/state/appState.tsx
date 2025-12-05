"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { ModeFilter } from "@/lib/modes";

export interface LayerToggles {
  vehicles: boolean;
  segments: boolean;
  stations: boolean;
}

export interface AppStateValue {
  selectedLineId: string | null;
  setSelectedLineId: (lineId: string | null) => void;
  selectedStopId: string | null;
  setSelectedStopId: (stopId: string | null) => void;
  isStopSheetOpen: boolean;
  setIsStopSheetOpen: (open: boolean) => void;
  modeFilter: ModeFilter;
  setModeFilter: (mode: ModeFilter) => void;
  layerToggles: LayerToggles;
  setLayerToggles: (updater: (current: LayerToggles) => LayerToggles) => void;
}

const AppStateContext = createContext<AppStateValue | undefined>(undefined);

export const AppStateProvider = ({ children }: { children: React.ReactNode }) => {
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [isStopSheetOpen, setIsStopSheetOpen] = useState(false);
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const [layerToggles, setLayerTogglesState] = useState<LayerToggles>({
    vehicles: true,
    segments: true,
    stations: true,
  });

  const setLayerToggles = (updater: (current: LayerToggles) => LayerToggles) => {
    setLayerTogglesState((prev) => updater(prev));
  };

  const value = useMemo<AppStateValue>(
    () => ({
      selectedLineId,
      setSelectedLineId,
      selectedStopId,
      setSelectedStopId,
      isStopSheetOpen,
      setIsStopSheetOpen,
      modeFilter,
      setModeFilter,
      layerToggles,
      setLayerToggles,
    }),
    [isStopSheetOpen, layerToggles, modeFilter, selectedLineId, selectedStopId],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
};

export const useAppState = (): AppStateValue => {
  const ctx = useContext(AppStateContext);
  if (!ctx) {
    throw new Error("useAppState must be used within AppStateProvider");
  }
  return ctx;
};
