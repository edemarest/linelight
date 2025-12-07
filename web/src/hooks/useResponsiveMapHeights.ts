"use client";

import { BreakpointInfo } from "./useBreakpoint";

const MOBILE_MAP_HEIGHT = "clamp(220px, 30vh, 320px)";

export interface UseResponsiveMapHeightsProps {
  preferStackedLayout: boolean;
  breakpointInfo: BreakpointInfo;
}

export const useResponsiveMapHeights = ({ preferStackedLayout, breakpointInfo }: UseResponsiveMapHeightsProps) => {
  const { isMobile } = breakpointInfo;

  const mapPanelHeight = preferStackedLayout
    ? isMobile
      ? MOBILE_MAP_HEIGHT
      : "460px"
    : "min(900px, calc(100vh - 220px))";

  const mobileSheetHeight = preferStackedLayout && isMobile
    ? `calc(100vh - ${MOBILE_MAP_HEIGHT} - 24px)`
    : "88vh";

  return {
    mapPanelHeight,
    mobileSheetHeight,
  };
};
